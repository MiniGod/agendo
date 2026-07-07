// Assembles the view model: work items (from the configured backend) joined
// with on-disk agent sessions (matched by PR branch) and live-tmux status.
import { getProvider } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { liveTargets, liveManagedPaths, sessionName, managedKind, type SessionKind } from "./tmux.ts";
import { captureRestore, resolveWindowSession } from "./restore.ts";
import { discoverRepos, repoRootForCwd, type RepoInfo } from "./repos.ts";
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
  /** How each currently-running session was launched, by canonical name (for UI badges). */
  liveKinds: Map<string, SessionKind>;
  /** The live tmux window each running session occupies, by canonical name (for pane reads). */
  liveWindows: Map<string, string>;
  /**
   * Canonical names of sessions that have a live but dormant restore placeholder
   * window (idle bash awaiting a keypress, not yet running). Not in `liveTmux`;
   * lets the Sessions view badge them as restored-but-unopened.
   */
  livePlaceholders: Set<string>;
  /** Repos ranked by session count, for the fresh-session repo picker. */
  repos: RepoInfo[];
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
}

export function isRunning(s: AgentSession, live: Set<string>): boolean {
  return live.has(sessionName(s));
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
  liveWindows: Map<string, string>;
  livePlaceholders: Set<string>;
} {
  return reconcileLive(liveTargets(), liveManagedPaths(), allSessions);
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
  managed: { name: string; cwd: string; placeholder: boolean }[],
  sessions: AgentSession[],
): { live: Set<string>; liveKinds: Map<string, SessionKind>; liveWindows: Map<string, string>; livePlaceholders: Set<string> } {
  const live = base;
  const liveKinds = new Map<string, SessionKind>();
  const liveWindows = new Map<string, string>();
  const placeholders = new Set<string>();
  for (const { name, cwd, placeholder } of managed) {
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
    liveWindows.set(canon, name);
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

export async function loadModel(opts: LoadModelOptions): Promise<LoadedModel> {
  const provider = getProvider(opts.provider);
  // Invalidate any per-load backend caches so a refresh re-reads mutable state
  // (ADO's PR cache in particular — see Provider.beginLoad / ado.clearPrCache).
  provider.beginLoad?.();
  // The session index drives both the local views and (for backends that scope
  // to where you work, like GitHub) the fetch set, so build it up front.
  const [me, index] = await Promise.all([provider.getMe(), SessionIndex.build()]);
  const identity = opts.identity ?? me;
  const repos = discoverRepos(index.all);
  const ctx = { identity, repos };
  const [{ items, currentIterationPath }, activePRs, reviewPRs, teamMembers] =
    await Promise.all([
      provider.fetchWorkItems(ctx),
      provider.fetchActivePRs(ctx),
      provider.fetchReviewPRs(ctx),
      provider.getTeamMembers(),
    ]);
  const { live, liveKinds, liveWindows, livePlaceholders } = refreshLiveTmux(index.all);

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
    for (const s of index.forWorkItem(it.id)) add(s);
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

  // Group every local session by the main repo of its worktree (Sessions view).
  const groupMap = new Map<string, AgentSession[]>();
  for (const s of index.all) {
    const root = repoRootForCwd(s.cwd);
    const arr = groupMap.get(root) ?? [];
    arr.push(s);
    groupMap.set(root, arr);
  }
  const sessionGroups: RepoSessions[] = [...groupMap.entries()]
    .map(([root, sessions]) => ({
      root,
      name: basename(root),
      sessions: sessions.sort(byLastUsed),
    }))
    // Most recently active repo first.
    .sort((a, b) => b.sessions[0].lastUsed.getTime() - a.sessions[0].lastUsed.getTime());

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
    repos,
    sessionGroups,
    sessionLinks,
    me,
    identity,
    teamMembers,
  };
}
