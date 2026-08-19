import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { loadModel, loadLocalSessions, isRunning, itemKey, prKey, refreshLiveTmux, filterModelByRepos, type LoadedModel } from "../model.ts";
import { loadActivity } from "../sessions.ts";
import { openSession, launchFresh, launchNewSession, runInline, type OpenPlan } from "../launch.ts";
import { sessionName, capturePane, capturePaneState, sendResume, sendDialogReveal, paneReadiness, paneResumeSafe, paneLimitDialogActive, paneShells, paneCompactionPercent, stripAnsi } from "../tmux.ts";
import { paneResetAt, shouldAutoResume, shouldRevealDialog } from "../usageLimit.ts";
import { discoverProfiles, moveSessionToProfile, profileChoices, type ClaudeProfile } from "../profiles.ts";
import { retargetRestoreProfile } from "../restore.ts";
import { openUrl } from "../browser.ts";
import { createWorktree, checkoutWorktree, freeWorktreeBranch, worktreeDirName } from "../worktree.ts";
import { isOrchestratorSession } from "../orchestrator.ts";
import { loadState, saveState } from "../config.ts";
import { isRetryable, messageOf, retryAttempts, retryDelayMs, takeWarnings } from "../errors.ts";
import {
  discoverGitReposUnder,
  mergeRepos,
  repoRootForCwd,
  bootstrapRepoRoot,
  ensureRepoAtTop,
  isGitCheckout,
  type RepoInfo,
} from "../repos.ts";
import {
  parseRepoUrl,
  repoUrlLabel,
  cloneDirName,
  enclosingCheckout,
  findMatchingCheckout,
  freeCloneDest,
  startClone,
  type CloneRun,
} from "../clone.ts";
import { isUnderRoot, normalizeCwd } from "../context.ts";
import { vocab } from "../vocab.ts";
import { detectProviders, resolveInitialProvider, detectScopeProvider, getProvider, PROVIDER_INFO } from "../provider.ts";
import { basename } from "path";
import { homedir } from "os";
import { cloneError, homeShort, type Activity, type PaneState } from "./format.ts";
import { sameActivity, sameLiveTmux, sameLiveWindows, sameRepos, sessionGroupsSig } from "./equality.ts";
import { freeTarget, orchestratorTarget, type FreshTarget } from "./targets.ts";
import {
  buildItemsRows,
  buildPrsRows,
  buildSessionsRows,
  sessionId,
  SELECTABLE,
  type PrSort,
  type SessionSort,
} from "./rows.ts";
import {
  ActionRow,
  ColumnHeader,
  HEADERS_ITEMS,
  ITEM_WIDTHS,
  ItemRow,
  PR_WIDTHS,
  PrRow,
  prHeaders,
  SessionRow,
  TaskRow,
} from "./components.tsx";
import { convertTarget, runConvert } from "./convert.ts";
import { V, setVocab } from "./vocabState.ts";
import type { KeyContext, Mode, View } from "./keys/context.ts";
import { handleAgentKeys } from "./keys/agent.ts";
import { handleBranchKeys } from "./keys/branch.ts";
import { handleCloneKeys, handleCloningKeys } from "./keys/clone.ts";
import { handleIdentityKeys } from "./keys/identity.ts";
import { handleListKeys } from "./keys/list.ts";
import { handleOpenKeys } from "./keys/open.ts";
import { handleProfileKeys } from "./keys/profile.ts";
import { handleProviderKeys } from "./keys/provider.ts";
import { handleQuitKeys } from "./keys/quit.ts";
import { handleRepoKeys } from "./keys/repo.ts";
import { handleWtchoiceKeys } from "./keys/wtchoice.ts";
import { handleSearchKeys } from "./keys/search.ts";
import { handleSettingsKeys } from "./keys/settings.ts";
import { AgentScreen } from "./screens/AgentScreen.tsx";
import { CloneScreen } from "./screens/CloneScreen.tsx";
import { CloningScreen } from "./screens/CloningScreen.tsx";
import { IdentityScreen } from "./screens/IdentityScreen.tsx";
import { ProviderScreen } from "./screens/ProviderScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { RepoScreen } from "./screens/RepoScreen.tsx";
import type {
  AgentSession,
  AgentSource,
  Identity,
  ProviderName,
  TeamMember,
} from "../types.ts";

const POLL_MS = 1000;
const LIVE_POLL_MS = 2000; // background tmux-liveness refresh (no network)
// How often to re-read running sessions' panes for input readiness. Each tick
// captures one pane per running session (cheap tmux calls), so keep it modest.
const READINESS_MS = 1500;

// ── main app ──────────────────────────────────────────────────────────────────
/**
 * `filterRoot` scopes the launcher to sessions under a path (null = the global
 * launcher, bare `agendo`). `hostSession` is the tmux host session the menu runs
 * in — passed to loadModel so restore snapshots the right session's tabs. The
 * `a` key toggles the runtime scoped↔global view (see `globalView`).
 */
