import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { isRunning, itemKey, liveKey, prKey, refreshLiveTmux, type LoadedModel } from "../model.ts";
import { loadActivity } from "../sessions.ts";
import { launchFresh, launchNewSession, runInline, type OpenPlan } from "../launch.ts";
import { sessionName } from "../tmux.ts";
import { discoverProfiles, moveSessionToProfile, profileChoices, type ClaudeProfile } from "../profiles.ts";
import { retargetRestoreProfile } from "../restore.ts";
import { openUrl } from "../browser.ts";
import { createWorktree, checkoutWorktree, freeWorktreeBranch } from "../worktree.ts";
import { loadState, saveState } from "../config.ts";
import {
  discoverGitReposUnder,
  isGitCheckout,
  type RepoInfo,
} from "../repos.ts";
import { detectProviders, resolveInitialProvider, detectScopeProvider, PROVIDER_INFO } from "../provider.ts";
import { homeShort, type Activity } from "./format.ts";
import { makeCloneActions } from "./cloneActions.ts";
import { makeContinueInOtherAgent } from "./convertAgent.ts";
import { freeTarget, orchestratorTarget, type FreshTarget } from "./targets.ts";
import {
  sessionId,
  type PrSort,
  type SessionSort,
} from "./rows.ts";
import {
  ActionRow,
  ColumnHeader,
  HEADERS_ITEMS,
  CaretText,
  ITEM_WIDTHS,
  ItemRow,
  PR_WIDTHS,
  PrRow,
  prHeaders,
  SessionRow,
  TaskRow,
} from "./components.tsx";
import { useActivityWatchers } from "./hooks/useActivityWatchers.ts";
import { useAuthProbe } from "./hooks/useAuthProbe.ts";
import { useCloneFlow } from "./hooks/useCloneFlow.ts";
import { useModelLoader } from "./hooks/useModelLoader.ts";
import { useReadinessPoll } from "./hooks/useReadinessPoll.ts";
import { useRepoScope } from "./hooks/useRepoScope.ts";
import { useViewport } from "./hooks/useViewport.ts";
import { useRowModel } from "./hooks/useRowModel.ts";
import { useSearch } from "./hooks/useSearch.ts";
import { V } from "./vocabState.ts";
import { useLocalRescan } from "./hooks/useLocalRescan.ts";
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
import { BranchScreen } from "./screens/BranchScreen.tsx";
import { CloneScreen } from "./screens/CloneScreen.tsx";
import { CloningScreen } from "./screens/CloningScreen.tsx";
import { IdentityScreen } from "./screens/IdentityScreen.tsx";
import { OpenScreen } from "./screens/OpenScreen.tsx";
import { ProfileScreen } from "./screens/ProfileScreen.tsx";
import { ProviderScreen } from "./screens/ProviderScreen.tsx";
import { WtChoiceScreen } from "./screens/WtChoiceScreen.tsx";
import { SettingsScreen } from "./screens/SettingsScreen.tsx";
import { RepoScreen } from "./screens/RepoScreen.tsx";
import type {
  AgentSession,
  AgentSource,
  Identity,
  ProviderName,
} from "../types.ts";


// ── main app ──────────────────────────────────────────────────────────────────
/**
 * `filterRoot` scopes the launcher to sessions under a path (null = the global
 * launcher, bare `agendo`). `hostSession` is the tmux host session the menu runs
 * in — passed to loadModel so restore snapshots the right session's tabs. The
 * `a` key toggles the runtime scoped↔global view (see `globalView`).
 */
/** A new set with `k` added if absent, removed if present — the shape both the
 *  expanded-row set and the collapsed-section set need. */
function flip<T>(prev: Set<T>, k: T): Set<T> {
  const next = new Set(prev);
  if (!next.delete(k)) next.add(k);
  return next;
}

