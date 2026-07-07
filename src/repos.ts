// Derives the set of git repos the user actually works in by looking at where
// all their agent sessions live, and ranks them by session count. Used to let
// the user pick which repo to create a fresh worktree in.
import { existsSync } from "fs";
import { join, dirname, basename } from "path";
import type { AgentSession } from "./types.ts";

export interface RepoInfo {
  /** Absolute repo root (the main checkout, never a worktree path). */
  root: string;
  /** Display name (basename of root). */
  name: string;
  total: number;
  claude: number;
  copilot: number;
}

// Worktrees created by Claude Code / this launcher live at
// <repoRoot>/.claude/worktrees/<name>. Strip that to get the main repo.
const WORKTREE_RE = /^(.+?)\/\.claude\/worktrees\/[^/]+\/?$/;

const rootCache = new Map<string, string>();

/** Best-effort repo root for a working directory. */
export function repoRootForCwd(cwd: string): string {
  const cached = rootCache.get(cwd);
  if (cached) return cached;

  let root = cwd;
  const m = cwd.match(WORKTREE_RE);
  if (m) {
    root = m[1];
  } else {
    // Walk up to the nearest ancestor that is a git checkout.
    let dir = cwd;
    while (dir && dir !== "/" && dir !== ".") {
      if (existsSync(join(dir, ".git"))) {
        root = dir;
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  rootCache.set(cwd, root);
  return root;
}

/** Group all sessions by repo root and rank by total session count. */
export function discoverRepos(sessions: AgentSession[]): RepoInfo[] {
  const byRoot = new Map<string, RepoInfo>();
  for (const s of sessions) {
    const root = repoRootForCwd(s.cwd);
    let info = byRoot.get(root);
    if (!info) {
      info = { root, name: basename(root), total: 0, claude: 0, copilot: 0 };
      byRoot.set(root, info);
    }
    info.total++;
    if (s.source === "claude") info.claude++;
    else if (s.source === "copilot") info.copilot++;
  }
  return [...byRoot.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** A zero-count repo entry for a folder that has no sessions yet. */
export function synthRepo(root: string): RepoInfo {
  return { root, name: basename(root), total: 0, claude: 0, copilot: 0 };
}

/**
 * Return `repos` with the repo rooted at `root` guaranteed present and ranked
 * FIRST. If it already exists (has sessions elsewhere), it's moved to the top
 * without duplicating; otherwise a synthesized zero-count entry is prepended.
 * Used by the path-scoped picker so the scoped folder is always offerable.
 */
export function ensureRepoAtTop(repos: RepoInfo[], root: string): RepoInfo[] {
  const existing = repos.find((r) => r.root === root);
  const rest = repos.filter((r) => r.root !== root);
  return [existing ?? synthRepo(root), ...rest];
}
