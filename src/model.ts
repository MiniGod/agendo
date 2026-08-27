// Assembles the view model: work items (from the configured backend) joined
// with on-disk agent sessions (matched by PR branch) and live-tmux status.
import { getProvider } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { captureRestore } from "./restore.ts";
import { discoverRepos, mergeRepos, repoScopeKeys } from "./repos.ts";
import type {
  AgentSession, LinkedPR, PRWithSessions, RepoSessions,
  ReviewPRWithSessions, WorkItem,
} from "./types.ts";
import { refreshLiveTmux } from "./model/live.ts";
import { groupSessionsByRepo, prKey } from "./model/scope.ts";
import type { LoadedModel, LoadModelOptions, LocalSessions, SessionLink } from "./model/types.ts";

// Three pieces live in src/model/: types.ts (the shapes), live.ts (what tmux
// says is running, and reconciling that onto a loaded model) and scope.ts (the
// identity keys and the repo-scope filters). What is left here is the assembly
// itself — the backend fetch joined to on-disk sessions.
//
// This file stays the one import path, so the re-exports below keep the surface
// it had before.
export type { LoadedModel, LoadModelOptions, LocalSessions, SessionLink } from "./model/types.ts";
export { isRunning, reconcileLive, refreshLiveTmux } from "./model/live.ts";
export {
  filterModelByRepos, groupSessionsByRepo, itemInRepoScope, itemKey, prInRepoScope, prKey,
} from "./model/scope.ts";

export async function loadLocalSessions(): Promise<LocalSessions> {
  const index = await SessionIndex.build();
  const repos = discoverRepos(index.all);
  const { live, liveKinds, liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const sessionGroups = groupSessionsByRepo(index.all);
  return { index, repos, sessionGroups, live, liveKinds, liveWindows, livePlaceholders };
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
  const [me, local] = await Promise.all([provider.getMe(), loadLocalSessions()]);
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
    repos,
    repoScope,
    sessionGroups,
    sessionLinks,
    me,
    identity,
    teamMembers,
  };
}
