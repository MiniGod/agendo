// Assembles the view model: work items (from the configured backend) joined
// with on-disk agent sessions (matched by PR branch) and live-tmux status.
import { getProvider } from "./provider.ts";
import { SessionIndex } from "./sessions.ts";
import { captureRestore } from "./restore.ts";
import { discoverRepos, mergeRepos, repoScopeKeys } from "./repos.ts";
import type { PRWithSessions, RepoSessions, WorkItem } from "./types.ts";
import { refreshLiveTmux } from "./model/live.ts";
import { groupSessionsByRepo } from "./model/scope.ts";
import {
  iterationName, linkedPrKeys, linkedPrsOf, orphanPrsOf, reviewPrsOf, sessionLinksOf, withSessions,
  type SessionLookup,
} from "./model/join.ts";
import type { Provider } from "./provider.ts";
import type { LoadedModel, LoadModelOptions, LocalSessions } from "./model/types.ts";

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

/**
 * Resolve work items for orphan PRs (the user's own PRs not yet linked): ask
 * the backend which work items each orphan PR links to (ADO's PR→workitem
 * direction; GitHub has no equivalent and returns nothing). Surface those
 * items — with the surfacing PR attached and sessions resolved — and drop the
 * PRs that landed under one from the orphan list.
 */
async function resolveOrphans(
  provider: Provider, index: SessionLookup, scopeToRepo: boolean,
  orphanPrs: PRWithSessions[], full: WorkItem[], currentIterationPath: string | null,
): Promise<{ prLinked: WorkItem[]; remainingOrphans: PRWithSessions[] }> {
  if (orphanPrs.length === 0) return { prLinked: [], remainingOrphans: orphanPrs };
  const { items: resolved, surfacedPrIds } = await provider.fetchWorkItemsForPRs(orphanPrs, {
    excludeWorkItemIds: new Set(full.map((i) => i.id)),
    currentIterationPath,
  });
  const prLinked = resolved.map((it) => withSessions(index, scopeToRepo, it));
  prLinked.sort((a, b) => a.id - b.id);
  return { prLinked, remainingOrphans: orphanPrs.filter((pr) => !surfacedPrIds.has(pr.id)) };
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

  // The joins live in ./model/join.ts; see withSessions for the repo scoping.
  const scopeToRepo = opts.provider === "github";
  const full: WorkItem[] = items.map((it) => withSessions(index, scopeToRepo, it));
  const current = full.filter((i) => i.inCurrentSprint);
  const other = full.filter((i) => !i.inCurrentSprint);

  const linkedPrs = linkedPrsOf(index, full);
  const linkedPrIds = linkedPrKeys(full);
  const orphanPrs = orphanPrsOf(index, activePRs, linkedPrIds);
  const { prLinked, remainingOrphans } = await resolveOrphans(
    provider, index, scopeToRepo, orphanPrs, full, currentIterationPath,
  );
  const reviewPrs = reviewPrsOf(index, reviewPRs, linkedPrIds, activePRs);

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

  const currentIterationName = iterationName(currentIterationPath);

  // Group every local session by the main repo of its worktree (Sessions view) —
  // reused from the local scan above so grouping is defined once.
  const sessionGroups: RepoSessions[] = local.sessionGroups;
  const sessionLinks = sessionLinksOf(linkedPrs, [...current, ...other, ...prLinked], [...remainingOrphans, ...reviewPrs]);

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
