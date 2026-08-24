// Assembles the view model: work items (from the configured backend) joined
// with on-disk agent sessions (matched by PR branch) and live-tmux status.
import { getProvider } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import {
  liveTargets, liveManagedPaths, sessionName, managedKind,
  type SessionKind, type LiveTarget, type ManagedTarget,
} from "./tmux.ts";
import { captureRestore, resolveWindowSession } from "./restore.ts";
import { discoverRepos, mergeRepos, repoRootForCwd, repoScopeKeys, type RepoInfo } from "./repos.ts";
import { remoteSession, sweepRemotes } from "./remoteSessions.ts";
import type { PaneState } from "./ui/format.ts";
import { basename } from "path";
import type {
  AgentSession,
  Identity,
  ProviderName,
  LinkedPR,
  PRWithSessions,
  PullRequest,
  RepoSessions,
  ReviewPRWithSessions,
  TeamMember,
  WorkItem,
} from "./types.ts";

/**
 * What a local session links back to: the PR whose branch it matches and/or the
 * work item that PR (or its branch/worktree id) resolves to. Used by the
 * Sessions view to show a backlink and open it in the browser. Structurally
 * matches the UI's OpenTargets so it can be passed straight through.
 */
export interface SessionLink {
  pr?: { id: number; url: string };
  workItem?: { id: number; url: string };
}

export interface LoadedModel {
  /** Which backend produced this model — drives provider-specific terminology. */
  provider: ProviderName;
  // The two item-view buckets. ADO: current sprint / everything else assigned.
  // GitHub: issues you created / other open issues in your repos.
  current: WorkItem[];
  other: WorkItem[];
  /** PRs linked to one of my work items (PR view, upper section). */
  linkedPrs: LinkedPR[];
  /** Active PRs where I (or one of my teams) am a requested reviewer. */
  reviewPrs: ReviewPRWithSessions[];
  /** Active PRs I created that aren't linked to any of my work items. */
  orphanPrs: PRWithSessions[];
  /**
   * Work items resolved via the PR→workitems direction for orphan PRs I
   * created. The WI wasn't assigned to me / matched my filters, but my PR
   * links to it — surfaced so the work context is visible. Includes the PR(s)
   * that surfaced each item merged into the item's prs list.
   */
  prLinked: WorkItem[];
  currentIterationName: string | null;
  /** tmux session names that are currently live. */
  liveTmux: Set<string>;
  /** Readiness for remote windows, from the sweep — see `LocalSessions`. Empty
   *  without `--remote`. */
  remotePanes: Map<string, PaneState>;
  /** How each currently-running session was launched, by canonical name (for UI badges). */
  liveKinds: Map<string, SessionKind>;
  /** The live tmux window each running session occupies, by canonical name (for pane reads). */
  liveWindows: Map<string, LiveTarget>;
  /**
   * Canonical names of sessions that have a live but dormant restore placeholder
   * window (idle bash awaiting a keypress, not yet running). Not in `liveTmux`;
   * lets the Sessions view badge them as restored-but-unopened.
   */
  livePlaceholders: Set<string>;
  /** Repos ranked by session count, for the fresh-session repo picker. Includes
   *  the repos found under the launcher's path context, so a freshly-cloned repo
   *  that never hosted a session is still offered. */
  repos: RepoInfo[];
  /**
   * Match set for repo-scoped filtering of the work-item / PR views: every
   * identifier (slug, repo name, directory basename) of the repos found under
   * the launcher's path context, or `null` when there is no path context (or no
   * repo inside it) — in which case filtering is inert. See prInRepoScope.
   */
  repoScope: Set<string> | null;
  /** All local sessions grouped by their worktree's main repo (Sessions view). */
  sessionGroups: RepoSessions[];
  /**
   * Reverse index: which PR / work item each local session links to, keyed by
   * `${source}:${id}`. Lets the Sessions view surface the backlink (display +
   * open-in-browser) even though a session is only matched onto PRs/WIs.
   */
  sessionLinks: Map<string, SessionLink>;
  /** The authenticated az user (the "(you)" marker / default identity). */
  me: Identity;
  /** The identity whose work items & PRs are shown (Work items + PRs views). */
  identity: Identity;
  /** Roster for the identity switcher (configured team's members). */
  teamMembers: TeamMember[];
}

