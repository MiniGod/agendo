// Identity keys, and the repo-scope filters built on them.
//
// One pure predicate per list, shared by the TUI and the CLI so the two can
// never disagree about what is in scope.
import { basename } from "path";
import { repoRootForCwd } from "../repos.ts";
import type { AgentSession, ProviderName, PullRequest, RepoSessions, WorkItem } from "../types.ts";
import type { LoadedModel } from "./types.ts";

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
