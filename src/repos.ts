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

/**
 * Deepest directory that contains every path in `paths`, or null if they share
 * nothing but the filesystem root (or the list is empty). Pure path arithmetic —
 * no filesystem access, so it works on repo roots that may since have moved.
 */
export function commonParent(paths: string[]): string | null {
  const split = paths.map((p) => normalizeSlashes(p).split("/").filter(Boolean));
  if (split.length === 0) return null;
  const first = split[0];
  let n = first.length;
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < n && i < parts.length && parts[i] === first[i]) i++;
    n = i;
  }
  return n > 0 ? `/${first.slice(0, n).join("/")}` : null;
}

/** Collapse duplicate/trailing slashes so the segment split can't produce holes. */
function normalizeSlashes(p: string): string {
  return p.replace(/\/+/g, "/").replace(/\/+$/, "");
}

/**
 * Where to run a GLOBAL orchestrator — the one session that belongs to no single
 * repository. It coordinates repo orchestrators through the launcher's CLI and
 * never opens a checkout, so its cwd is only ever a vantage point; the goal is
 * simply that it not LOOK like it lives in one repo (which would invite it to
 * start running git there, the one thing its prompt forbids).
 *
 * So: the scope root when the launcher has one (that is literally the user's
 * declared "everything I'm working on"), else the deepest directory containing
 * every known repo. A single known repo makes that directory the repo itself, so
 * step up to its parent. Anything degenerate — no repos, or roots so unrelated
 * their only common ancestor is `/` — falls back to `fallback` (the caller's cwd).
 */
export function globalOrchestratorCwd(
  repoRoots: string[],
  fallback: string,
  scopeRoot?: string | null,
): string {
  if (scopeRoot) return scopeRoot;
  const parent = commonParent(repoRoots);
  if (!parent || parent === "/") return fallback;
  // Exactly one repo (or several nested under one) → the "common parent" IS a
  // repo root. Sitting inside it would make the global orchestrator look local.
  if (repoRoots.some((r) => normalizeSlashes(r) === parent)) {
    const up = dirname(parent);
    return up === "/" || up === parent ? fallback : up;
  }
  return parent;
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
