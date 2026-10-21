// Is a launcher's scope ONE repository, or a folder that holds several?
//
// The answer decides what the coordinator keys do. `agendo ~/git/agendo` is a
// statement about one repo, so its coordinator is that repo's orchestrator and
// `G` means the same thing as `O`. `agendo ~/git` is a statement about a fleet,
// and `G` keeps meaning the global orchestrator above it.
//
// Deliberately NOT `repoRootForCwd`. That one is a best-effort grouping key: it
// falls back to the input path when its walk finds no checkout, and resolves a
// linked worktree to the worktree itself. Both are wrong here — a plain folder
// would classify as a "repo" of itself, and a worktree outside
// `.claude/worktrees/` would be a repo of its own with an orchestrator of its own.
import { existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { isUnderRoot, normalizeCwd } from "../app/context.ts";

// `<root>/.claude/worktrees/<name>`, or anywhere inside one. Unlike the pattern
// `repoRootForCwd` uses, a subdirectory of the worktree matches too: scoping to
// `…/worktrees/foo/src` is still scoping to the repo that worktree belongs to.
const WORKTREE_DIR_RE = /^(.+?)\/\.claude\/worktrees\/[^/]+(?:\/.*)?$/;

/** `.git` at `dir`: "dir" for a real git dir, "file" for a `gitdir:` pointer, null for none. */
function dotGitKind(dir: string): "dir" | "file" | null {
  try {
    return statSync(join(dir, ".git")).isDirectory() ? "dir" : "file";
  } catch {
    return null;
  }
}

/**
 * The main checkout a linked worktree belongs to, from its `.git` pointer file
 * and the `commondir` its git dir names — or null when the pointer leads
 * somewhere that isn't a main checkout's `.git` (a submodule, whose git dir has
 * no `commondir`, or a worktree of a bare repo). Both of those ARE repositories
 * in their own right, so the caller then treats the directory itself as one.
 */
function linkedWorktreeMain(dir: string): string | null {
  try {
    const pointer = readFileSync(join(dir, ".git"), "utf-8").match(/^gitdir:\s*(.+?)\s*$/m);
    if (!pointer) return null;
    const gitDir = resolve(dir, pointer[1]);
    const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf-8").trim());
    return basename(common) === ".git" ? dirname(common) : null;
  } catch {
    return null;
  }
}

/** The repo `dir` is the top of, or null when it is not the top of a checkout. */
function checkoutRootAt(dir: string): string | null {
  const kind = dotGitKind(dir);
  if (kind === null) return null;
  return kind === "dir" ? dir : (linkedWorktreeMain(dir) ?? dir);
}

/**
 * The MAIN checkout for a root `repoRootForCwd` produced: a linked worktree
 * (anywhere — not only under `.claude/worktrees/`, which that function already
 * folds) becomes the checkout it belongs to; anything else stays as it is.
 */
export function mainCheckoutOf(root: string): string {
  return dotGitKind(root) === "file" ? (linkedWorktreeMain(root) ?? root) : root;
}

/**
 * The repo root a launcher scope names, or null when the scope is a plain
 * folder. A scope IS a repo when its directory is a checkout's root, sits
 * inside one, or is a worktree of one — and the root returned is always the
 * MAIN checkout, because that is where a repo's orchestrator runs.
 *
 * The walk up stops short of $HOME, as `bootstrapRepoRoot`'s does and for the
 * same reason: on a machine whose home directory is a dotfiles checkout, every
 * folder under it is "inside a repo", and `agendo ~/git` would quietly turn into
 * a scope over the dotfiles repo. $HOME itself still counts when it is the scope
 * named — `agendo ~` says so out loud.
 */
export function scopeRepoRoot(dir: string, home: string = homedir()): string | null {
  const base = normalizeCwd(dir);
  // A path that isn't there is no scope at all — not the checkout it would sit in.
  if (!existsSync(base)) return null;
  const wt = base.match(WORKTREE_DIR_RE);
  // `mainCheckoutOf`, not `wt[1]` as it stands: a `.claude/worktrees/` nested in
  // a linked worktree belongs to the checkout that worktree is of.
  if (wt && dotGitKind(wt[1]) !== null) return mainCheckoutOf(wt[1]);
  for (let d = base; ; d = dirname(d)) {
    // `isUnderRoot(home, d)` ⇔ d is $HOME or one of its ancestors.
    if (d !== base && isUnderRoot(home, d)) return null;
    const root = checkoutRootAt(d);
    if (root) return root;
    if (dirname(d) === d) return null;
  }
}
