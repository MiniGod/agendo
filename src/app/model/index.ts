// Assembles the view model: work items (from the configured backend) joined
// with on-disk agent sessions (matched by PR branch) and live-tmux status.
import { getProvider } from "../../providers/index.ts";
import { SessionIndex } from "../../sessions/index.ts";
import { captureRestore } from "../../runtime/restore/index.ts";
import { discoverRepos, mergeRepos, repoScopeKeys } from "../../repositories/index.ts";
import type { PRWithSessions, WorkItem } from "../../shared/types.ts";
import { refreshLiveTmux } from "./live.ts";
import { groupSessionsByRepo } from "./scope.ts";
import {
  iterationName, linkedPrKeys, linkedPrsOf, orphanPrsOf, reviewPrsOf, sessionLinksOf, withSessions,
  type SessionLookup,
} from "./join.ts";
import type { Provider } from "../../providers/index.ts";
import type { LoadedModel, LoadModelOptions, LocalSessions } from "./types.ts";

// Three pieces live in src/app/model/: types.ts (the shapes), live.ts (what tmux
// says is running, and reconciling that onto a loaded model) and scope.ts (the
// identity keys and the repo-scope filters). What is left here is the assembly
// itself — the backend fetch joined to on-disk sessions.
//
// This file stays the one import path, so the re-exports below keep the surface
// it had before.
export type { LoadedModel, LoadModelOptions, LocalSessions, SessionLink } from "./types.ts";
export { isRunning, reconcileLive, refreshLiveTmux } from "./live.ts";
export {
  filterModelByRepos, groupSessionsByRepo, itemInRepoScope, itemKey, prInRepoScope, prKey,
} from "./scope.ts";

/**
 * One independently useful result from a model load. The TUI applies these as
 * they arrive; CLI callers keep using `loadModel`, which awaits the same
 * pipeline and receives only its final, internally consistent snapshot.
 */
export interface ModelStage {
  kind: "local" | "identity" | "items" | "team" | "complete";
  update(previous: LoadedModel | null): LoadedModel;
}

type StageListener = (stage: ModelStage) => void;

const LOADING_IDENTITY = { id: "", displayName: "Loading identity…", uniqueName: "" };

function localFields(local: LocalSessions) {
  return {
    liveTmux: local.live,
    liveKinds: local.liveKinds,
    liveWindows: local.liveWindows,
    livePlaceholders: local.livePlaceholders,
    placeholderWindows: local.placeholderWindows,
    liveWindowLocations: local.liveWindowLocations,
    sessionGroups: local.sessionGroups,
  };
}

/** Build the session-usable shell published before any backend request finishes. */
function modelFromLocal(opts: LoadModelOptions, local: LocalSessions, previous: LoadedModel | null): LoadedModel {
  const scopeRepos = opts.scopeRepos ?? [];
  const repos = mergeRepos(local.repos, scopeRepos);
  const repoScope = scopeRepos.length > 0 ? repoScopeKeys(scopeRepos) : null;
  if (previous?.provider === opts.provider) {
    return { ...previous, ...localFields(local), repos, repoScope };
  }
  return {
    provider: opts.provider,
    current: [], other: [], linkedPrs: [], reviewPrs: [], orphanPrs: [], prLinked: [],
    currentIterationName: null,
    ...localFields(local),
    repos,
    repoScope,
    sessionLinks: new Map(),
    me: LOADING_IDENTITY,
    identity: opts.identity ?? LOADING_IDENTITY,
    teamMembers: [],
  };
}

function completeWithFreshLocal(previous: LoadedModel | null, complete: LoadedModel): LoadedModel {
  if (!previous || previous.provider !== complete.provider) return complete;
  return {
    ...complete,
    liveTmux: previous.liveTmux,
    liveKinds: previous.liveKinds,
    liveWindows: previous.liveWindows,
    livePlaceholders: previous.livePlaceholders,
    placeholderWindows: previous.placeholderWindows,
    liveWindowLocations: previous.liveWindowLocations,
    repos: previous.repos,
    sessionGroups: previous.sessionGroups,
  };
}

export async function loadLocalSessions(): Promise<LocalSessions> {
  const index = await SessionIndex.build();
  const repos = discoverRepos(index.all);
  const { live, liveKinds, liveWindows, livePlaceholders, placeholderWindows, liveWindowLocations } =
    refreshLiveTmux(index.all);
  const sessionGroups = groupSessionsByRepo(index.all);
  return {
    index, repos, sessionGroups, live, liveKinds, liveWindows, livePlaceholders, placeholderWindows, liveWindowLocations,
  };
}