export interface LoadModelOptions {
  /** Which backend to load from (Azure DevOps or GitHub). */
  provider: ProviderName;
  /** Whose work items / PRs to show; null ⇒ the authenticated user. */
  identity: Identity | null;
  /**
   * The launcher's tmux host session, whose open tabs are snapshotted for
   * browser-style restore. Defaults to the canonical `agendo` session; a
   * path-scoped launcher passes its own host session so restore stays isolated.
   */
  hostSession?: string;
  /**
   * Machines to sweep beside this one, as beam names them; null (the default)
   * means local only and spawns no beam at all. Only a FULL load sweeps them —
   * the 2s local rescan deliberately does not, see useLocalRescan.
   */
  remote?: string[] | null;
  /**
   * The git repos found under the launcher's path context (repos.ts'
   * `discoverGitReposUnder`). They widen the fetch scope — backends that query
   * per repo (GitHub) must see a repo inside the target even if no session ever
   * ran there — and produce `LoadedModel.repoScope`, the display filter. Absent
   * / empty ⇒ no path context, so nothing is scoped.
   */
  scopeRepos?: RepoInfo[];
}

export function isRunning(s: AgentSession, live: Set<string>): boolean {
  return live.has(liveKey(s));
}

/**
 * The key a session is filed under in `live` / `liveKinds` / `liveWindows`.
 *
 * For a local session this is exactly `sessionName(s)` — the tmux window name —
 * which is what these maps have always been keyed by, so nothing local moves.
 *
 * A remote session needs the machine folded in, because `sessionName` is NOT
 * unique across machines: the same session resumed on two of them carries the
 * same `cl-<source>-<shortid>` on both. Keyed by name alone, one machine's
 * window would answer for the other's — and pressing enter would attach you to
 * the wrong machine, which is the failure that matters here.
 */
export function liveKey(s: AgentSession): string {
  return s.host ? `${s.host}${REMOTE_KEY_SEP}${sessionName(s)}` : sessionName(s);
}

/**
 * Separator between the machine and the window name in a remote `liveKey`.
 *
 * A NUL, and deliberately not something readable like `/` or `:`. These maps
 * also hold RAW tmux session and window names (`reconcileLive` seeds them from
 * `liveTargets()`), and a local window may legitimately be named with a slash —
 * in fact agendo names its own remote-attach windows `<host>/<window>`, so a
 * slash test would classify the local half of a remote attach as remote. tmux
 * cannot put a NUL in a name, so this cannot collide with anything real.
 */
export const REMOTE_KEY_SEP = "\u0000";

/** Whether a `live`/`liveWindows` key belongs to another machine. */
export function isRemoteKey(k: string): boolean {
  return k.includes(REMOTE_KEY_SEP);
}

/**
 * Recompute live tmux state without any backend/network work (just the tmux CLI
 * reads via liveTargets + liveManagedPaths), so it's cheap enough to poll.
 * Returns the set of live session names plus, for each running session, how it
 * was launched (`liveKinds`, for the UI badge) and which window it occupies
 * (`liveWindows`, for pane reads).
 *
 * Attributes every live managed (`cl-…`) window to the session running in it and
 * registers that session's canonical name as live, across every prefix — old
 * (`cl-wi-`, `cl-pr-`, `cl-free-`) and new (`cl-bg-`, `cl-new-`). Id-bearing
 * names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/`cl-new-`) embed the session's short
 * id, so we match that exact session; work-item / PR names (`cl-wi-…`/`cl-pr-…`)
 * embed an item id instead, so we attribute them to the most-recently-used
 * session in the same working directory. `allSessions` is the full local session
 * collection (loadModel passes index.all; the App poll passes the same set).
 */
