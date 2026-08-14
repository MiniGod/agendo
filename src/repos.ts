// Derives the set of git repos the user actually works in by looking at where
// all their agent sessions live, and ranks them by session count. Used to let
// the user pick which repo to create a fresh worktree in.
import { existsSync } from "fs";
import { homedir } from "os";
import { join, dirname, basename } from "path";
import { isUnderRoot, normalizeCwd } from "./context.ts";
import type { AgentSession } from "./types.ts";

export interface RepoInfo {
  /** Absolute repo root (the main checkout, never a worktree path). */
  root: string;
  /** Display name (basename of root). */
  name: string;
  total: number;
  claude: number;
  copilot: number;
  codex: number;
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
      info = { root, name: basename(root), total: 0, claude: 0, copilot: 0, codex: 0 };
      byRoot.set(root, info);
    }
    info.total++;
    info[s.source]++;
  }
  return [...byRoot.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/**
 * Whether `dir` is itself a git checkout. `repoRootForCwd` falls back to the
 * input path when its walk-up finds no `.git`, so callers that want to know
 * "did the walk-up actually land on a repo?" must re-check the result — a
 * non-repo root can't host a `git worktree add`.
 */
export function isGitCheckout(dir: string): boolean {
  return existsSync(join(normalizeCwd(dir), ".git"));
}

/**
 * A zero-count repo entry for a folder that has no sessions yet. Not exported:
 * `ensureRepoAtTop` is the only way to get one, so a synth entry can never
 * appear without going through the dedupe.
 *
 * `basename` is empty for the filesystem root, so fall back to the path itself
 * — `agendo /` would otherwise render a blank name cell in the picker.
 */
function synthRepo(root: string): RepoInfo {
  return { root, name: basename(root) || root, total: 0, claude: 0, copilot: 0, codex: 0 };
}

/**
 * Return `repos` with the repo rooted at `root` guaranteed present and ranked
 * FIRST. If it already exists (has sessions elsewhere), it's moved to the top
 * without duplicating; otherwise a synthesized zero-count entry is prepended.
 * Used by the path-scoped picker so the scoped folder is always offerable.
 *
 * Matching goes through `normalizeCwd` rather than a raw `===`: `root` is
 * typically `path.resolve`d from a CLI arg while the `repos` roots are derived
 * from recorded session cwds, so the same directory routinely arrives spelled
 * differently (trailing slash, `..` or doubled-slash segments). A raw compare
 * would miss the match and break the no-duplicate promise above — a zero-count
 * synth stacked directly on top of the real entry for the same repo.
 */
/**
 * The repo root the fresh-session picker falls back to when nothing else is
 * known — bare `agendo` on an install with no sessions at all. That fallback is
 * an INFERENCE from the process cwd, not a statement of intent like a `[path]`
 * argument, so it must not climb as far as `repoRootForCwd` willingly would.
 *
 * `repoRootForCwd` walks up to the nearest ancestor `.git`. On a machine whose
 * $HOME is itself a checkout — chezmoi, yadm, a bare dotfiles repo, all common —
 * that resolves ANY non-repo cwd to $HOME. The picker would then offer the
 * dotfiles repo as a perfectly good checkout, and since it IS one, the
 * "no git checkout here" hint stays silent and enter-enter-enter runs
 * `git worktree add` into `$HOME/.claude/worktrees/<name>`: a worktree of the
 * user's dotfiles dropped inside the live Claude Code config dir that
 * `sessions.ts` scans for sessions. Nobody asked for that, and nothing warned.
 *
 * So accept the walk-up only while it stays strictly BELOW $HOME. If it reached
 * $HOME or climbed past it, hand back the cwd itself — not a checkout, so the
 * picker's run-in-place path and its hint take over. Working in the dotfiles
 * repo on purpose still works; it just has to be said out loud as `agendo ~`,
 * which takes the scoped branch and never reaches here.
 */
export function bootstrapRepoRoot(cwd: string): string {
  const base = normalizeCwd(cwd);
  const root = repoRootForCwd(base);
  // The cwd IS the checkout — nothing was inferred, so nothing to second-guess.
  if (root === base) return root;
  // `isUnderRoot(home, root)` ⇔ root is $HOME itself or an ancestor of it.
  return isUnderRoot(homedir(), root) ? base : root;
}

export function ensureRepoAtTop(repos: RepoInfo[], root: string): RepoInfo[] {
  const target = normalizeCwd(root);
  const existing = repos.find((r) => normalizeCwd(r.root) === target);
  const rest = repos.filter((r) => normalizeCwd(r.root) !== target);
  // Synthesize from the NORMALIZED root so the display name is a real basename
  // (`basename("/a/b/")` is fine, but `basename("/a/b/.")` is not) and so the
  // worktree is created at a clean path.
  return [existing ?? synthRepo(target), ...rest];
}