export default function App({
  onOpen,
  filterRoot = null,
  hostSession,
}: {
  onOpen: (plan: OpenPlan) => void;
  filterRoot?: string | null;
  hostSession?: string;
}) {
  const { exit } = useApp();
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set while a failed load is waiting to try again: which attempt just failed,
  // out of how many, when the next one fires, and why the last one didn't.
  const [retrying, setRetrying] = useState<{
    attempt: number;
    attempts: number;
    resumeAt: number;
    reason: string;
    /** True while counting down; false once the next attempt is actually in
     *  flight — otherwise the screen would sit on "retrying in 0s" for the whole
     *  duration of a load, which is the frozen screen this feature replaces. */
    waiting: boolean;
  } | null>(null);
  // Bumped by a timer purely to re-render the retry countdown (see below).
  const [, setRetryTick] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toggles, setToggles] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>("items");
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // Mirrors `notice` so the async load can tell whether a message landed while
  // it was in flight, without re-arming on every notice change.
  const noticeRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // Repos cloned during this run, merged into the picker until a reload
  // discovers them for real (see `scopedRepos`).
  const [cloned, setCloned] = useState<RepoInfo[]>([]);
  // What the clone step did, carried into the screens that follow it. `notice`
  // is a list-view banner, and a clone hands off directly to the next dialog —
  // without this, "reused the checkout you already had" would be invisible until
  // the user found their way back to the list. Cleared when a fresh flow starts.
  const [cloneNote, setCloneNote] = useState<string | null>(null);
  // The same value, readable synchronously. A PR target routes clone → checkout
  // → launch inside one keystroke, and `open()` overwrites the notice on the way
  // out; without a ref the note set moments earlier would still be the stale
  // render value there, so the PR flow would never report what it cloned.
  const cloneNoteRef = useRef<string | null>(null);
  // The in-flight `git clone`, so esc can cancel it and unmount can't orphan it.
  const cloneRun = useRef<CloneRun | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [grouped, setGrouped] = useState(true); // Sessions view: group by repo
  // Path-scope toggle: when a filterRoot exists, `a` flips between the scoped
  // view (sessions under the root) and the global view (every session). Bare
  // `agendo` has no root, so it's always effectively global.
  const [globalView, setGlobalView] = useState(false);
  // Repo-scope toggle: with a filterRoot, `f` flips whether the work-item and PR
  // views are narrowed to the repos found inside it. On by default when scoped
  // (that's what asking for a path means); not persisted, like globalView.
  const [repoFilterOn, setRepoFilterOn] = useState<boolean>(!!filterRoot);
  const [prsGrouped, setPrsGrouped] = useState(false); // PRs view: repo subgroups
  const [prSort, setPrSort] = useState<PrSort>("created"); // PRs view: sort order
  const [sessionSort, setSessionSort] = useState<SessionSort>("updated"); // Sessions view: sort order
  // Fuzzy search (works on every list view: sessions, PRs, work items).
  // `searchFocus` is the three-state mode:
  //   null    — not searching
  //   "input" — the text box is focused; keystrokes edit the query
  //   "list"  — a query is active but the results list is focused for navigation
  // `search` holds the query text plus a caret position for in-place editing.
  const [searchFocus, setSearchFocus] = useState<"input" | "list" | null>(null);
  const [search, setSearch] = useState<{ text: string; cursor: number }>({ text: "", cursor: 0 });
  const [activity, setActivity] = useState<Map<string, Activity>>(new Map());
  // Live pane snapshot (input readiness + background-shell count) per running
  // session, by canonical name. Polled on a short timer independent of the
  // ADO-backed model reload.
  const [panes, setPanes] = useState<Map<string, PaneState>>(new Map());
  // Auto-resume a session once its usage-limit window reopens (default OFF,
  // toggled on the Settings page). Persisted in LauncherState.
  const [autoResume, setAutoResume] = useState<boolean>(() => loadState().autoResumeOnUsageLimit ?? false);
  // Which backend the launcher talks to. Resolved from the persisted choice if
  // its CLI is still installed, else the first installed one (see provider.ts).
  // `available` is probed once at mount and drives the provider picker.
  const [available] = useState<Set<ProviderName>>(() => detectProviders());
  // The git repos inside the path context, found by walking it downward (the
  // target itself when it's a checkout, else every repo nested under it). It
  // picks the backend, widens the fetch scope and yields the model's repoScope,
  // so it must NOT depend on the `f` toggle — that stays a pure display filter.
  // Scanned once per root and process-cached; `r` bumps `rescanKey` to walk the
  // tree again, so a repo cloned into the target after launch joins the scope
  // (the background poll keeps the cached result — only an explicit refresh pays
  // for a rescan).
  const [rescanKey, setRescanKey] = useState(0);
  const discoveredRepos = useMemo<RepoInfo[]>(
    () => (filterRoot ? discoverGitReposUnder(filterRoot, rescanKey > 0) : []),
    [filterRoot, rescanKey],
  );
  // When scoped to a path context, the tracker its git remote points at — or the
  // remotes of the repos inside it, when the target is a plain parent folder —
  // forces that backend, overriding the persisted default (which may be the other
  // one, and would then filter against repo keys it can never match). Bare
  // launchers (no filterRoot) never force — they keep the persisted choice.
  const [provider, setProvider] = useState<ProviderName>(() =>
    resolveInitialProvider(
      loadState().provider,
      filterRoot ? detectScopeProvider(filterRoot, discoveredRepos) : null,
    ),
  );
  // Per-backend auth status for the Settings page: absent ⇒ not yet probed,
  // "checking" ⇒ probe in flight, boolean ⇒ result. Refreshed each time the
  // Settings page opens (auth can change out from under us between opens).
  const [authStatus, setAuthStatus] = useState<Map<ProviderName, "checking" | boolean>>(new Map());
  // Persisted "who am I / filter" state (Work items & PRs views only).
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const s = loadState();
    return s.identityId
      ? { id: s.identityId, displayName: s.identityName ?? "?", uniqueName: s.identityUniqueName ?? "" }
      : null;
  });
  const [reloadKey, setReloadKey] = useState(0);
  const { stdout } = useStdout();

  // Reload whenever the backend, identity, or a manual refresh changes.
  //
  // A failed load retries itself with bounded exponential backoff instead of
  // parking on the "Press r to retry" screen, which needs a human — an
  // unattended launcher would sit there dead. Two guard rails matter more than
  // the happy path:
  //   • only failures `isRetryable` recognises as transient are retried at all,
  //     so a permanent one (a 404 from a team with no sprints, an expired
  //     login) still stops on the first attempt rather than looping forever;
  //   • the retry count is capped, after which the error is shown as before.
  // Attempts are strictly sequential and each is a whole `loadModel`, so the
  // per-load cache invalidation (Provider.beginLoad) still runs exactly once
  // per attempt and nothing is fetched concurrently.
  useEffect(() => {
    setError(null);
    setModel(null);
    setRetrying(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Resolves the backoff wait early. Cleanup calls it so a cancelled loop
    // *resumes* and exits on its `cancelled` check, rather than being left
    // suspended forever on a timer that was cleared out from under it.
    let wake: (() => void) | undefined;

    (async () => {
      const attempts = retryAttempts();
      for (let attempt = 1; !cancelled; attempt++) {
        try {
          const m = await loadModel({ provider, identity, hostSession, scopeRepos: discoveredRepos });
          if (cancelled) return;
          setModel(m);
          setRetrying(null);
          // Surface anything reported-and-ignored (a corrupt state file, an
          // unparseable transcript record) rather than losing it silently — but
          // only into an EMPTY notice slot. `open()` sets a notice and then
          // reloads, so writing unconditionally here would wipe the message the
          // user is meant to read. Not draining when we can't show means the
          // diagnostic waits for the next load instead of being thrown away.
          // Only the first couple, summarised: the notice is one line of chrome,
          // not a log — several bad files would wrap over the list.
          if (!noticeRef.current) {
            const warnings = takeWarnings();
            if (warnings.length) {
              const shown = warnings.slice(0, 2);
              if (warnings.length > shown.length) shown.push(`+${warnings.length - shown.length} more`);
              setNotice(shown.join(" · "));
            }
          }
          return;
        } catch (e) {
          if (cancelled) return;
          const reason = messageOf(e);
          if (!isRetryable(e) || attempt >= attempts) {
            setRetrying(null);
            setError(reason);
            return;
          }
          const delay = retryDelayMs(attempt);
          setRetrying({ attempt, attempts, resumeAt: Date.now() + delay, reason, waiting: true });
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, delay);
          });
          if (cancelled) return;
          // The wait is over — flip to "retrying now" so the next attempt shows
          // as in-flight rather than as a countdown stuck at zero.
          setRetrying((r) => (r ? { ...r, waiting: false } : r));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }, [provider, identity, reloadKey, discoveredRepos]);

  // Tick twice a second while a retry is counting down, so the countdown on the
  // retry screen actually counts down instead of freezing on its first value.
  useEffect(() => {
    if (!retrying?.waiting) return;
    const t = setInterval(() => setRetryTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [retrying]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  // Probe each backend's auth status whenever the Settings page opens. Not-
  // installed backends resolve to false immediately (no CLI to ask); installed
  // ones show "checking" until their async probe lands.
  useEffect(() => {
    if (mode.kind !== "settings") return;
    let cancelled = false;
    for (const info of PROVIDER_INFO) {
      if (!available.has(info.name)) {
        setAuthStatus((m) => new Map(m).set(info.name, false));
        continue;
      }
      setAuthStatus((m) => new Map(m).set(info.name, "checking"));
      getProvider(info.name)
        .checkAuth()
        .then((ok) => !cancelled && setAuthStatus((m) => new Map(m).set(info.name, ok)))
        .catch(() => !cancelled && setAuthStatus((m) => new Map(m).set(info.name, false)));
    }
    return () => {
      cancelled = true;
    };
  }, [mode.kind]); // eslint-disable-line react-hooks/exhaustive-deps -- probe-on-open, not a subscription: keyed to entering the Settings page. Adding `available` re-probes every backend each time that map is rebuilt.

  const persist = (next: { provider?: ProviderName; identity?: Identity | null; autoResume?: boolean }) => {
    const p = next.provider !== undefined ? next.provider : provider;
    const id = next.identity !== undefined ? next.identity : identity;
    const ar = next.autoResume !== undefined ? next.autoResume : autoResume;
    saveState({
      provider: p,
      identityId: id?.id,
      identityName: id?.displayName,
      identityUniqueName: id?.uniqueName,
      autoResumeOnUsageLimit: ar,
    });
  };

  // Re-run the data load (bumping the key the load effect depends on). Used by
  // the inline `open` (to refresh running badges) and the `r` refresh key.
  const reload = () => setReloadKey((k) => k + 1);

  // Lazily parse a session's recent activity the first time it's expanded, then
  // cache it (keyed by session identity). A ref dedupes in-flight requests so
  // it's safe to call on every expand/collapse — it fetches each session once.
  const requested = useRef<Set<string>>(new Set());
  // Live-poll timers: one setInterval per expanded session identity.
  const watchers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  // Mirror `model` into a ref so the mount-only liveness interval reads the
  // current sessions without a stale closure and without re-arming the timer.
  const modelRef = useRef<LoadedModel | null>(null);
  // Mirror the setting into a ref so the readiness poll's interval closure reads
  // the current value without re-arming the timer.
  const autoResumeRef = useRef(autoResume);
  useEffect(() => { autoResumeRef.current = autoResume; }, [autoResume]);
  // Same, for the path context's repos — an `r` rescan can replace them.
  const discoveredReposRef = useRef(discoveredRepos);
  useEffect(() => { discoveredReposRef.current = discoveredRepos; }, [discoveredRepos]);
  // Per-limited-session bookkeeping for auto-resume, keyed by canonical name:
  //   • limitWindows — the frozen reset instant for the current limit window
  //     (null when no reset time was parseable, so we know not to auto-resume);
  //   • resumeFired  — the reset instant we've already sent `continue` for, so a
  //     single window fires at most once.
  //   • dialogRevealed — canonical names we've already sent the one reveal Escape
  //     to (the numbered dialog hides its reset time; one Escape reveals it). Kept
  //     SEPARATE from resumeFired so the reveal can't be confused with the later
  //     Escape→continue→Enter resume, and so a reset time that never appears just
  //     parks (no repeat Escape). All three are cleared when a session leaves the
  //     limited state, so its next limit window starts fresh.
  const limitWindows = useRef<Map<string, number | null>>(new Map());
  const resumeFired = useRef<Map<string, number>>(new Map());
  const dialogRevealed = useRef<Set<string>>(new Set());
  const ensureActivity = (s: AgentSession) => {
    const id = sessionId(s);
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setActivity((p) => new Map(p).set(id, "loading"));
    loadActivity(s)
      .then((a) => setActivity((p) => new Map(p).set(id, a)))
      .catch(() => setActivity((p) => new Map(p).set(id, "error")));
  };

  // Point the render helpers at the right provider vocabulary before anything
  // builds rows or renders chrome this pass (see `V` in ./vocabState.ts).
  if (model) setVocab(vocab(model.provider));

  // The actionable rows of the Settings page, in display order. Kept in one
  // place so the input handler (cursor / enter) and the renderer stay in lockstep.
  const settingsItems: Array<"provider" | "identity" | "autoResume"> = ["provider", "identity", "autoResume"];
  const providerLabel = PROVIDER_INFO.find((p) => p.name === provider)?.label ?? provider;

  // Whether the path filter is active right now (a root exists and the global
  // toggle is off), and the predicate that decides if a session cwd is in scope.
  // Applied as a pure display overlay — tmux reconciliation stays global, so
  // window→session attribution is never gated by the filter.
  const scoped = !!filterRoot && !globalView;
  const inScope = useMemo<(cwd: string) => boolean>(
    () => (scoped ? (cwd: string) => isUnderRoot(cwd, filterRoot!) : () => true),
    [scoped, filterRoot],
  );
  // Repos offered by the fresh-session picker, scoped the same way: a repo is in
  // scope if its root is under the filter root (parent-folder case) or the filter
  // root is under it (inside-a-repo case).
  // Repos cloned this run are offered immediately. A reload only discovers a
  // repo once a session has actually run in it, so without this, backing out of
  // the post-clone flow with esc would hide the clone the user just waited for.
  // Applied in BOTH views: toggling `a` to global must not make a fresh clone
  // disappear either.
  const withCloned = (repos: RepoInfo[]) => [
    ...repos,
    ...cloned.filter((c) => !repos.some((r) => normalizeCwd(r.root) === normalizeCwd(c.root))),
  ];
  const scopedRepos = useMemo<RepoInfo[]>(() => {
    if (!model) return [];
    if (!scoped) {
      if (model.repos.length > 0) return withCloned(model.repos);
      // Bootstrap: the unscoped list is derived ENTIRELY from where past sessions
      // ran, so a fresh install (no sessions anywhere — a new machine, or a first
      // WSL setup whose Claude history lives on the Windows side) has nothing to
      // offer and the picker dead-ends. That locks the user out for good: the only
      // way a repo enters the list is by already having a session in it.
      // Fall back to where the launcher was started — its enclosing checkout, or
      // the directory itself when it isn't one — which is the one place we know
      // the user is standing in. `filterRoot` wins when there is one (only
      // reachable with `a` toggled to the global view, where the scoped folder is
      // still the better guess than an unrelated cwd), and goes through
      // `repoRootForCwd` directly: an explicit path IS intent, so its walk-up
      // needs none of `bootstrapRepoRoot`'s guard against climbing into $HOME.
      // Deliberately ONLY when the list is empty: an install with sessions keeps
      // its session-count ranking exactly as before.
      return withCloned(
        ensureRepoAtTop([], filterRoot ? repoRootForCwd(filterRoot) : bootstrapRepoRoot(process.cwd())),
      );
    }
    const inScopeRepos = withCloned(
      model.repos.filter((r) => isUnderRoot(r.root, filterRoot!) || isUnderRoot(filterRoot!, r.root)),
    );
    // Always offer the scoped folder itself, ranked FIRST — above child repos
    // that already have sessions. Scoping to a folder is a statement that the
    // folder is what you're working on, so a new session there is the "supervise
    // this whole scope" entry point: `agendo ~/git` → a new session in ~/git
    // supervises the agendo sessions running in ~/git/*. That intent outranks any
    // individual child repo, so it takes cursor 0.
    // "Supervise" here is informal, and is NOT the formal orchestrator mode (the
    // `O` key / `--orchestrator`): that one integrates by merging branches, so it
    // needs a real checkout and is routed to `worktreeRepos` instead — see
    // `reposForTarget`, which excludes it from this ranking on purpose.
    // The folder needn't be a git checkout — a bare parent like ~/git is a
    // legitimate place to run a session via the run-in-place path (see the
    // wtchoice default, which steers non-repos there).
    // Resolved through repoRootForCwd so scoping INSIDE a checkout still offers
    // the repo root, and worktrees land at the root rather than a subdir.
    return ensureRepoAtTop(inScopeRepos, repoRootForCwd(filterRoot!));
  }, [model, scoped, filterRoot, cloned]);

  // The same list, reordered for targets that MUST create a worktree. Work-item
  // ("new") and PR flows structurally cannot run in place — `pr` goes straight
  // to startCheckout, `new` launches with `worktree: true` — so a scoped folder
  // that isn't a git checkout can only ever produce "fatal: not a git
  // repository" for them. A plain free session has no such constraint (running in
  // place IS the supervise-this-scope entry point), which is why it keeps the
  // scoped folder first unconditionally. An ORCHESTRATOR target is free-kind but
  // uses this list too: it squash-merges into a main branch, so a non-checkout is
  // just as useless to it as to a work item (see `reposForTarget`).
  // Demoted below every hostable repo, not dropped: still selectable for someone
  // who knows they're about to `git init`, just never the enter-key default.
  const worktreeRepos = useMemo<RepoInfo[]>(() => {
    // Scoped only. The unscoped ranking is pre-existing behavior this PR leaves
    // alone: bare `agendo` can still default to a folder that can't host a
    // worktree (a plain folder accumulates sessions and out-counts every real
    // repo), but that predates the scoped picker and fixing it is a separate
    // change. Confining the reorder here keeps this PR to the scope it claims.
    if (!scoped) return scopedRepos;
    // The ONLY question is whether a root can host a worktree, so ask exactly
    // that — of EVERY entry, not just the head. Session count says nothing about
    // repo-ness in either direction: repoRootForCwd falls back to the raw cwd
    // when its walk-up finds no `.git`, so a session run in a plain folder yields
    // a discovered entry with a real count — precisely what the orchestrator
    // session in ~/git creates. A plain folder can therefore outrank a real
    // checkout mid-list, so checking only index 0 would just hand cursor 0 to the
    // next unhostable entry.
    // Stable partition, so hostable repos keep their session-count ranking among
    // themselves and the rest keep theirs.
    const hostable: RepoInfo[] = [];
    const rest: RepoInfo[] = [];
    for (const r of scopedRepos) (isGitCheckout(r.root) ? hostable : rest).push(r);
    // Nothing to demote (or nowhere to demote it to) — keep the array identity.
    return rest.length === 0 || hostable.length === 0 ? scopedRepos : [...hostable, ...rest];
  }, [scoped, scopedRepos]);
  /**
   * Repo choices for a fresh-session target — see `worktreeRepos` for why they
   * differ by kind. An orchestrator is a `free` target but needs the worktree
   * ranking anyway: `scopedRepos` deliberately puts a NON-git scoped folder
   * first, and an orchestrator must land in a real checkout — that's where it
   * does its integration merges, and where a worktree could be cut for it.
   */
  const reposForTarget = (target: FreshTarget): RepoInfo[] =>
    target.kind === "free" && !target.orchestrator ? scopedRepos : worktreeRepos;
  // Whether ANY offered repo can host a worktree — what the work-item / PR
  // picker warns about when none can. Memoized on the list it asks about
  // (`worktreeRepos` is exactly what `reposForTarget` answers for every target
  // except a plain free session): every `isGitCheckout` is an `existsSync`, and
  // the picker re-renders on each cursor keystroke, so asking per render would
  // stat the whole list per keypress.
  const anyHostableRepo = useMemo(() => worktreeRepos.some((r) => isGitCheckout(r.root)), [worktreeRepos]);

  // Elapsed-seconds ticker for the clone screen. `git clone --progress` is
  // chatty once it's transferring, but silent while it resolves DNS, completes
  // the TLS handshake and waits for the server to enumerate objects — on a large
  // repo that's long enough to read as a frozen UI. A second-hand that always
  // moves is the cheapest possible proof that it hasn't.
  const cloning = mode.kind === "cloning";
  useEffect(() => {
    if (!cloning) return;
    const t = setInterval(() => {
      setMode((p) => (p.kind === "cloning" ? { ...p, elapsed: p.elapsed + 1 } : p));
    }, 1000);
    return () => clearInterval(t);
  }, [cloning]);

  // Never leave a `git clone` (and its half-written directory) behind on
  // unmount. `immediate` because the child's exit will never be observed here.
  useEffect(() => () => cloneRun.current?.cancel({ immediate: true }), []);

  // What the typed URL means. Two halves, split by cost: parsing is pure string
  // work and belongs in render, but resolving *where it would land* reads the
  // filesystem — an `origin` per sibling checkout (spawned git), a stat per
  // candidate directory. In a folder holding dozens of checkouts that is long
  // enough to see, so it runs in an effect and lands as state: the identity
  // appears the instant you type, the destination a beat later, and the render
  // path never blocks.
  const cloneValue = mode.kind === "clone" ? mode.value : null;
  const cloneUrl = useMemo(
    () => (cloneValue?.trim() ? parseRepoUrl(cloneValue) : null),
    [cloneValue],
  );
  const [cloneDest, setCloneDest] = useState<{ key: string; match: string | null; dest: string | null } | null>(null);
  useEffect(() => {
    // Clearing on the way out matters: leaving the resolution behind would let a
    // later visit to the prompt match it by key and show a pre-clone answer
    // ("clones into …" for a repo that is now on disk) until the effect caught up.
    if (!cloneUrl || !filterRoot) {
      setCloneDest(null);
      return;
    }
    const match = findMatchingCheckout(filterRoot, cloneUrl.key);
    setCloneDest({
      key: cloneUrl.key,
      match,
      dest: match ? null : freeCloneDest(filterRoot, cloneDirName(cloneUrl.repo)),
    });
  }, [cloneUrl, filterRoot]);
  // Only trust a resolution that belongs to the URL currently on screen — the
  // previous one is about a different repo, and a stale destination is worse
  // than none.
  const resolved = cloneUrl && cloneDest?.key === cloneUrl.key ? cloneDest : null;

  // Whether the repo filter is doing anything right now: it needs a path context
  // with at least one repo inside it (model.repoScope is null otherwise) and the
  // `f` toggle on. Applied as a display overlay over the loaded model, so the
  // fetched data — and every count derived from it — narrows in one place.
  const repoFiltered = !!model?.repoScope && repoFilterOn;
  const viewModel = useMemo<LoadedModel | null>(
    () => (model ? filterModelByRepos(model, repoFiltered ? model.repoScope : null) : null),
    [model, repoFiltered],
  );

  const rows = useMemo(() => {
    if (!viewModel) return [];
    if (view === "prs") return buildPrsRows(viewModel, expanded, toggles, prsGrouped, prSort, activity, search.text, inScope);
    if (view === "sessions") return buildSessionsRows(viewModel, toggles, grouped, expanded, activity, sessionSort, search.text, inScope);
    return buildItemsRows(viewModel, expanded, toggles, activity, search.text, inScope);
  }, [viewModel, view, expanded, toggles, grouped, prsGrouped, prSort, sessionSort, activity, search.text, inScope]);
  const selectableIdx = useMemo(
    () => rows.map((r, i) => (SELECTABLE.has(r.kind) ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  // The identity-switcher roster: the team's members, with the authenticated
  // user guaranteed present (in case they aren't on the configured team).
  const roster = useMemo<TeamMember[]>(() => {
    if (!model) return [];
    const list = [...model.teamMembers];
    if (!list.some((m) => m.id === model.me.id)) list.unshift(model.me);
    return list;
  }, [model]);

  useEffect(() => {
    if (selectableIdx.length === 0) return;
    if (!selectableIdx.includes(cursor)) setCursor(selectableIdx[0]);
  }, [selectableIdx, cursor]);

  // Derive the set of session identities that are currently expanded (and have a
  // log to poll), plus a lookup map and a stable string key for the effect dep.
  const openSessionInfo = useMemo(() => {
    const ids = new Set<string>();
    const lookup = new Map<string, AgentSession>();
    for (const r of rows) {
      if (r.kind === "session" && r.expanded && r.session.logPath) {
        const id = sessionId(r.session);
        ids.add(id);
        lookup.set(id, r.session);
      }
    }
    const key = [...ids].sort().join(",");
    return { openSessionIds: ids, sessionLookup: lookup, key };
  }, [rows]);

  // Reconcile live-poll timers whenever the set of open sessions changes.
  useEffect(() => {
    const { openSessionIds, sessionLookup } = openSessionInfo;
    // Start a timer for each newly-opened session.
    for (const id of openSessionIds) {
      if (watchers.current.has(id)) continue;
      const s = sessionLookup.get(id);
      if (!s) continue;
      const handle = setInterval(async () => {
        if (inFlight.current.has(id)) return;
        inFlight.current.add(id);
        try {
          const a = await loadActivity(s);
          if (!watchers.current.has(id)) return; // timer cleared mid-read
          setActivity((p) => {
            const prev = p.get(id);
            if (sameActivity(prev, a)) return p;
            const next = new Map(p);
            next.set(id, a);
            return next;
          });
        } catch {
          // leave last good data on error
        } finally {
          inFlight.current.delete(id);
        }
      }, POLL_MS);
      watchers.current.set(id, handle);
    }
    // Clear timers for sessions that are no longer open.
    for (const id of watchers.current.keys()) {
      if (!openSessionIds.has(id)) {
        clearInterval(watchers.current.get(id));
        watchers.current.delete(id);
      }
    }
  }, [openSessionInfo.key]); // eslint-disable-line react-hooks/exhaustive-deps -- `.key` is the sorted id digest built above precisely so this reconciles timers when the id SET changes; the object itself changes on every `rows` recompute, which would tear down live timers.

  // Leak-proof teardown: clear all timers when the component unmounts.
  useEffect(() => {
    return () => {
      for (const t of watchers.current.values()) clearInterval(t);
      watchers.current.clear();
    };
  }, []);

  // Background LOCAL rescan every LIVE_POLL_MS: re-run the cheap, network-free
  // session scan (loadLocalSessions → SessionIndex.build + discoverRepos +
  // refreshLiveTmux) and merge its fresh session groups / repos / live-tmux state
  // into the model the app already has. This is what makes a session started
  // AFTER the last full `loadModel` appear in the list — and, critically, puts its
  // window into `liveWindows` — without a manual `r`, so the readiness poll and
  // #8 auto-resume can act on it. The SLOW backend fetch (work items / PRs / team)
  // stays on the `r` / provider-change cadence; nothing here touches the network.
  // Mount-only: reads `model` via modelRef; merges via setModel so the
  // network-derived fields (items, PRs, teamMembers, sessionLinks) are preserved.
  // `discoveredRepos` is read through a ref: an `r` rescan can replace it, and a
  // mount-only interval closing over the old array would drop a just-cloned repo
  // back out of the fresh-session picker on the next tick.
  useEffect(() => {
    let inFlight = false; // a slow disk scan must not overlap the next tick
    const handle = setInterval(async () => {
      if (inFlight || !modelRef.current) return; // no full model yet, or busy
      inFlight = true;
      try {
        const local = await loadLocalSessions();
        setModel((prev) => {
          if (!prev) return prev;
          // The rescan's repos are session-derived only, so re-apply the same
          // merge loadModel does — otherwise a path-discovered repo that has
          // never hosted a session would drop out of the fresh-session picker a
          // tick after every load.
          const repos = mergeRepos(local.repos, discoveredReposRef.current);
          // Only re-render when something the list / readiness effect cares about
          // actually changed — an unchanged local scan is a no-op, so a stable
          // limited session doesn't thrash the readiness effect (which re-arms on
          // every `model` change and would otherwise re-sample constantly).
          const unchanged =
            sessionGroupsSig(prev.sessionGroups) === sessionGroupsSig(local.sessionGroups) &&
            sameLiveTmux(prev.liveTmux, local.live) &&
            sameLiveTmux(prev.livePlaceholders, local.livePlaceholders) &&
            sameLiveWindows(prev.liveWindows, local.liveWindows) &&
            sameRepos(prev.repos, repos);
          if (unchanged) return prev;
          // Merge the fresh LOCAL half; keep the NETWORK half from the last full
          // load. NB: item.sessions / pr.sessions were associated against the OLD
          // index, so a brand-new session's backlink to an item/PR lags until the
          // next full `r` — acceptable for v1 (the session itself still appears and
          // is live-polled). We deliberately DON'T touch limitWindows/resumeFired/
          // dialogRevealed here: a rescan must never reset a frozen reset instant
          // or the fire-once guard, or auto-resume could re-fire `continue`.
          return {
            ...prev,
            sessionGroups: local.sessionGroups,
            repos,
            liveTmux: local.live,
            liveKinds: local.liveKinds,
            liveWindows: local.liveWindows,
            livePlaceholders: local.livePlaceholders,
          };
        });
      } catch {
        // Leave the last good model in place on a transient scan error.
      } finally {
        inFlight = false;
      }
    }, LIVE_POLL_MS);
    return () => clearInterval(handle);
  }, []);

  // Poll input readiness for every running session by reading its tmux pane.
  // Re-armed whenever the model reloads (the live-window set may have changed);
  // captures are synchronous and only over running sessions, so no overlap.
  useEffect(() => {
    const windows = model?.liveWindows;
    if (!windows || windows.size === 0) {
      setPanes((p) => (p.size === 0 ? p : new Map()));
      // No live windows to attribute to — drop all auto-resume bookkeeping so a
      // relaunched session can't inherit a stale (possibly past) reset instant.
      limitWindows.current.clear();
      resumeFired.current.clear();
      dialogRevealed.current.clear();
      return;
    }
    const sample = () => {
      // Capture each pane once (outside the state updater, which must stay pure)
      // and derive readiness, shell count, and — when limited — the reset time
      // from the same snapshot. Auto-resume is folded in here so it rides the
      // same cadence and the same fresh capture.
      const next = new Map<string, PaneState>();
      for (const [canon, win] of windows) {
        const { raw, cursor } = capturePaneState(win);
        const readiness = paneReadiness(raw, cursor);
        let resetAt: number | null | undefined;
        if (readiness === "limited") {
          // Freeze the reset instant on first *successful* parse of this limit
          // window: a bare "3pm" parses as the next 3pm, which would jump to
          // tomorrow the moment the clock passes it — freezing keeps a stable
          // target to fire on. Re-parse while still null (a first capture can
          // race the TUI paint and miss the reset line) so a transient miss
          // doesn't permanently disable auto-resume for the window.
          const frozen = limitWindows.current.get(canon);
          if (frozen != null) resetAt = frozen;
          else {
            resetAt = paneResetAt(stripAnsi(raw));
            limitWindows.current.set(canon, resetAt ?? null);
          }
          // Auto-resume: once the frozen reset has passed (plus grace) and we
          // haven't already fired for it, re-verify the pane is STILL safely
          // limited — empty input box, no open dialog (guarding the sample→act
          // gap and never clobbering a draft/dialog) — then send `continue`.
          if (autoResumeRef.current) {
            const fired = resumeFired.current.get(canon) ?? null;
            if (shouldAutoResume({ enabled: true, readiness, resetAt: resetAt ?? null, now: Date.now(), firedFor: fired })) {
              const fresh = capturePaneState(win);
              if (paneResumeSafe(fresh.raw, fresh.cursor)) {
                sendResume(win);
                resumeFired.current.set(canon, resetAt as number); // non-null per shouldAutoResume
              }
            } else if (
              // No reset time yet AND we're parked in the numbered dialog (which
              // hides it): send ONE Escape to reveal the "resets <time>" notice, so
              // the NEXT poll can parse+freeze it and shouldAutoResume can fire.
              // Never sends `continue` this tick — just reveals.
              shouldRevealDialog({
                enabled: true,
                readiness,
                dialogActive: paneLimitDialogActive(raw),
                resetAt: resetAt ?? null,
                revealed: dialogRevealed.current.has(canon),
              })
            ) {
              // Re-capture fresh to guard the sample→act gap, and confirm it's STILL
              // the active dialog before pressing Escape (only ever Escape a pane
              // whose own "Esc to cancel" affordance is showing).
              if (paneLimitDialogActive(capturePane(win))) {
                sendDialogReveal(win);
                dialogRevealed.current.add(canon);
              }
            }
          }
        } else if (readiness !== "busy" && readiness !== "unknown") {
          // Definitively recovered (ready / queued / dialog / compacting): drop
          // the frozen window + fire record so a *future* limit window starts
          // fresh. We deliberately keep them through "busy" (the generation our
          // own `continue` kicks off) and "unknown" (a transient blank capture),
          // so a single flicker can't wipe the fire-once guard and re-fire.
          limitWindows.current.delete(canon);
          resumeFired.current.delete(canon);
          dialogRevealed.current.delete(canon);
        }
        next.set(canon, {
          readiness,
          shells: paneShells(raw),
          resetAt,
          // Read from the same snapshot as the readiness it belongs to, so the
          // percent shown can never be a different frame's than the state word.
          compactionPercent: readiness === "compacting" ? paneCompactionPercent(raw) : null,
        });
      }
      // A window that vanished between reloads leaves stale bookkeeping; prune it.
      for (const canon of limitWindows.current.keys()) if (!windows.has(canon)) limitWindows.current.delete(canon);
      for (const canon of resumeFired.current.keys()) if (!windows.has(canon)) resumeFired.current.delete(canon);
      for (const canon of dialogRevealed.current) if (!windows.has(canon)) dialogRevealed.current.delete(canon);
      setPanes((prev) => {
        const same =
          prev.size === next.size &&
          [...next].every(
            ([k, v]) =>
              prev.get(k)?.readiness === v.readiness &&
              prev.get(k)?.shells === v.shells &&
              prev.get(k)?.resetAt === v.resetAt &&
              // Load-bearing: without it the map is judged "same" for the whole
              // compaction and the percent freezes at whatever the first poll saw.
              prev.get(k)?.compactionPercent === v.compactionPercent,
          );
        return same ? prev : next;
      });
    };
    sample(); // paint without waiting a full interval
    const handle = setInterval(sample, READINESS_MS);
    return () => clearInterval(handle);
  }, [model]);

  // ── viewport windowing ──
  // Render only a slice of rows so the list never overflows the terminal (which
  // breaks Ink's redraw and scrolls the cursor off-screen). One row = one line.
  // Reserve lines for the tab strip, hint, scroll indicators, column header
  // (items/prs only) and an occasional notice line.
  const termRows = stdout?.rows ?? 24;
  // Non-sessions views also reserve a line for the "viewing as / filter" status.
  // The search box (shown while a search is active) takes one extra line, and a
  // path-scoped launcher shows one scope line.
  const pageSize = Math.max(
    3,
    termRows - (view === "sessions" ? 6 : 8) - (searchFocus ? 1 : 0) - (filterRoot ? 1 : 0),
  );
  useEffect(() => {
    setScrollTop((prev) => {
      let next = prev;
      if (cursor < next) next = cursor;
      else if (cursor >= next + pageSize) next = cursor - pageSize + 1;
      const maxTop = Math.max(0, rows.length - pageSize);
      return Math.min(Math.max(0, next), maxTop);
    });
  }, [cursor, pageSize, rows.length]);
  const visible = rows.slice(scrollTop, scrollTop + pageSize);
  const moreAbove = scrollTop;
  const moreBelow = Math.max(0, rows.length - (scrollTop + pageSize));

  const move = (dir: 1 | -1) => {
    if (selectableIdx.length === 0) return;
    const pos = selectableIdx.indexOf(cursor);
    setCursor(selectableIdx[(pos + dir + selectableIdx.length) % selectableIdx.length]);
  };

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleSection = (id: string) =>
    setToggles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // ── sessions search helpers ──
  const clearSearch = () => {
    setSearchFocus(null);
    setSearch({ text: "", cursor: 0 });
  };
  // Edit the query text + caret together so batched keystrokes each apply
  // against the latest value instead of a stale snapshot.
  const editSearch = (fn: (text: string, cursor: number) => { text?: string; cursor: number }) =>
    setSearch((s) => {
      const r = fn(s.text, s.cursor);
      return { text: r.text ?? s.text, cursor: r.cursor };
    });

  const switchView = (v: View) => {
    setView(v);
    setCursor(0);
    clearSearch();
  };

  // Open the Settings page (backend, identity, filters, auth status).
  const enterSettings = () => {
    setNotice(null);
    setMode({ kind: "settings", cursor: 0 });
  };

  // Open the backend picker (Azure DevOps ↔ GitHub), cursor on the current one.
  const enterProvider = (fromSettings = false) => {
    setNotice(null);
    const idx = Math.max(0, PROVIDER_INFO.findIndex((p) => p.name === provider));
    setMode({ kind: "provider", cursor: idx, fromSettings });
  };

  // Open the identity picker, cursor on the current identity.
  const enterIdentity = (fromSettings = false) => {
    if (!model) return;
    const curId = (identity ?? model.me).id;
    const idx = Math.max(0, roster.findIndex((m) => m.id === curId));
    setMode({ kind: "identity", cursor: idx, fromSettings });
  };

  // Switch backend — only to an installed one. Clears the (provider-specific)
  // identity override so the new backend's own "me" is used, resets scroll/search,
  // and persists the choice. Picking an uninstalled backend just surfaces its
  // auth hint (back on `fallback`); picking the current one is a no-op. A real
  // switch always lands on the list so you see the new backend's data reload.
  const applyProvider = (name: ProviderName, fallback: Mode) => {
    const info = PROVIDER_INFO.find((p) => p.name === name);
    if (!available.has(name)) {
      setMode(fallback);
      setNotice(`${info?.label ?? name} unavailable — ${info?.authHint ?? "CLI not installed"}`);
      return;
    }
    if (name === provider) {
      setMode(fallback);
      return;
    }
    setProvider(name);
    setIdentity(null); // ADO identity ids are meaningless on GitHub and vice-versa
    persist({ provider: name, identity: null });
    setCursor(0);
    clearSearch();
    setMode({ kind: "list" });
  };

  // Every fresh flow starts by choosing the agent (Claude or Copilot); once
  // picked, `proceedFresh` runs the original repo/branch/checkout routing.
  const enterFresh = (target: FreshTarget) => {
    setNotice(null);
    setCloneNote(null);
    cloneNoteRef.current = null;
    setMode({ kind: "agent", target, cursor: 0 });
  };

  // Both free-session entry points (new session, orchestrator) need repos to pick
  // from; without any, the flow has nowhere to run, so say why instead of opening
  // an empty picker.
  //
  // `scopedRepos` is never empty once the model is loaded: scoped keeps the
  // scoped folder, unscoped falls back to the launcher's cwd. So the only real
  // way to land here is the model not being loaded yet — the length guard below
  // is belt-and-braces, kept so a future change to that list can't silently
  // resurrect the empty picker instead of saying something.
  const haveRepos = () => {
    if (!model) {
      setNotice("Still loading — try again in a moment.");
      return false;
    }
    if (scopedRepos.length === 0) {
      // Leads with `agendo <dir>` on purpose: a plain "cd there and rerun" is
      // wrong in the default tmux mode, where rerunning re-attaches to the
      // ALREADY-RUNNING launcher (enterLauncherSession only spawns a new one
      // when the launcher window is dead), so the process keeps its original cwd
      // and nothing changes. A path arg resolves to its own host session, so it
      // always takes effect — and quitting first is the other way out.
      setNotice("No repo to start in — run `agendo <dir>` pointing at a git checkout (or quit with q, cd there, rerun).");
      return false;
    }
    return true;
  };

  // Entering either free-session flow clears a leftover clone note: it reports the
  // outcome of the LAST clone, and carrying it into a fresh pass through the
  // picker would caption an unrelated repo choice.
  const enterNewSession = () => {
    setNotice(null);
    setCloneNote(null);
    cloneNoteRef.current = null;
    if (!haveRepos()) return;
    setMode({ kind: "agent", target: freeTarget(), cursor: 0 });
  };

  /**
   * Open the orchestrator flow: the same repo → worktree → name steps as a plain
   * new session, but the agent picker is skipped (orchestrator mode is Claude-only,
   * so there's nothing to choose) and the session launches with the orchestrator
   * instructions injected.
   */
  const enterOrchestrator = () => {
    setNotice(null);
    setCloneNote(null);
    cloneNoteRef.current = null;
    if (!haveRepos()) return;
    setMode({ kind: "repo", target: orchestratorTarget(), agent: "claude", cursor: 0 });
  };

  // After the agent is chosen, resolve where to run: PRs check out their branch
  // as soon as the repo is known; work items prompt for a new branch name.
  const proceedFresh = (target: FreshTarget, agent: AgentSource) => {
    const repo = target.preferRepo ? model?.repos.find((r) => r.name === target.preferRepo) : undefined;
    if (target.kind === "pr") {
      if (repo) return startCheckout(target, repo, agent);
      return setMode({ kind: "repo", target, agent, cursor: 0 });
    }
    if (repo) setMode({ kind: "branch", target, agent, repo, value: target.defaultBranch, cursor: target.defaultBranch.length, worktree: true });
    else setMode({ kind: "repo", target, agent, cursor: 0 });
  };

  // Open a prepared plan. Outside tmux we unmount and let index.tsx attach;
  // inside tmux we switch to the agent's window but keep the menu mounted in its
  // own window, then refresh so running badges are current when you switch back.
  const open = (plan: OpenPlan) => {
    if (plan.mode === "handover") {
      onOpen(plan);
      exit();
      return;
    }
    runInline(plan);
    // A clone that fed straight into this launch (the PR flow does it in one
    // keystroke) reports itself here — otherwise "where did it clone to?" would
    // have no screen left to appear on.
    const cloned = cloneNoteRef.current ? `${cloneNoteRef.current} · ` : "";
    cloneNoteRef.current = null;
    setNotice(`${cloned}▸ ${plan.alreadyRunning ? "switched to" : "opened"} ${plan.tmuxName} — switch back to this window for more`);
    reload();
  };

  // Work item / free session: create a branch+worktree or launch in main repo directly.
  //
  // `seed` (orchestrator flow only) is what the name field was prefilled with. If
  // the user never edited it, we re-derive a free name HERE rather than trusting
  // the one computed when the screen opened — another orchestrator (a CLI launch,
  // or a second launcher) may have taken it in the meantime, and `createWorktree`
  // treats an existing path as success, so the stale name would silently drop this
  // session into that one's checkout. A name the user typed is left alone.
  const startFresh = (
    target: FreshTarget,
    repo: RepoInfo,
    name: string,
    worktree: boolean,
    agent: AgentSource,
    seed?: string,
  ) => {
    // A manual "new session" assigns its own session id (so it gets a canonical,
    // attachable `cl-new-<id>` window); work-item / PR launches keep their
    // item-named target. Both run the chosen agent in the resolved directory.
    const launch = (cwd: string) =>
      open(
        target.kind === "free"
          ? launchNewSession(cwd, agent, target.orchestrator)
          : launchFresh(cwd, target.tmuxName, agent),
      );
    if (worktree) {
      // Untouched orchestrator default → re-derive from the base slug at the last
      // possible moment (see the note above). Anything the user typed is used verbatim.
      const branch =
        seed && name.trim() === seed
          ? freeWorktreeBranch(repo.root, target.defaultBranch)
          : name.trim();
      setBusy(`Creating worktree ${branch} in ${repo.name}…`);
      const res = createWorktree(repo.root, branch);
      if (res.error) {
        setBusy(null);
        setMode({ kind: "list" });
        // Nothing launched, so no launch notice will consume the clone note —
        // drop it here or it would attach itself to some later, unrelated one.
        cloneNoteRef.current = null;
        setNotice(`Worktree failed: ${res.error}`);
        return;
      }
      setBusy(null);
      setMode({ kind: "list" });
      launch(res.path);
    } else {
      setMode({ kind: "list" });
      launch(repo.root);
    }
  };

  const openInBrowser = (target: { id: number; url: string }, label: string) => {
    setNotice(`Opening ${label} in browser…`);
    openUrl(target.url, (e) => setNotice(`Couldn't open browser: ${e.message}`));
    setMode({ kind: "list" });
  };

  // PR: check out the PR's existing branch from origin (never a new branch).
  const startCheckout = (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => {
    const branch = target.prBranch ?? target.defaultBranch;
    setBusy(`Checking out ${branch} in ${repo.name}…`);
    const res = checkoutWorktree(repo.root, branch);
    if (res.error) {
      setBusy(null);
      setMode({ kind: "list" });
      cloneNoteRef.current = null; // see startFresh — nothing launched to carry it
      setNotice(`Worktree failed: ${res.error}`);
      return;
    }
    setBusy(null);
    setMode({ kind: "list" });
    open(launchFresh(res.path, target.tmuxName, agent));
  };

  // A repo has been chosen — from the picker, or as the result of a clone. Every
  // downstream route (PR checkout / branch prompt / worktree-vs-main) hangs off
  // this one function, so a cloned repo takes the exact same path as one that was
  // already on disk; there is no second session-creation flow.
  const chooseRepo = (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => {
    if (target.kind === "pr") return startCheckout(target, repo, agent);
    // Default to "New git worktree" (cursor 0) only where one can exist and makes
    // sense. Two cases point at "Main repo checkout" (cursor 1) instead; both
    // options stay on screen either way:
    //  - Orchestrators: that's where the main branch lives, and merging is their
    //    whole job (see the wtchoice hint).
    //  - A non-repo folder (`agendo ~/git` → the scoped parent itself), where
    //    `git worktree add` can only ever print "fatal: not a git repository",
    //    so defaulting to it makes the enter-enter-enter happy path dead-end.
    // INTERIM: the non-repo case really wants its own pair of options (run
    // here / clone-or-init something), not a worktree-vs-checkout question —
    // this just stops the default from being the one that cannot work.
    if (target.kind === "free")
      return setMode({
        kind: "wtchoice",
        target,
        agent,
        repo,
        cursor: target.orchestrator || !isGitCheckout(repo.root) ? 1 : 0,
      });
    return setMode({
      kind: "branch",
      target,
      agent,
      repo,
      value: target.defaultBranch,
      cursor: target.defaultBranch.length,
      worktree: true,
    });
  };

  // ── clone a repo that isn't on disk yet ──
  // Gated on `canClone`: agendo must have been given a target directory, since
  // that directory is the only place it may write. See docs/cloning.md.
  //
  // …and that directory must not be inside a git checkout. The clone lands as a
  // direct child of it, so scoping to a repo (`agendo .`, `agendo ~/git/myrepo`,
  // or any path under one — all of which the scoping logic supports) would drop
  // a nested repository into that repo's working tree, where it sits as
  // untracked clutter forever. Cloning belongs in a folder OF checkouts, not in
  // one. `enclosingCheckout` walks up, but stops below $HOME — see there for why.
  const canClone = scoped && !!filterRoot && !enclosingCheckout(filterRoot, homedir());

  /** A freshly cloned (or matched) checkout, as a zero-session picker entry. */
  const clonedRepo = (root: string): RepoInfo => ({
    root,
    name: basename(root) || root,
    total: 0,
    claude: 0,
    copilot: 0,
    codex: 0,
  });

  /** Remember the checkout and continue into the ordinary session flow. */
  const adoptClonedRepo = (target: FreshTarget, agent: AgentSource, root: string, note: string) => {
    const repo = clonedRepo(root);
    setCloned((prev) =>
      prev.some((r) => normalizeCwd(r.root) === normalizeCwd(root)) ? prev : [...prev, repo],
    );
    setNotice(note);
    setCloneNote(note);
    cloneNoteRef.current = note;
    chooseRepo(target, repo, agent);
  };

  /**
   * Enter on the URL prompt. Resolves where the repo should live before touching
   * the network: an existing checkout of the same repo anywhere in the target
   * directory wins outright (never a second copy), otherwise a free directory
   * name is chosen and the clone starts.
   */
  const beginClone = (target: FreshTarget, agent: AgentSource, raw: string) => {
    const url = parseRepoUrl(raw);
    const fail = (...error: string[]) =>
      setMode({ kind: "clone", target, agent, value: raw, cursor: raw.length, error });
    if (!url) return fail("Not a recognizable GitHub or Azure DevOps repo URL.");

    const existing = findMatchingCheckout(filterRoot!, url.key);
    if (existing) {
      return adoptClonedRepo(target, agent, existing, `already cloned — using ${homeShort(existing)}`);
    }

    const dest = freeCloneDest(filterRoot!, cloneDirName(url.repo));
    if (!dest) return fail(`No free directory name for "${url.repo}" in ${homeShort(filterRoot!)}.`);

    setMode({ kind: "cloning", target, agent, url, dest, progress: "starting…", elapsed: 0 });
    const run = startClone(url.remote, dest, (line) =>
      setMode((p) => (p.kind === "cloning" ? { ...p, progress: line } : p)),
    );
    cloneRun.current = run;
    run.done.then((res) => {
      if (cloneRun.current !== run) return; // superseded by a newer attempt
      cloneRun.current = null;
      if (res.canceled) {
        setNotice("Clone cancelled.");
        return setMode({ kind: "repo", target, agent, cursor: 0 });
      }
      if (!res.ok) return fail(...cloneError(res));
      const landed = basename(dest) === cloneDirName(url.repo) ? "" : ` as ${basename(dest)}`;
      adoptClonedRepo(target, agent, dest, `cloned ${repoUrlLabel(url)}${landed} into ${homeShort(dest)}`);
    });
  };

  /** Cancel an in-flight clone (esc) — kills git and removes the partial dir. */
  const cancelClone = () => {
    cloneRun.current?.cancel();
  };

  // Convert a session's transcript into the other agent's format (via the
  // external converter) and resume the resulting session. Claude→Copilot keeps
  // the source cwd (the converter copies it but omits it from JSON); Copilot→
  // Claude takes the cwd the converter reports. The new claude session lands in
  // the default ~/.claude config dir (where the converter writes), so no
  // configDir override is needed for resume.
  const continueInOtherAgent = async (s: AgentSession) => {
    const dest = convertTarget(s.source);
    if (!dest) {
      setNotice(`No cross-agent convert for ${s.source} sessions (the converter only speaks Claude↔Copilot).`);
      return;
    }
    // Copilot has no `--append-system-prompt` equivalent, so converting an
    // orchestrator to it would produce a session with none of the coordinate-
    // don't-implement instructions — an "orchestrator" that just starts editing.
    // Refuse, the way `launch --orchestrator --copilot` does on the CLI.
    if (dest === "copilot" && isOrchestratorSession(s.id)) {
      setNotice("That's an orchestrator session — Copilot can't carry the orchestrator instructions, so it won't convert.");
      return;
    }
    const direction = s.source === "claude" ? "claude-to-copilot" : "copilot-to-claude";
    setNotice(null);
    setBusy(`Converting session to ${dest} (npx converter)…`);
    try {
      const res = await runConvert(direction, s.id);
      const converted: AgentSession = {
        id: res.id,
        source: dest,
        cwd: res.cwd ?? s.cwd,
        branch: s.branch,
        repository: dest === "copilot" ? s.repository : undefined,
        title: s.title,
        lastUsed: new Date(),
      };
      setBusy(null);
      setMode({ kind: "list" });
      open(openSession(converted));
    } catch (e: any) {
      setBusy(null);
      setMode({ kind: "list" });
      setNotice(`Convert to ${dest} failed: ${e?.message ?? e}`);
    }
  };

  // ── move a session to another Claude profile ────────────────────────────────
  // Open the picker for the hovered session. Every guard that can be answered
  // without touching disk is answered here, so the picker only ever appears when
  // a move is actually possible.
  //
  // A RUNNING session is refused rather than moved. agendo can tell that a
  // session is live (window→session attribution), and `paneReadiness` can even
  // say its input box looks idle — but that read is a documented best-effort
  // screen scrape (it returns "unknown" for any screen it doesn't recognize, and
  // says nothing about background bash, in-flight sub-agents or background
  // tasks), and there is no graceful-exit primitive to hand the agent anyway:
  // killWindow is a hard kill. Moving files out from under a live `claude` is not
  // worth guessing at, so the safe refusal is the whole behaviour.
  const enterProfilePicker = async (s: AgentSession) => {
    setNotice(null);
    if (s.source !== "claude") {
      setNotice(`${s.source} sessions have no profile — only Claude sessions live in a ~/.claude* dir.`);
      return;
    }
    if (!s.configDir || !s.logPath) {
      setNotice("This session has no on-disk transcript to move.");
      return;
    }
    if (isRunning(s, model?.liveTmux ?? new Set())) {
      setNotice(`${s.title} is running — exit it (or close its tmux window) before moving it to another profile.`);
      return;
    }
    setBusy("Scanning Claude profiles…");
    const choices = profileChoices(await discoverProfiles(), s);
    setBusy(null);
    const firstTarget = choices.findIndex((c) => !c.current);
    if (firstTarget < 0) {
      setNotice("No other Claude profile found — create a second ~/.claude* dir with a projects/ folder first.");
      return;
    }
    setMode({ kind: "profile", session: s, choices, cursor: firstTarget });
  };

  // Perform the move, then refresh: the session index is keyed by transcript
  // path, so a reload is what re-files it under the target profile (and re-reads
  // its activity from the new location).
  //
  // Two guards stand between a keystroke and the filesystem:
  //  • `moveInFlight` — `busy` swaps the RENDER but doesn't gate `useInput`, and
  //    `mode` only leaves "profile" once the await resolves, so a key-repeat on
  //    enter would otherwise start a second move racing the first over the same
  //    four renames. The loser hits ENOENT and rolls back the entries it won,
  //    tearing the session in half across the two profiles — exactly the state
  //    this feature must never produce. The mode is also dropped up front, so a
  //    stray enter has no picker left to act on.
  //  • a FRESH liveness read — the running-session refusal is the entire safety
  //    story for a live agent, and the picker can sit open indefinitely. A session
  //    resumed in the meantime (a keypress in its restore-placeholder tab from
  //    another tmux client, a second agendo) must not have its files pulled out
  //    from under it, so the check is re-run against tmux at commit time rather
  //    than trusted from picker-entry.
  const moveInFlight = useRef(false);
  const moveToProfile = async (s: AgentSession, target: ClaudeProfile) => {
    if (moveInFlight.current) return;
    moveInFlight.current = true;
    setNotice(null);
    setMode({ kind: "list" });
    setBusy(`Moving “${s.title}” to ${target.name}…`);
    try {
      await runMove(s, target);
    } finally {
      moveInFlight.current = false;
      setBusy(null);
    }
  };

  const runMove = async (s: AgentSession, target: ClaudeProfile) => {
    const sessions = (modelRef.current?.sessionGroups ?? []).flatMap((g) => g.sessions);
    if (isRunning(s, refreshLiveTmux(sessions).live)) {
      setNotice(`${s.title} started running — exit it (or close its tmux window) before moving it to another profile.`);
      return;
    }
    const res = await moveSessionToProfile(s, target);
    if (res.error) {
      setNotice(`Move failed: ${res.error}`);
      return;
    }
    if (res.noop) {
      setNotice(`${target.name} is the same directory on disk as this session's profile — nothing to move.`);
      return;
    }
    // The restore snapshot bakes CLAUDE_CONFIG_DIR into each tab's argv, so a
    // moved session's saved tab has to be repointed — and an already-visible
    // placeholder tab rebuilt — or it would resume against the profile it just left.
    const tab = retargetRestoreProfile(s, target.configDir, hostSession);
    setActivity(new Map()); // its log lives elsewhere now — drop the cached parse
    requested.current.clear();
    reload();
    const extras = [
      res.warning,
      tab.placeholderRefreshed ? "restored tab repointed" : null,
    ].filter(Boolean);
    setNotice(`Moved “${s.title}” → ${target.name}${extras.length ? ` (${extras.join("; ")})` : ""}`);
  };

  // Everything the ./keys handlers read or drive, rebuilt each render so they
  // always see this pass's state. Each handler narrows it to a `Pick` of the
  // members it actually touches, so a module's signature documents its reach.
  const ctx: KeyContext = {
    exit, model, filterRoot,
    mode, setMode, view, switchView, cursor, setCursor, rows, selectableIdx, move,
    toggleExpand, toggleSection, ensureActivity,
    searchFocus, setSearchFocus, search, editSearch, clearSearch,
    setGlobalView, setRepoFilterOn, setGrouped, setPrsGrouped, setPrSort, setSessionSort,
    setNotice, setActivity, requested, setRescanKey, reload,
    enterFresh, enterNewSession, enterOrchestrator, proceedFresh, reposForTarget,
    chooseRepo, startFresh, open, openInBrowser,
    canClone, beginClone, cancelClone, setCloneNote, cloneNoteRef,
    settingsItems, enterSettings, enterProvider, enterIdentity, applyProvider,
    setAutoResume, persist, roster, setIdentity,
    continueInOtherAgent, enterProfilePicker, moveToProfile,
  };

  useInput((input, key) => {
    if (handleOpenKeys(input, key, ctx)) return;
    if (handleSearchKeys(input, key, ctx)) return;

    if (handleQuitKeys(input, key, ctx)) return;

    if (handleAgentKeys(input, key, ctx)) return;

    if (handleRepoKeys(input, key, ctx)) return;

    if (handleCloneKeys(input, key, ctx)) return;
    if (handleCloningKeys(input, key, ctx)) return;

    if (handleWtchoiceKeys(input, key, ctx)) return;

    if (handleBranchKeys(input, key, ctx)) return;

    if (handleSettingsKeys(input, key, ctx)) return;

    if (handleProviderKeys(input, key, ctx)) return;

    if (handleIdentityKeys(input, key, ctx)) return;

    if (handleProfileKeys(input, key, ctx)) return;

    handleListKeys(input, key, ctx); // last link: nothing left to guard
  });

  // ── render ──
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press r to retry, q to quit.</Text>
      </Box>
    );
  }
  // Waiting between automatic attempts. Shows what failed and when the next try
  // lands, so an unattended launcher reads as busy rather than frozen — and `r`
  // still forces an immediate retry (it bumps reloadKey, cancelling this wait).
  if (retrying) {
    const secs = Math.max(0, Math.ceil((retrying.resumeAt - Date.now()) / 1000));
    const when = retrying.waiting ? `retrying in ${secs}s` : "retrying now";
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">⟳</Text>{" "}
          {`Load failed — ${when} (attempt ${retrying.attempt + 1} of ${retrying.attempts})…`}
        </Text>
        <Text color="yellow" wrap="truncate">⚑ {retrying.reason}</Text>
        {/* Deliberately NOT "Press r to retry…" — that exact phrase is the
            dead-end error screen's marker, and sharing it would make the two
            screens indistinguishable to anything matching on text. */}
        <Text dimColor>Press r to try again now, q to quit.</Text>
      </Box>
    );
  }
  if (!model) return <Text><Text color="cyan">⟳</Text> Loading work items, PRs & sessions…</Text>;
  if (busy) return <Text><Text color="cyan">⟳</Text> {busy}</Text>;

  if (mode.kind === "agent") return <AgentScreen target={mode.target} cursor={mode.cursor} />;

  if (mode.kind === "repo") {
    return (
      <RepoScreen
        target={mode.target}
        cursor={mode.cursor}
        repoChoices={reposForTarget(mode.target)}
        anyHostableRepo={anyHostableRepo}
        canClone={canClone}
        filterRoot={filterRoot}
      />
    );
  }

  if (mode.kind === "clone") {
    return (
      <CloneScreen
        value={mode.value}
        cursor={mode.cursor}
        error={mode.error}
        cloneUrl={cloneUrl}
        resolved={resolved}
        filterRoot={filterRoot}
      />
    );
  }

  if (mode.kind === "cloning") {
    return <CloningScreen url={mode.url} dest={mode.dest} progress={mode.progress} elapsed={mode.elapsed} />;
  }

  if (mode.kind === "identity") {
    return <IdentityScreen cursor={mode.cursor} identity={identity} me={model.me} roster={roster} />;
  }

  if (mode.kind === "settings") {
    return (
      <SettingsScreen
        cursor={mode.cursor}
        settingsItems={settingsItems}
        providerLabel={providerLabel}
        identity={model.identity}
        meId={model.me.id}
        autoResume={autoResume}
        available={available}
        authStatus={authStatus}
      />
    );
  }

  if (mode.kind === "provider") {
    return <ProviderScreen cursor={mode.cursor} provider={provider} available={available} />;
  }

  if (mode.kind === "wtchoice") {
    const opts = ["New git worktree", "Main repo checkout"];
    const descs = [
      `branch + worktree under ${mode.repo.root}/.claude/worktrees/`,
      `runs directly in ${mode.repo.root}`,
    ];
    return (
      <Box flexDirection="column">
        <Text bold>{`${mode.target.orchestrator ? "Orchestrator" : "New"} session in ${mode.repo.name} — choose where to run`}</Text>
        <Text dimColor>{"↑/↓ move · enter select · esc back"}</Text>
        {cloneNote ? <Text color="green" wrap="truncate">{`✓ ${cloneNote}`}</Text> : null}
        {mode.target.orchestrator ? (
          <Text color="magenta">
            {"An orchestrator squash-merges finished branches into the main branch, and git keeps that"}
          </Text>
        ) : null}
        {mode.target.orchestrator ? (
          <Text color="magenta">{"branch in one working tree only — so the main checkout is the right home for it."}</Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {opts.map((label, i) => {
            const sel = i === mode.cursor;
            return (
              <Text key={i} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text bold>{label.padEnd(22).slice(0, 22)}</Text>
                <Text dimColor={!sel}>{`  ${descs[i]}`}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "branch") {
    const { value, cursor } = mode;
    const isFree = mode.target.kind === "free";
    // Free sessions get a `cl-new-<id>` name assigned at launch, so we can only
    // preview the prefix; item/PR launches already know their target name.
    const tmuxPreview = isFree ? "cl-new-…" : mode.target.tmuxName;
    const orch = !!mode.target.orchestrator;
    return (
      <Box flexDirection="column">
        <Text bold>
          {orch ? `Orchestrator session in ${mode.repo.name}` : isFree ? `New session in ${mode.repo.name}` : `Fresh session in ${mode.repo.name} — ${mode.target.title.slice(0, 40)}`}
        </Text>
        <Text dimColor>{mode.worktree ? "New branch off origin/HEAD · ←/→ move · ⌃a/⌃e start/end · enter create & launch · esc back" : "Session name · ←/→ move · ⌃a/⌃e start/end · enter launch · esc back"}</Text>
        {cloneNote ? <Text color="green" wrap="truncate">{`✓ ${cloneNote}`}</Text> : null}
        <Box marginTop={1}>
          <Text>{mode.worktree ? "branch: " : "name:   "}</Text>
          <Text color="cyan">{value.slice(0, cursor)}</Text>
          <Text inverse>{value[cursor] ?? " "}</Text>
          <Text color="cyan">{value.slice(cursor + 1)}</Text>
        </Box>
        <Box marginTop={1}>
          {mode.worktree
            ? <Text dimColor>{`→ ${mode.agent}${orch ? " (orchestrator mode)" : ""} · worktree at ${mode.repo.root}/.claude/worktrees/${worktreeDirName(value)}`}</Text>
            : <Text dimColor>{`→ ${mode.agent}${orch ? " (orchestrator mode)" : ""} · runs in ${mode.repo.root}  · tmux ${tmuxPreview}`}</Text>
          }
        </Box>
      </Box>
    );
  }

  if (mode.kind === "profile") {
    return (
      <Box flexDirection="column">
        <Text bold>{`Move to another Claude profile — ${mode.session.title.slice(0, 44)}`}</Text>
        <Text dimColor>
          {"Relocates the transcript + its sidecar files  ·  ↑/↓ move · enter move · esc cancel"}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {mode.choices.map((c, i) => {
            const sel = i === mode.cursor;
            return (
              <Text key={c.profile.configDir} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text color={sel ? "black" : c.current ? "green" : "gray"}>{c.current ? "● " : "○ "}</Text>
                <Text bold color={sel ? "black" : c.current ? "gray" : undefined}>{c.profile.name.padEnd(18).slice(0, 18)}</Text>
                <Text color={sel ? "black" : c.current ? "gray" : "cyan"}>{c.current ? "lives here now" : "move here    "}</Text>
                <Text dimColor={!sel}>{`  ${homeShort(c.profile.projects)}`}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "open") {
    const { pr, workItem } = mode.targets;
    return (
      <Box flexDirection="column">
        <Text bold>{`Open in browser — ${mode.title.slice(0, 54)}`}</Text>
        <Text dimColor>{"Pick what to open · esc/q cancel"}</Text>
        <Box marginTop={1} flexDirection="column">
          {pr ? (
            <Text>
              <Text bold color="magenta">{"  p"}</Text>
              <Text>{`  PR ${V.prPrefix}${pr.id}`}</Text>
            </Text>
          ) : null}
          {workItem ? (
            <Text>
              <Text bold color="cyan">{"  i"}</Text>
              <Text>{`  issue #${workItem.id}`}</Text>
            </Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  // list view
  const tab = (v: View, label: string) => (
    <Text
      bold={view === v}
      backgroundColor={view === v ? "cyan" : undefined}
      color={view === v ? "black" : undefined}
      dimColor={view !== v}
    >
      {` ${label} `}
    </Text>
  );
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agendo </Text>
        <Text color="cyan">{`[${providerLabel}]  `}</Text>
        {tab("items", `1 ${V.itemsTab}`)}
        <Text> </Text>
        {tab("prs", "2 PRs")}
        <Text> </Text>
        {tab("sessions", "3 Sessions")}
      </Box>
      {filterRoot ? (
        <Box>
          <Text wrap="truncate">
            <Text color={scoped ? "green" : "yellow"}>
              {scoped ? `⊙ ${hostSession}: ${homeShort(filterRoot)}` : "⊙ global — all paths"}
            </Text>
            <Text dimColor>{`  · a ${scoped ? "show all" : `rescope to ${hostSession}`}`}</Text>
            {/* The repo filter's own state + key hint, next to the path scope's
                so both toggles are discoverable in the same place. */}
            <Text dimColor>
              {discoveredRepos.length === 0
                ? `  · f repo filter: no repos found here`
                : `  · f repo filter: ${repoFilterOn ? `on (${discoveredRepos.length} repo${discoveredRepos.length > 1 ? "s" : ""})` : "off"}`}
            </Text>
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text wrap="truncate" dimColor>
          {searchFocus === "input"
            ? `type to filter · ←/→ caret · ⌫ delete · ⌃w del word · ↓ results · enter ${view === "sessions" ? "resume" : "open"} · esc cancel`
            : searchFocus === "list"
              ? `↑/↓ move · ↑ at top edits search · → expand · / edit · enter ${view === "sessions" ? "resume" : "open"} · o browser · esc cancel`
              : view === "sessions"
                // `⇥ view` (not "switch view") matches the PRs hint and buys back
                // 7 columns for the `O orchestrator` and `m →profile` entries —
                // this line already truncated at ~120 cols before either of them,
                // so tail hints are at a premium.
                ? `↑/↓ move · → expand · ⇥ view · g ${grouped ? "ungroup" : "group"} · s sort: ${sessionSort} · / search · n new · O orchestrator · enter resume · c →other agent · m →profile · o browser · , settings · r refresh · q/esc quit`
                : view === "prs"
                  ? `↑/↓ move · → expand · ⇥ view · g ${prsGrouped ? "ungroup" : "group"} · s sort: ${prSort === "created" ? "created" : "updated"} · / search · enter open · o browser · , settings · r refresh · q/esc quit`
                  : "↑/↓ move · →/← expand · ⇥ switch view · / search · enter open/expand · o browser · , settings · r refresh · q/esc quit"}
        </Text>
      </Box>
      {searchFocus ? (
        <Box>
          <Text wrap="truncate">
            <Text color={searchFocus === "input" ? "cyan" : "gray"}>{"search "}</Text>
            {searchFocus === "input" ? (
              <Text>
                {search.text.slice(0, search.cursor)}
                <Text inverse>{search.text[search.cursor] ?? " "}</Text>
                {search.text.slice(search.cursor + 1)}
              </Text>
            ) : (
              <Text dimColor>{search.text}</Text>
            )}
          </Text>
        </Box>
      ) : null}
      {view !== "sessions" ? (
        <Box>
          <Text wrap="truncate">
            <Text color="magenta">{"as "}</Text>
            <Text bold>
              {model.identity.displayName}
              {model.identity.id === model.me.id ? " (you)" : ""}
            </Text>
          </Text>
        </Box>
      ) : null}
      {view !== "sessions" ? (
        <ColumnHeader
          headers={view === "prs" ? prHeaders(prSort) : HEADERS_ITEMS}
          widths={view === "prs" ? PR_WIDTHS : ITEM_WIDTHS}
        />
      ) : null}
      <Text dimColor>{moreAbove > 0 ? `  ↑ ${moreAbove} more` : " "}</Text>

      {visible.map((row, li) => {
        const i = scrollTop + li;
        const selected = i === cursor && searchFocus !== "input";
        if (row.kind === "spacer") return <Text key={`s${i}`}> </Text>;
        if (row.kind === "header") {
          return (
            <Box key={`h${i}`}>
              <Text wrap="truncate" bold color="blue">{row.label}</Text>
              {row.sub ? <Text dimColor>{`  ${row.sub}`}</Text> : null}
            </Box>
          );
        }
        if (row.kind === "item") {
          return (
            <ItemRow key={`i${itemKey(row.item)}`} item={row.item} expanded={row.expanded} running={row.running} selected={selected} />
          );
        }
        if (row.kind === "pr") {
          return (
            <PrRow
              key={`p${prKey(row.pr)}`}
              pr={row.pr}
              expanded={row.expanded}
              running={row.running}
              selected={selected}
              contextCell={row.contextCell}
              sort={prSort}
            />
          );
        }
        if (row.kind === "session") {
          return (
            <SessionRow
              key={row.key}
              session={row.session}
              running={row.running}
              kind={row.running ? model?.liveKinds.get(sessionName(row.session)) : undefined}
              pane={row.running ? panes.get(sessionName(row.session)) : undefined}
              expanded={row.expanded}
              selected={selected}
              timeField={row.timeField}
              open={row.open}
              showLink={row.showLink}
              placeholder={row.placeholder}
            />
          );
        }
        if (row.kind === "sessmeta") {
          return (
            <Box key={row.key} marginLeft={6}>
              <Text wrap="truncate" dimColor>
                <Text color="gray">{row.label.padEnd(8)}</Text>
                {row.value}
              </Text>
            </Box>
          );
        }
        if (row.kind === "sessprompt") {
          return (
            <Box key={row.key} marginLeft={6}>
              <Text wrap="truncate" dimColor>{`↳ "${row.prompt.replace(/\s+/g, " ")}"`}</Text>
            </Box>
          );
        }
        if (row.kind === "task") {
          return <TaskRow key={row.key} task={row.task} />;
        }
        if (row.kind === "action") {
          return <ActionRow key={row.key} action={row.action} />;
        }
        if (row.kind === "sessnote") {
          return (
            <Box key={row.key} marginLeft={6}>
              <Text dimColor italic>{row.text}</Text>
            </Box>
          );
        }
        if (row.kind === "newsess") {
          return (
            <Box key="newsess">
              <Text bold color={selected ? "black" : "green"} backgroundColor={selected ? "cyan" : undefined}>
                {"＋ new session"}
              </Text>
            </Box>
          );
        }
        if (row.kind === "fresh") {
          return (
            <Box key={row.key} marginLeft={4}>
              <Text color={selected ? "black" : "gray"} backgroundColor={selected ? "cyan" : undefined}>
                {"+ start a fresh session…"}
              </Text>
            </Box>
          );
        }
        // toggle section
        const caret = row.open ? "▾" : "▸";
        return (
          <Box key={`toggle:${row.id}`} marginLeft={row.indent ?? 0}>
            <Text wrap="truncate" color={selected ? "black" : "blue"} backgroundColor={selected ? "cyan" : undefined} bold>
              {`${caret} ${row.label} (${row.count})`}
              {row.sub ? <Text color={selected ? "black" : "gray"}>{`  ${row.sub}`}</Text> : null}
            </Text>
          </Box>
        );
      })}

      <Text dimColor>{moreBelow > 0 ? `  ↓ ${moreBelow} more` : " "}</Text>
      {notice ? (
        <Box>
          <Text color="yellow">⚑ {notice}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