interface ItemStage {
  current: WorkItem[];
  other: WorkItem[];
  linkedPrs: ReturnType<typeof linkedPrsOf>;
  currentIterationName: string | null;
}

function joinItems(
  index: SessionLookup,
  scopeToRepo: boolean,
  items: Array<Omit<WorkItem, "sessions">>,
  currentIterationPath: string | null,
): ItemStage {
  const full = items.map((it) => withSessions(index, scopeToRepo, it));
  return {
    current: full.filter((i) => i.inCurrentSprint),
    other: full.filter((i) => !i.inCurrentSprint),
    linkedPrs: linkedPrsOf(index, full),
    currentIterationName: iterationName(currentIterationPath),
  };
}

function applyItems(
  previous: LoadedModel | null,
  base: LoadedModel,
  data: ItemStage,
  me: LoadedModel["me"],
  identity: LoadedModel["identity"],
): LoadedModel {
  const model = previous ?? base;
  const allItems = [...data.current, ...data.other, ...model.prLinked];
  return {
    ...model,
    ...data,
    me,
    identity,
    sessionLinks: sessionLinksOf(data.linkedPrs, allItems, [...model.orphanPrs, ...model.reviewPrs]),
  };
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

export async function loadModelProgressively(opts: LoadModelOptions, onStage: StageListener): Promise<LoadedModel> {
  const provider = getProvider(opts.provider);
  // Invalidate any per-load backend caches so a refresh re-reads mutable state
  // (ADO's PR cache in particular — see Provider.beginLoad / ado.clearPrCache).
  provider.beginLoad?.();

  // Publish the cheap local half without waiting for identity or any tracker
  // request. This makes the Sessions tab usable during cold boot.
  const localPromise = loadLocalSessions().then((local) => {
    captureRestore(local.index, opts.hostSession);
    onStage({ kind: "local", update: (previous) => modelFromLocal(opts, local, previous) });
    return local;
  });
  const [me, local] = await Promise.all([provider.getMe(), localPromise]);
  const { index } = local;
  const identity = opts.identity ?? me;
  const base = { ...modelFromLocal(opts, local, null), me, identity };
  onStage({
    kind: "identity",
    update: (previous) => ({ ...(previous ?? base), me, identity }),
  });

  // Fetch scope: the session-derived repos plus any repo found under the path
  // context, so a backend that queries per repo (GitHub) also covers a repo
  // inside the target that has never hosted a session. Unconditional — the
  // repo *filter* below is display-only, so toggling it never refetches.
  const scopeRepos = opts.scopeRepos ?? [];
  const repos = mergeRepos(local.repos, scopeRepos);
  const repoScope = scopeRepos.length > 0 ? repoScopeKeys(scopeRepos) : null;
  const ctx = { identity, repos };

  // Every independent backend call starts together. Work items and the team
  // roster publish as soon as their own request finishes; the PR view waits for
  // the three data sets it genuinely needs to classify linked/review/orphan PRs.
  const itemPromise = provider.fetchWorkItems(ctx).then((result) => {
    const data = joinItems(index, opts.provider === "github", result.items, result.currentIterationPath);
    onStage({ kind: "items", update: (previous) => applyItems(previous, base, data, me, identity) });
    return { ...result, data };
  });
  const teamPromise = provider.getTeamMembers().then((teamMembers) => {
    onStage({
      kind: "team",
      update: (previous) => ({ ...(previous ?? base), teamMembers }),
    });
    return teamMembers;
  });
  const [{ currentIterationPath, data }, activePRs, reviewPRs, teamMembers] = await Promise.all([
    itemPromise,
    provider.fetchActivePRs(ctx),
    provider.fetchReviewPRs(ctx),
    teamPromise,
  ]);
  const { live, liveKinds, liveWindows, livePlaceholders, placeholderWindows, liveWindowLocations } = local;

  // The joins live in ./model/join.ts; see withSessions for the repo scoping.
  const scopeToRepo = opts.provider === "github";
  const { current, other, linkedPrs, currentIterationName } = data;
  const full = [...current, ...other];
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

  const sessionLinks = sessionLinksOf(linkedPrs, [...current, ...other, ...prLinked], [...remainingOrphans, ...reviewPrs]);

  const complete: LoadedModel = {
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
    placeholderWindows,
    liveWindowLocations,
    repos,
    repoScope,
    sessionGroups: local.sessionGroups,
    sessionLinks,
    me,
    identity,
    teamMembers,
  };
  onStage({
    kind: "complete",
    update: (previous) => completeWithFreshLocal(previous, complete),
  });
  return complete;
}

/** Atomic facade for commands and other non-interactive callers. */
export async function loadModel(opts: LoadModelOptions): Promise<LoadedModel> {
  return loadModelProgressively(opts, () => {});
}