export function refreshLiveTmux(allSessions: AgentSession[]): {
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  livePlaceholders: Set<string>;
} {
  // `base` is membership only — the names tmux currently lists. The addressable
  // targets ride along on `liveManagedPaths`, which is where reconciliation picks
  // the window it attributes a session to.
  return reconcileLive(new Set(liveTargets().keys()), liveManagedPaths(), allSessions);
}

/**
 * Pure reconciliation core of `refreshLiveTmux`, extracted so it's testable
 * without live tmux. Folds the managed (`cl-…`) targets into `base` (the raw
 * live session/window names) and returns the running set plus, per running
 * session, how it was launched (`liveKinds`, for the UI badge) and which window
 * it occupies (`liveWindows`, for pane reads).
 *
 * Id-bearing names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/`cl-new-`) embed the
 * session's short id, so we match that exact session; work-item / PR / legacy
 * names (`cl-wi-…`/`cl-pr-…`/`cl-free-…`) embed an item id instead, so we
 * attribute them to the most-recently-used session in the same working dir.
 *
 * A restored-but-unopened placeholder window also carries the canonical
 * `cl-<source>-<id>` name, so `base` already counted it as running; it's just an
 * idle bash waiting for a keypress, so it must be dropped (its script clears the
 * marker on resume, restoring running status). But a placeholder and a *real*
 * window can carry the same canonical name — e.g. a placeholder `cl-claude-X`
 * alongside a real `cl-wi-…` whose cwd attributes back to session X. So we run
 * two order-independent passes rather than add/delete inline (which would let
 * tmux's pane iteration order decide the winner): pass 1 attributes every real
 * window (recording its kind/window keyed by canonical name); pass 2 drops only
 * the placeholders no real window vouched for (`liveKinds.has(name)`).
 */
export function reconcileLive(
  base: Set<string>,
  managed: ManagedTarget[],
  sessions: AgentSession[],
): { live: Set<string>; liveKinds: Map<string, SessionKind>; liveWindows: Map<string, LiveTarget>; livePlaceholders: Set<string> } {
  const live = base;
  const liveKinds = new Map<string, SessionKind>();
  const liveWindows = new Map<string, LiveTarget>();
  const placeholders = new Set<string>();
  for (const { name, target, cwd, placeholder } of managed) {
    const kind = managedKind(name);
    if (!kind) continue;
    // An idle placeholder must not vouch for "running": record its window name
    // and skip it; pass 2 drops it unless a real window vouches for that name.
    if (placeholder) {
      placeholders.add(name);
      continue;
    }
    // Shared with restore.ts so the two attribution paths can't drift: id-bearing
    // names match by short id, work-item / PR names by cwd+lastUsed.
    const best = resolveWindowSession(sessions, name, cwd);
    if (!best) continue;
    const canon = sessionName(best);
    live.add(canon);
    liveKinds.set(canon, kind);
    liveWindows.set(canon, { name, target });
  }
  // A placeholder's window name IS its canonical name, so a real window vouching
  // for the same session shows up as a `liveKinds` entry under that name. Any
  // placeholder no real window vouched for is a dormant restored tab: drop it
  // from `live` (it's not running) but record it in `livePlaceholders` so the UI
  // can badge the session as restored-but-unopened.
  const livePlaceholders = new Set<string>();
  for (const p of placeholders) {
    if (!liveKinds.has(p)) {
      live.delete(p);
      livePlaceholders.add(p);
    }
  }
  return { live, liveKinds, liveWindows, livePlaceholders };
}

/** Dedup/identity key for a PR. PR ids are only unique within a repo (GitHub
 *  numbers collide across repos), so scope every key by the repository. */
