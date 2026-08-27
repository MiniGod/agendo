// Where a clone should land. Given a parsed URL and a target directory, either
// point at a checkout of that repo the user already has, or pick a free name
// beside it — preferring the former, so pasting a URL twice does not silently
// produce a second copy.
import { spawnSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { dirname, join } from "path";
import { normalizeCwd } from "../context.ts";
import { parseRepoUrl } from "./url.ts";

/**
 * Directory name for a cloned repo: the repo name reduced to a safe basename.
 * Leading dots go too, so an oddly-named repo can never produce a hidden
 * directory (or a literal `.git`) inside the user's target folder.
 */
export function cloneDirName(repo: string): string {
  const name = repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  return name || "repo";
}

// Cached for the process lifetime, exactly as github.ts caches its own repo
// refs. findMatchingCheckout runs on every keystroke in the URL prompt (the
// preview tells the user *before* enter whether their repo is already here), and
// without this each keystroke would spawn one `git` per sibling checkout.
const originCache = new Map<string, string | null>();

/** `origin` of a checkout, or null when there's no origin / it isn't a repo. */
function gitOrigin(dir: string): string | null {
  const cached = originCache.get(dir);
  if (cached !== undefined) return cached;
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf-8" });
  const origin = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  originCache.set(dir, origin);
  return origin;
}

/**
 * Whether `dir` is a repo's MAIN checkout — `.git` is a directory there, and a
 * *file* in a linked worktree (and in a submodule). The distinction matters
 * because `git remote get-url origin` answers identically in both: a sibling
 * worktree (`~/git/repo-feature`) would otherwise match a pasted URL for
 * `~/git/repo` and be handed downstream as a repo root, where `createWorktree`
 * would nest a worktree inside a worktree.
 */
function isMainCheckout(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/** Direct children of `dir` that are main checkouts, plus `dir` itself. */
function checkoutCandidates(dir: string): string[] {
  const out: string[] = [];
  if (isMainCheckout(dir)) out.push(dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    if (isMainCheckout(p)) out.push(p);
  }
  return out;
}

/**
 * An existing checkout of the same repo at or directly under `parent`, matched
 * on `parseRepoUrl`'s canonical key — so a checkout in a differently-named
 * folder, or one cloned over SSH when the pasted URL was HTTPS, still counts.
 * Reusing it is always preferable to a second copy of the same repository.
 *
 * `readOrigin` is injectable so this is testable without a git binary.
 */
export function findMatchingCheckout(
  parent: string,
  key: string,
  readOrigin: (dir: string) => string | null = gitOrigin,
): string | null {
  for (const dir of checkoutCandidates(normalizeCwd(parent))) {
    const origin = readOrigin(dir);
    if (!origin) continue;
    if (parseRepoUrl(origin)?.key === key) return dir;
  }
  return null;
}

/**
 * The checkout `dir` sits in (itself, or the nearest ancestor), or null when it
 * sits in none. This is the "is this a place we may clone into" test: the clone
 * lands as a direct child of `dir`, so anywhere inside a repo would mean a
 * nested repository in that repo's working tree.
 *
 * The walk stops *below* `$HOME` and the filesystem root, and that boundary is
 * the whole reason this isn't `repoRootForCwd`. Keeping dotfiles in a git repo
 * at `~` is a common setup, and an unbounded walk-up would find `~/.git` from
 * every directory the user owns — silently disabling cloning across the entire
 * machine. `$HOME` is not a project checkout in any sense that matters here.
 */
export function enclosingCheckout(dir: string, home: string): string | null {
  const stop = normalizeCwd(home);
  let cur = normalizeCwd(dir);
  while (cur && cur !== "/" && cur !== stop) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

/** Cap on the `repo-2`, `repo-3`, … search — see freeCloneDest. */
const MAX_NAME_ATTEMPTS = 20;

/**
 * A directory under `parent` that `git clone` can write into: `<base>`, else
 * `<base>-2`, `<base>-3`, … A path that doesn't exist is free; so is one that
 * exists but is an empty directory (git clones into those happily). Returns null
 * after MAX_NAME_ATTEMPTS rather than inventing an unrecognizable name — at that
 * point something is wrong that the user should hear about.
 *
 * Only reached once findMatchingCheckout has ruled out "this repo is already
 * here", so a suffix always means a *name* collision with something else.
 */
export function freeCloneDest(parent: string, base: string): string | null {
  const root = normalizeCwd(parent);
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const path = join(root, n === 1 ? base : `${base}-${n}`);
    if (!existsSync(path)) return path;
    try {
      if (statSync(path).isDirectory() && readdirSync(path).length === 0) return path;
    } catch {
      // Unreadable — treat as taken and keep looking.
    }
  }
  return null;
}
