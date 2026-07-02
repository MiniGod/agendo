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