export const prKey = (pr: Pick<PullRequest, "repositoryId" | "id">): string =>
  `${pr.repositoryId}:${pr.id}`;

/** Dedup/identity key for a work item. Same caveat as prKey: GitHub issue
 *  numbers are per-repo, so scope by the project (the repo slug on GitHub). */
export const itemKey = (it: Pick<WorkItem, "project" | "id">): string =>
  `${it.project}:${it.id}`;

// ── repo scope: keeping only what belongs to the path context's repos ─────────
// One pure predicate per list, shared by the TUI and the CLI (as isUnderRoot is
// for the session path filter) so the two can never disagree about what's in
// scope. A null scope means "not filtering" and passes everything.

/** Whether a PR belongs to one of the in-scope repos. Both backends carry a repo
 *  identity on the PR: GitHub's `repositoryId` is the `owner/repo` slug, ADO's
 *  `repositoryName` is the repo's display name (its id is an opaque guid). */
export function prInRepoScope(pr: PullRequest, scope: Set<string> | null): boolean {
  if (!scope) return true;
  return scope.has(pr.repositoryId.toLowerCase()) || scope.has((pr.repositoryName ?? "").toLowerCase());
}

/**
 * Whether a work item belongs to one of the in-scope repos. Exact on GitHub —
 * `project` is the issue's `owner/repo` slug. Azure DevOps work items have NO
 * repo field at all (`project` is the ADO *team project*), so their only repo
 * signal is transitive, through the PRs linked to them: an item with linked PRs
 * is in scope iff one of them is, and an item with no PR yet carries no signal
 * and is deliberately KEPT (dropping the whole PR-less backlog would hide the
 * work the user opened the launcher to start).
 */
export function itemInRepoScope(
  it: WorkItem,
  provider: ProviderName,
  scope: Set<string> | null,
): boolean {
  if (!scope) return true;
  if (provider === "github") return scope.has(it.project.toLowerCase());
  if (it.prs.length === 0) return true;
  return it.prs.some((pr) => prInRepoScope(pr, scope));
}

/** The model with its work-item and PR lists narrowed to the in-scope repos.
 *  Purely a display filter — the local session views (and the tmux state they
 *  read) are untouched, and a null scope returns the model as-is. */
export function filterModelByRepos(model: LoadedModel, scope: Set<string> | null): LoadedModel {
  if (!scope) return model;
  const item = (it: WorkItem) => itemInRepoScope(it, model.provider, scope);
  const pr = (p: PullRequest) => prInRepoScope(p, scope);
  return {
    ...model,
    current: model.current.filter(item),
    other: model.other.filter(item),
    prLinked: model.prLinked.filter(item),
    linkedPrs: model.linkedPrs.filter(pr),
    reviewPrs: model.reviewPrs.filter(pr),
    orphanPrs: model.orphanPrs.filter(pr),
  };
}

/** Sort helper shared by the session groupings: most-recently-used first. */
const byLastUsedDesc = (a: AgentSession, b: AgentSession) =>
  b.lastUsed.getTime() - a.lastUsed.getTime();

/** Group every local session by the main repo of its worktree (Sessions view),
 *  most-recently-active repo (and session within a repo) first. */
export function groupSessionsByRepo(sessions: AgentSession[]): RepoSessions[] {
  const groupMap = new Map<string, AgentSession[]>();
  for (const s of sessions) {
    const root = repoRootForCwd(s.cwd);
    const arr = groupMap.get(root) ?? [];
    arr.push(s);
    groupMap.set(root, arr);
  }
  return [...groupMap.entries()]
    .map(([root, ss]) => ({ root, name: basename(root), sessions: ss.sort(byLastUsedDesc) }))
    .sort((a, b) => b.sessions[0].lastUsed.getTime() - a.sessions[0].lastUsed.getTime());
}

