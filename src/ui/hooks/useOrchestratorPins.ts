import { useEffect, useMemo, useState } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import type { RepoInfo } from "../../repositories/index.ts";
import { scopeRepoRoot } from "../../repositories/scopeRepo.ts";
import { isUnderRoot } from "../../app/context.ts";
import { repoOrchestratorStatuses } from "../../orchestration/repoOrchestrator.ts";
import { hasUnmatchedMarker, orchestratorFacts, pendingOrchestrator } from "../../launch/existingOrchestrator.ts";
import { liveManagedPaths } from "../../runtime/tmux/index.ts";
import { orchestratorPins, type OrchestratorPins } from "../models/orchestratorPins.ts";
import { liveOf, modelSessions } from "../actions/orchestratorFlow.ts";

/**
 * The repos the pinned orchestrator block speaks for: the scope's own repo when
 * it IS one; else every checkout found under the scoped folder plus every repo
 * with sessions there; else, unscoped, every repo with sessions anywhere.
 *
 * Each candidate goes through `scopeRepoRoot`, which drops what is not a
 * checkout (a plain folder sessions ran in) and folds a linked worktree onto
 * its main checkout — a worktree has no orchestrator of its own, so listing it
 * would only ever say "none" about a repo that may well have one.
 */
export function pinRoots(p: {
  scopeRepo: string | null;
  scoped: boolean;
  filterRoot: string | null;
  discovered: readonly RepoInfo[];
  known: readonly RepoInfo[];
}): string[] {
  if (p.scopeRepo) return [p.scopeRepo];
  const candidates = p.scoped && p.filterRoot
    ? [...p.discovered, ...p.known.filter((r) => isUnderRoot(r.root, p.filterRoot!))]
    : p.known;
  const roots = candidates.map((r) => scopeRepoRoot(r.root)).filter((r): r is string => r !== null);
  return [...new Set(roots)];
}

const NONE_PENDING: ReadonlyMap<string, string> = new Map();

/**
 * The pinned orchestrator block for the Sessions view, or null when there is no
 * repo in scope to show one for. Recomputed when the model changes — the
 * markers it also reads only change when an orchestrator is launched, and a
 * launch reloads the model.
 *
 * One read is not in the model: the managed windows of an orchestrator too new
 * to have a session (see `pendingOrchestrator`), which the block shows as
 * starting. It is a tmux read, so it runs in an effect, and only while some
 * repo in view has no orchestrator AND a marker names one the index has no
 * session for. That is the gap between a launch and its agent's first
 * transcript line — but also any marker whose transcript is long gone, which
 * nothing can tell apart from a fresh one, so in practice the read is usually
 * made: one `list-panes`, once per model reload, not per render.
 *
 * Null before the model loads too, which nothing sees: the list (and the hint
 * line that reads `repoScope` off this) is only mounted once there is one.
 */
export function useOrchestratorPins({
  model,
  scopeRepo,
  scoped,
  filterRoot,
  discoveredRepos,
}: {
  model: LoadedModel | null;
  scopeRepo: string | null;
  scoped: boolean;
  filterRoot: string | null;
  discoveredRepos: RepoInfo[];
}): OrchestratorPins | null {
  const known = model?.repos;
  const roots = useMemo(
    () => pinRoots({ scopeRepo, scoped, filterRoot, discovered: discoveredRepos, known: known ?? [] }),
    [scopeRepo, scoped, filterRoot, discoveredRepos, known],
  );
  const read = useMemo(() => {
    if (!model) return null;
    const sessions = modelSessions(model);
    const facts = orchestratorFacts(liveOf(model));
    const statuses = repoOrchestratorStatuses(roots, sessions, facts);
    return { statuses, facts, gap: statuses.some((s) => !s.primary) && hasUnmatchedMarker(sessions, facts) };
  }, [model, roots]);
  const [pending, setPending] = useState(NONE_PENDING);
  useEffect(() => {
    if (!read?.gap) {
      setPending(NONE_PENDING);
      return;
    }
    const managed = liveManagedPaths();
    const found = new Map<string, string>();
    for (const s of read.statuses) {
      const t = s.primary ? null : pendingOrchestrator(s.root, managed, read.facts);
      if (t) found.set(s.root, t.name);
    }
    setPending(found);
  }, [read]);
  return useMemo(() => {
    return read && orchestratorPins(read.statuses, scopeRepo !== null, pending);
  }, [read, scopeRepo, pending]);
}
