// Adopting an EXISTING worktree for a launch, as opposed to creating one
// (src/worktree.ts). `agendo launch --worktree=<path>` names one outright, and
// `--name <slug>` lands in `.claude/worktrees/<slug>` when that already exists.
// Either way the directory has to be a worktree git itself registers, never
// just a directory that happens to sit where a worktree would: the point of
// adopting is to recover work that exists only in that checkout, and a plain
// folder has no branch to recover onto.
//
// Nothing here mutates the target. No reset, no stash, no checkout: a dirty
// tree and an unexpected branch are REPORTED (see `AdoptedWorktree`) and the
// caller decides what to say about them. The uncommitted state is the whole
// reason the issue exists (#37), so it is the one thing this must never touch.
import { spawnSync } from "child_process";
import { existsSync, realpathSync } from "fs";

/** One record of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  /** Commit sha, absent for a bare entry. */
  head?: string;
  /** Branch name without `refs/heads/`, absent when detached or bare. */
  branch?: string;
  detached: boolean;
  bare: boolean;
}

/**
 * Parse `git worktree list --porcelain`: one attribute per line, records
 * separated by a blank line, the MAIN worktree first. Only the attributes the
 * adopt path reads are modelled (`locked` / `prunable` and their reasons are
 * skipped, not rejected), so a newer git adding a line does not break this.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const raw of porcelain.split("\n")) {
    const line = raw.trimEnd();
    if (!line) {
      cur = undefined;
      continue;
    }
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "worktree") {
      cur = { path: value, detached: false, bare: false };
      entries.push(cur);
      continue;
    }
    if (!cur) continue; // an attribute before any `worktree` line: not ours to guess at
    if (key === "HEAD") cur.head = value;
    else if (key === "branch") cur.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "bare") cur.bare = true;
  }
  return entries;
}

/**
 * Number of entries in `git status --porcelain` output — one line per changed,
 * added, deleted, renamed or untracked path. Untracked files count: they are
 * exactly the work that exists nowhere but in that directory.
 */
export function countDirty(status: string): number {
  return status.split("\n").filter((l) => l.trim() !== "").length;
}

/** What was found at an adopted path. Paths are real (symlinks resolved). */
export interface AdoptedWorktree {
  path: string;
  /** The repo's main checkout, per git — used to tie a `--name` adopt to the launching repo. */
  mainRoot: string;
  /** Branch checked out there, or null on a detached HEAD. */
  branch: string | null;
  /** Count of uncommitted entries (`git status --porcelain`), untracked included. */
  dirty: number;
}

export interface AdoptResult {
  worktree?: AdoptedWorktree;
  error?: string;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Check that `path` is a worktree root git knows about, and read what is in it.
 * Refuses a missing directory, a directory outside any repository, and — the
 * case `--name` used to fall into silently — a directory that merely exists
 * where a worktree would be, without being one. A SUBdirectory of a worktree is
 * refused too: the session's cwd is what `agendo list` attributes it by, and
 * the attribution wants the root.
 */
export function inspectWorktree(path: string): AdoptResult {
  if (!existsSync(path)) return { error: `no such directory: ${path}` };
  const real = realpathOr(path);
  const list = spawnSync("git", ["-C", real, "worktree", "list", "--porcelain"], { encoding: "utf-8" });
  if (list.status !== 0) {
    const why = (list.stderr || "").trim().split("\n")[0];
    return { error: `${path} is not inside a git repository${why ? ` (${why})` : ""}` };
  }
  const entries = parseWorktreeList(list.stdout || "");
  const main = entries[0];
  const hit = entries.find((e) => realpathOr(e.path) === real);
  if (!main || !hit) {
    return {
      error:
        `${path} exists but is not a registered worktree of ${main?.path ?? "this repository"} ` +
        `(not in \`git worktree list\`)`,
    };
  }
  const status = spawnSync("git", ["-C", real, "status", "--porcelain"], { encoding: "utf-8" });
  return {
    worktree: {
      path: real,
      mainRoot: realpathOr(main.path),
      branch: hit.branch ?? null,
      dirty: status.status === 0 ? countDirty(status.stdout || "") : 0,
    },
  };
}
