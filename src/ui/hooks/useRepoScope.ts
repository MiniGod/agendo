import { useMemo } from "react";
import type { LoadedModel } from "../../model.ts";
import {
  repoRootForCwd,
  bootstrapRepoRoot,
  ensureRepoAtTop,
  isGitCheckout,
  type RepoInfo,
} from "../../repos.ts";
import { isUnderRoot, normalizeCwd } from "../../context.ts";
import type { FreshTarget } from "../targets.ts";

/**
 * Path- and repo-scoping for the list views and the fresh-session pickers.
 * Extracted verbatim from App: the four memos below sat consecutively in the
 * component body and are called from the same position, so hook order — and
 * every dependency array — is unchanged.
 */
export function useRepoScope({
  model,
  filterRoot,
  globalView,
  cloned,
}: {
  model: LoadedModel | null;
  filterRoot: string | null;
  globalView: boolean;
  cloned: RepoInfo[];
}) {
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

  // `worktreeRepos` stays internal: reposForTarget and anyHostableRepo are the
  // two answers callers actually want, and App never destructured it.
  return { scoped, inScope, scopedRepos, reposForTarget, anyHostableRepo };
}