/**
 * The CHEAP, network-free half of a model load: scan on-disk sessions, discover
 * their repos, reconcile live tmux, and group sessions by repo. Deliberately does
 * NO provider.* calls, so it's light enough to poll on a short timer — the App
 * runs it every couple seconds to discover sessions started since the last full
 * `loadModel` (so their windows enter `liveWindows` and the readiness/auto-resume
 * poll can act on them) without paying for the slow backend fetches. `loadModel`
 * reuses it so the local half has a single source of truth.
 */
export interface LocalSessions {
  index: SessionIndex;
  repos: RepoInfo[];
  sessionGroups: RepoSessions[];
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  livePlaceholders: Set<string>;
  /** One line per machine that could not be read; empty without `--remote`. */
  remoteWarnings: string[];
  /**
   * Readiness for the remote windows, keyed by `liveKey`, as the sweep computed
   * it. The local readiness poll cannot produce this — it captures panes on THIS
   * machine's tmux — so a remote row would otherwise render with no state at
   * all. Refreshed on a full load, like everything else remote.
   */
  remotePanes: Map<string, PaneState>;
}

export async function loadLocalSessions(remote: string[] | null = null): Promise<LocalSessions> {
  const index = await SessionIndex.build();
  const repos = discoverRepos(index.all);
  const { live, liveKinds, liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const sessionGroups = groupSessionsByRepo(index.all);
  // Remote machines, when asked for. Merged into the SAME maps the local half
  // uses rather than kept alongside them, so every consumer — the running
  // section, the readiness badge, the attach action — works on a remote row
  // without knowing one exists. `liveKey` is what makes that safe.
  const warnings: string[] = [];
  const remotePanes = new Map<string, PaneState>();
  if (remote) {
    const sweep = sweepRemotes(remote);
    warnings.push(...sweep.warnings);
    const byHost = new Map<string, AgentSession[]>();
    for (const w of sweep.windows) {
      const s = remoteSession(w);
      const key = liveKey(s);
      if (w.placeholder) {
        livePlaceholders.add(key);
      } else {
        live.add(key);
        liveKinds.set(key, managedKind(w.name) ?? "resumed");
        liveWindows.set(key, { name: w.name, target: w.target });
      }
      remotePanes.set(key, {
        readiness: w.readiness,
        shells: w.shells,
        resetAt: w.limitResetAt === null ? null : Date.parse(w.limitResetAt),
      });
      const list = byHost.get(w.host);
      if (list) list.push(s);
      else byHost.set(w.host, [s]);
    }
    // One group per machine, named for it. `root` is the machine rather than a
    // path because that is what a remote group IS — the sessions over there are
    // in directories on a filesystem this process cannot see, so grouping them
    // by repo root would invent a shared identity they do not have.
    for (const [host, sessions] of [...byHost].sort(([a], [b]) => a.localeCompare(b))) {
      sessionGroups.push({ root: `${host}:`, name: host, sessions });
    }
  }
  return { index, repos, sessionGroups, live, liveKinds, liveWindows, livePlaceholders, remoteWarnings: warnings, remotePanes };
}

export async function loadModel(opts: LoadModelOptions): Promise<LoadedModel> {
  const provider = getProvider(opts.provider);
  // Invalidate any per-load backend caches so a refresh re-reads mutable state
  // (ADO's PR cache in particular — see Provider.beginLoad / ado.clearPrCache).
  provider.beginLoad?.();
  // The session index drives both the local views and (for backends that scope
  // to where you work, like GitHub) the fetch set, so build it up front. This is
  // the cheap, network-free local scan the App also polls on its own (see
  // loadLocalSessions) — reused here so the local half is computed one way.
  const [me, local] = await Promise.all([provider.getMe(), loadLocalSessions(opts.remote ?? null)]);
  const { index } = local;
  const identity = opts.identity ?? me;
  // Fetch scope: the session-derived repos plus any repo found under the path
  // context, so a backend that queries per repo (GitHub) also covers a repo
  // inside the target that has never hosted a session. Unconditional — the
  // repo *filter* below is display-only, so toggling it never refetches.
  const scopeRepos = opts.scopeRepos ?? [];
  const repos = mergeRepos(local.repos, scopeRepos);
  const repoScope = scopeRepos.length > 0 ? repoScopeKeys(scopeRepos) : null;
  const ctx = { identity, repos };
  const [{ items, currentIterationPath }, activePRs, reviewPRs, teamMembers] =
    await Promise.all([
      provider.fetchWorkItems(ctx),
      provider.fetchActivePRs(ctx),
      provider.fetchReviewPRs(ctx),
      provider.getTeamMembers(),
    ]);
  const { live, liveKinds, liveWindows, livePlaceholders } = local;

  // Snapshot the host session's open agent tabs so a future startup can lazily
  // restore them (browser-style). Cheap, idempotent, and no-op when that host
  // session isn't running — fine to run on every (re)load.
  captureRestore(index, opts.hostSession);

  // Collect sessions for a work item: via each PR's branch, plus any session
  // whose branch/worktree embeds the work-item id (covers items with no PR).
  // Used for both the assigned items and the PR-resolved items below.
  const withSessions = (it: Omit<WorkItem, "sessions">): WorkItem => {
    const seen = new Set<string>();
    const sessions: AgentSession[] = [];
    const add = (s: AgentSession) => {
      const key = `${s.source}:${s.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      sessions.push(s);
    };
    for (const pr of it.prs) {
      for (const s of index.forBranch(pr.branch)) add(s);
    }
    // Repo-scope the id-in-branch/cwd match for backends whose item ids collide
    // across repos (GitHub: it.project is the `owner/repo` slug, and issue
    // numbers are tiny). ADO ids are globally unique → unscoped (null).
    const itemRepo = opts.provider === "github" ? it.project : null;
    for (const s of index.forWorkItem(it.id, itemRepo)) add(s);
    sessions.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
    return { ...it, sessions };
  };

  const full: WorkItem[] = items.map(withSessions);

  const current = full.filter((i) => i.inCurrentSprint);
  const other = full.filter((i) => !i.inCurrentSprint);

  const byLastUsed = (a: AgentSession, b: AgentSession) =>
    b.lastUsed.getTime() - a.lastUsed.getTime();

  // PRs linked to a work item (PR view, upper section). Dedupe by PR id so a PR
  // shared across two items isn't listed twice.
  const linkedPrs: LinkedPR[] = [];
  const seenLinked = new Set<string>();
  for (const it of full) {
    for (const pr of it.prs) {
      // Hide finished PRs — the PR view is about work still in flight.
      if (pr.status === "completed" || pr.status === "abandoned") continue;
      if (seenLinked.has(prKey(pr))) continue;
      seenLinked.add(prKey(pr));
      const sessions = [...index.forBranch(pr.branch)].sort(byLastUsed);
      linkedPrs.push({
        ...pr,
        sessions,
        workItemId: it.id,
        workItemType: it.type,
        workItemTitle: it.title,
        workItemUrl: it.url,
      });
    }
  }

  // PRs already shown under a work item are not "orphans".
  const linkedPrIds = new Set(full.flatMap((i) => i.prs.map(prKey)));
  const orphanPrs: PRWithSessions[] = activePRs
    .filter((pr) => !linkedPrIds.has(prKey(pr)))
    .map((pr) => {
      const sessions = [...index.forBranch(pr.branch)].sort(byLastUsed);
      return { ...pr, sessions };
    });

  // ── Resolve work items for orphan PRs (the user's own PRs not yet linked) ──
  // Ask the backend which work items each orphan PR links to (ADO's PR→workitem
  // direction; GitHub has no equivalent and returns nothing). Surface those
  // items — with the surfacing PR attached and sessions resolved — and drop the
  // PRs that landed under one from the orphan list.
  let prLinked: WorkItem[] = [];
  let remainingOrphans = orphanPrs;

  if (orphanPrs.length > 0) {
    const { items: resolved, surfacedPrIds } = await provider.fetchWorkItemsForPRs(orphanPrs, {
      excludeWorkItemIds: new Set(full.map((i) => i.id)),
      currentIterationPath,
    });
    prLinked = resolved.map(withSessions);
    prLinked.sort((a, b) => a.id - b.id);
    remainingOrphans = orphanPrs.filter((pr) => !surfacedPrIds.has(pr.id));
  }

  // PRs awaiting the viewer's review (self or their teams). Drop any already
  // shown as a linked/created PR so each PR appears once across the view.
  const createdPrIds = new Set(activePRs.map(prKey));
  const reviewPrs: ReviewPRWithSessions[] = reviewPRs
    .filter((pr) => !linkedPrIds.has(prKey(pr)) && !createdPrIds.has(prKey(pr)))
    .map((pr) => {
      const sessions = [...index.forBranch(pr.branch)].sort(byLastUsed);
      return { ...pr, sessions };
    });

  // Fill in CI / merge-gate status + required-approval denominators for every PR
  // we'll display (work-item PRs and all three PR-view sections), in one pass.
  // enrichPrCI dedupes by id internally, so overlap across lists is harmless.
  await provider.enrichPrCI([
    ...full.flatMap((i) => i.prs),
    ...linkedPrs,
    ...reviewPrs,
    ...remainingOrphans,
    ...prLinked.flatMap((i) => i.prs),
  ]);

  const currentIterationName = currentIterationPath
    ? currentIterationPath.split("\\").pop() ?? currentIterationPath
    : null;

  // Group every local session by the main repo of its worktree (Sessions view) —
  // reused from the local scan above so grouping is defined once.
  const sessionGroups: RepoSessions[] = local.sessionGroups;

  // Reverse index for the Sessions view: which PR / work item each session
  // links to. Built from the already-resolved lists, richest source first, so a
  // session ends up with both its PR and work item when both are known. First
  // writer wins per field (`cur ?? patch`), so later, poorer sources only fill
  // gaps rather than clobbering a complete entry.
  const sessionLinks = new Map<string, SessionLink>();
  const linkSession = (s: AgentSession, patch: SessionLink) => {
    const key = `${s.source}:${s.id}`;
    const cur = sessionLinks.get(key);
    sessionLinks.set(key, {
      pr: cur?.pr ?? patch.pr,
      workItem: cur?.workItem ?? patch.workItem,
    });
  };
  // 1) Linked PRs carry both a PR and its work item — the richest source.
  for (const pr of linkedPrs)
    for (const s of pr.sessions)
      linkSession(s, {
        pr: { id: pr.id, url: pr.url },
        workItem: { id: pr.workItemId, url: pr.workItemUrl },
      });
  // 2) Work items fill in the WI for sessions matched by branch/worktree id
  //    alone (an item with no PR), plus PR-linked items not assigned to me.
  for (const it of [...current, ...other, ...prLinked])
    for (const s of it.sessions) linkSession(s, { workItem: { id: it.id, url: it.url } });
  // 3) Orphan / review PRs fill in the PR for sessions whose PR isn't WI-linked.
  for (const pr of [...remainingOrphans, ...reviewPrs])
    for (const s of pr.sessions) linkSession(s, { pr: { id: pr.id, url: pr.url } });

  return {
    provider: opts.provider,
    current,
    other,
    linkedPrs,
    reviewPrs,
    orphanPrs: remainingOrphans,
    prLinked,
    currentIterationName,
    liveTmux: live,
    liveKinds,
    liveWindows,
    livePlaceholders,
    remotePanes: local.remotePanes,
    repos,
    repoScope,
    sessionGroups,
    sessionLinks,
    me,
    identity,
    teamMembers,
  };
}
