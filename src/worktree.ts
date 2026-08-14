// Creates git worktrees for fresh sessions, following the user's convention of
// <repoRoot>/.claude/worktrees/<name> with a `worktree-…` branch name.
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

/** kebab-case a work item title for use in a branch name. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Default branch name for a fresh session on a work item. */
export function defaultBranch(workItemId: number, title: string): string {
  const slug = slugify(title);
  return slug ? `worktree-${slug}-${workItemId}` : `worktree-${workItemId}`;
}

/**
 * Worktree directory name for a branch: drop the leading "worktree-", then
 * reduce to a clean slug — every run of non-alphanumeric characters (slashes,
 * dots, spaces, …) collapses to a single dash, with no leading/trailing dash.
 */
export function worktreeDirName(branch: string): string {
  return branch
    .replace(/^worktree-/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Worktree directory path for a branch. */
export function worktreePath(root: string, branch: string): string {
  return join(root, ".claude", "worktrees", worktreeDirName(branch));
}

/**
 * The first branch name based on `base` whose worktree directory is free:
 * `base`, then `base-2`, `base-3`, …
 *
 * For callers whose name describes a ROLE rather than a task, so two launches in
 * the same repo would otherwise derive the identical name. `createWorktree`
 * treats an already-existing path as success (it's deliberately idempotent for
 * the work-item / PR flows, where re-launching the same item should land back in
 * the same checkout), so without this the second launch silently inherits the
 * first one's working tree and branch.
 *
 * A candidate must have BOTH a free directory and no existing branch:
 *  - The directory is what two launches would actually have to share, and it's
 *    what makes this agree across entry points that spell the branch differently
 *    (the CLI's `worktree-orchestrator` and the TUI's `orchestrator` both reduce
 *    to `…/worktrees/orchestrator`, see `worktreeDirName`).
 *  - The branch matters because `git worktree remove` (or delete-dir + prune)
 *    frees the directory but KEEPS the branch. Checking only the directory would
 *    then hand back the base name, and `createWorktree`'s "branch already exists"
 *    retry would check that stale branch out — starting the new session on the
 *    previous one's commits instead of a fresh branch off origin/HEAD.
 *
 * Inherently a check-then-act, so two launches racing on the same instant can
 * both pick the same name. That degrades safely: the loser's `git worktree add`
 * fails (the path exists and the branch is checked out elsewhere), `createWorktree`
 * reports the error, and the launch aborts loudly instead of quietly sharing a
 * working tree.
 */
export function freeWorktreeBranch(root: string, base: string): string {
  const free = (b: string) => !existsSync(worktreePath(root, b)) && !branchExists(root, b);
  if (free(base)) return base;
  for (let n = 2; n <= 99; n++) {
    if (free(`${base}-${n}`)) return `${base}-${n}`;
  }
  // 99 taken names for one base is pathological. Unlike a bare pid (which can
  // recur and would need probing of its own), pid + millisecond is unique by
  // construction, so this last resort can't hand back an occupied name.
  return `${base}-${process.pid}-${Date.now().toString(36)}`;
}

/**
 * Whether `branch` already exists locally in `root`. `--verify --quiet` exits
 * non-zero for a missing ref; we also require a non-empty sha so a git shim that
 * exits 0 without resolving anything reads as "absent" rather than "exists".
 */
function branchExists(root: string, branch: string): boolean {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    encoding: "utf-8",
  });
  return r.status === 0 && !!r.stdout?.trim();
}

/** The remote default branch (e.g. origin/main), or HEAD as a fallback. */
function defaultBaseRef(root: string): string {
  const r = spawnSync(
    "git",
    ["-C", root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    { encoding: "utf-8" },
  );
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : "HEAD";
}

export interface WorktreeResult {
  path: string;
  created: boolean;
  error?: string;
}

/**
 * Ensure a worktree for `branch` exists under `root`. Creates a new branch off
 * the repo's default ref; if the branch already exists, checks it out into the
 * worktree instead. Idempotent if the worktree path already exists.
 */
export function createWorktree(root: string, branch: string): WorktreeResult {
  const path = worktreePath(root, branch);
  if (existsSync(path)) return { path, created: false };

  const base = defaultBaseRef(root);
  const add = spawnSync(
    "git",
    ["-C", root, "worktree", "add", "-b", branch, path, base],
    { encoding: "utf-8" },
  );
  if (add.status === 0) return { path, created: true };

  // Branch may already exist — retry without -b (check it out into worktree).
  const retry = spawnSync(
    "git",
    ["-C", root, "worktree", "add", path, branch],
    { encoding: "utf-8" },
  );
  if (retry.status === 0) return { path, created: true };

  return {
    path,
    created: false,
    error: (add.stderr || "").trim() || (retry.stderr || "").trim() || "git worktree add failed",
  };
}

/**
 * Check out an existing PR's source branch into a worktree (for reviewing or
 * resuming work on the PR). Unlike createWorktree, this is based on the PR's
 * own branch at origin — never a fresh branch off the default ref. Fetches the
 * remote ref first, then prefers a local branch tracking origin/<branch>,
 * falling back to an existing local branch, then a detached checkout.
 */
export function checkoutWorktree(root: string, prBranch: string): WorktreeResult {
  const path = worktreePath(root, prBranch);
  if (existsSync(path)) return { path, created: false };

  // Best-effort: make sure origin/<branch> is up to date before we base on it.
  spawnSync("git", ["-C", root, "fetch", "origin", prBranch], { encoding: "utf-8" });
  const remote = `origin/${prBranch}`;

  // 1) New local branch tracking the remote PR branch.
  const track = spawnSync(
    "git",
    ["-C", root, "worktree", "add", "--track", "-b", prBranch, path, remote],
    { encoding: "utf-8" },
  );
  if (track.status === 0) return { path, created: true };

  // 2) Local branch already exists — check it out into the worktree.
  const existing = spawnSync("git", ["-C", root, "worktree", "add", path, prBranch], { encoding: "utf-8" });
  if (existing.status === 0) return { path, created: true };

  // 3) Detached checkout at the remote ref (works even with no local branch).
  const detached = spawnSync("git", ["-C", root, "worktree", "add", "--detach", path, remote], { encoding: "utf-8" });
  if (detached.status === 0) return { path, created: true };

  return {
    path,
    created: false,
    error:
      (track.stderr || "").trim() ||
      (existing.stderr || "").trim() ||
      (detached.stderr || "").trim() ||
      "git worktree add failed",
  };
}