export default function App({
  onOpen,
  filterRoot = null,
  hostSession,
  remote,
}: {
  onOpen: (plan: OpenPlan) => void;
  filterRoot?: string | null;
  hostSession?: string;
  /** Machines to include beside this one (`--remote`); null = local only. */
  remote: string[] | null;
}) {
  const { exit } = useApp();
  const [model, setModel] = useState<LoadedModel | null>(null);
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
  const { searchFocus, setSearchFocus, search, clearSearch, editSearch } = useSearch();
  const [activity, setActivity] = useState<Map<string, Activity>>(new Map());
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
  // Persisted "who am I / filter" state (Work items & PRs views only).
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const s = loadState();
    return s.identityId
      ? { id: s.identityId, displayName: s.identityName ?? "?", uniqueName: s.identityUniqueName ?? "" }
      : null;
  });

  const { error, retrying, reload } = useModelLoader({
    provider,
    identity,
    hostSession,
    remote,
    discoveredRepos,
    setModel,
    setNotice,
    noticeRef,
  });

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  const authStatus = useAuthProbe({ mode, available });

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

  // Lazily parse a session's recent activity the first time it's expanded, then
  // cache it (keyed by session identity). A ref dedupes in-flight requests so
  // it's safe to call on every expand/collapse — it fetches each session once.
  const requested = useRef<Set<string>>(new Set());
  // Mirror `model` into a ref so the mount-only liveness interval reads the
  // current sessions without a stale closure and without re-arming the timer.
  const modelRef = useRef<LoadedModel | null>(null);
  // Same, for the path context's repos — an `r` rescan can replace them.
  const discoveredReposRef = useRef(discoveredRepos);
  useEffect(() => { discoveredReposRef.current = discoveredRepos; }, [discoveredRepos]);
  const ensureActivity = (s: AgentSession) => {
    const id = sessionId(s);
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setActivity((p) => new Map(p).set(id, "loading"));
    loadActivity(s)
      .then((a) => setActivity((p) => new Map(p).set(id, a)))
      .catch(() => setActivity((p) => new Map(p).set(id, "error")));
  };

  // The actionable rows of the Settings page, in display order. Kept in one
  // place so the input handler (cursor / enter) and the renderer stay in lockstep.
  const settingsItems: Array<"provider" | "identity" | "autoResume"> = ["provider", "identity", "autoResume"];
  const providerLabel = PROVIDER_INFO.find((p) => p.name === provider)?.label ?? provider;

  const { scoped, inScope, scopedRepos, reposForTarget, anyHostableRepo } = useRepoScope({
    model,
    filterRoot,
    globalView,
    cloned,
  });

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

  const { cloneNote, setCloneNote, cloneNoteRef, cloneRun, cloneUrl, resolved } = useCloneFlow({
    mode,
    filterRoot,
  });

  const { rows, selectableIdx, roster } = useRowModel({
    model,
    repoFilterOn,
    view,
    expanded,
    toggles,
    grouped,
    prsGrouped,
    prSort,
    sessionSort,
    activity,
    search,
    inScope,
  });

  useEffect(() => {
    if (selectableIdx.length === 0) return;
    if (!selectableIdx.includes(cursor)) setCursor(selectableIdx[0]);
  }, [selectableIdx, cursor]);

  useActivityWatchers({ rows, setActivity });

  // Background LOCAL rescan on a timer; see ./hooks/useLocalRescan.ts.
  useLocalRescan({ modelRef, discoveredReposRef, setModel });

  const panes = useReadinessPoll({ model, autoResume });

  const { scrollTop, visible, moreAbove, moreBelow } = useViewport({
    rows,
    cursor,
    view,
    searchFocus,
    filterRoot,
  });

  const move = (dir: 1 | -1) => {
    if (selectableIdx.length === 0) return;
    const pos = selectableIdx.indexOf(cursor);
    setCursor(selectableIdx[(pos + dir + selectableIdx.length) % selectableIdx.length]);
  };

  const toggleExpand = (key: string) => setExpanded((prev) => flip(prev, key));
  const toggleSection = (id: string) => setToggles((prev) => flip(prev, id));

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
  // The handlers live in ./cloneActions.ts; the state they drive lives in the
  // useCloneFlow hook above. Built here, at the line the block occupied, because
  // they close over `open` and `chooseRepo` — both defined above this point.
  const { canClone, beginClone, cancelClone } = makeCloneActions({
    scoped, filterRoot, cloneRun, cloneNoteRef, setMode, setNotice, setCloned, setCloneNote, chooseRepo,
  });

  const continueInOtherAgent = makeContinueInOtherAgent({ open, setMode, setNotice, setBusy });

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
    return <WtChoiceScreen target={mode.target} repo={mode.repo} cursor={mode.cursor} cloneNote={cloneNote} />;
  }

  if (mode.kind === "branch") {
    return (
      <BranchScreen
        target={mode.target}
        agent={mode.agent}
        repo={mode.repo}
        value={mode.value}
        cursor={mode.cursor}
        worktree={mode.worktree}
        cloneNote={cloneNote}
      />
    );
  }

  if (mode.kind === "profile") {
    return <ProfileScreen title={mode.session.title} choices={mode.choices} cursor={mode.cursor} />;
  }

  if (mode.kind === "open") {
    return <OpenScreen targets={mode.targets} title={mode.title} />;
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
                <CaretText value={search.text} cursor={search.cursor} />
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
              kind={row.running ? model?.liveKinds.get(liveKey(row.session)) : undefined}
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
