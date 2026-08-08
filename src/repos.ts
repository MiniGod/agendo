// Derives the set of git repos the user actually works in — either by looking at
// where all their agent sessions live (discoverRepos, ranked by session count),
// or by walking a path context downward for checkouts (discoverGitReposUnder).
// Used to pick which repo to create a fresh worktree in, and to scope the work
// item / PR views to the repos inside `agendo <path>`.
import { existsSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
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

// ── path context → the repos inside it ────────────────────────────────────────

/** Safety valve for the downward walk: a target like `~` or `/` degrades into a
 *  partial result instead of hanging on a pathological tree. */
const MAX_SCAN_DIRS = 20_000;

const scanCache = new Map<string, RepoInfo[]>();

/**
 * Every git repo at or under `target`: the target itself when it's a checkout,
 * otherwise every `.git`-bearing directory below it (direct children or deeply
 * nested), and only if the downward walk finds none, the enclosing checkout the
 * target sits inside (`~/git/proj/packages/web` means `~/git/proj`). Preferring
 * what's below matters when an unrelated ancestor happens to be a repo — `~`
 * tracked as dotfiles must not make `agendo ~/git` scope to the dotfiles repo
 * instead of the projects in it. Pure fs — the same `existsSync(.git)` marker
 * test `repoRootForCwd` uses, no `git` shell-outs. Session counts are zero:
 * these repos are found by walking the filesystem, not by having hosted a
 * session, so callers merge them with `discoverRepos`' counted entries (see
 * mergeRepos).
 *
 * Never descends into a directory it already identified as a repo (a checkout's
 * `.claude/worktrees/<name>` copies belong to that root, not to repos of their
 * own), skips dot-directories and `node_modules`, and never follows symlinked
 * directories — so a link back up to an ancestor can't loop. Cached per target,
 * like `rootCache` above; pass `fresh` to rescan and replace the cached result
 * (the launcher does that on an explicit `r` refresh, so a repo cloned into the
 * target after launch enters the scope without a restart).
 */
export function discoverGitReposUnder(target: string, fresh = false): RepoInfo[] {
  const cached = fresh ? undefined : scanCache.get(target);
  if (cached) return cached;
  const asRepo = (root: string): RepoInfo => ({
    root,
    name: basename(root),
    total: 0,
    claude: 0,
    copilot: 0,
  });
  const found: RepoInfo[] = [];
  // The checkout the target is *in*, if any: itself when it carries `.git`, the
  // nearest ancestor checkout when it sits below a repo root, the main repo when
  // it's a worktree (all three are exactly repoRootForCwd's walk).
  const enclosing = repoRootForCwd(target);
  if (enclosing === target && existsSync(join(target, ".git"))) {
    // The target IS a checkout — it speaks for itself, and its nested worktrees
    // belong to it, so there's nothing below worth walking for.
    found.push(asRepo(target));
  } else {
    let budget = MAX_SCAN_DIRS;
    const queue = [target];
    while (queue.length > 0 && budget-- > 0) {
      const dir = queue.shift()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable directory — skip it rather than fail the scan
      }
      for (const e of entries) {
        // isDirectory() is false for a symlink, so links are never followed.
        if (!e.isDirectory()) continue;
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        const child = join(dir, e.name);
        if (existsSync(join(child, ".git"))) found.push(asRepo(child));
        else queue.push(child);
      }
    }
    // Nothing below: fall back to the checkout the target sits inside, if any —
    // `agendo <repo>/packages/web` or a worktree path still means that repo.
    if (found.length === 0 && existsSync(join(enclosing, ".git"))) found.push(asRepo(enclosing));
  }
  found.sort((a, b) => a.name.localeCompare(b.name));
  scanCache.set(target, found);
  return found;
}

/** Union two repo lists by root, keeping whichever entry carries the session
 *  counts (the path-discovered ones are all zero). */
export function mergeRepos(a: RepoInfo[], b: RepoInfo[]): RepoInfo[] {
  const byRoot = new Map<string, RepoInfo>();
  for (const r of [...a, ...b]) {
    const prev = byRoot.get(r.root);
    if (!prev || prev.total < r.total) byRoot.set(r.root, r);
  }
  return [...byRoot.values()];
}

const keyCache = new Map<string, string[]>();

/**
 * The identifiers a backend could use for a checkout, lowercased: its `origin`
 * remote's GitHub `owner/repo` slug, or an Azure DevOps repo name (from the
 * `…/_git/<repo>` https form or the `v3/<org>/<project>/<repo>` ssh one).
 * Mirrors the slug parsing in github.ts's `repoRef`, kept here so repo-scope
 * filtering needs no backend — the remote forms are matched
 * independently, since a target uses one tracker or the other. The directory
 * basename is only a *fallback*, for a checkout with no `origin` (or one on an
 * unrecognized host): a GitHub slug already names the owner, and adding the bare
 * repo name next to it would let a same-named repo under a different owner (a
 * fork of it, say) match the scope through `PullRequest.repositoryName`.
 */
/** Undo the percent-encoding a remote URL carries — an ADO repo named `My Repo`
 *  clones from `…/_git/My%20Repo`, but its PRs report `repositoryName: "My Repo"`.
 *  Malformed escapes are left as-is rather than throwing. */
function decodePath(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function repoKeys(root: string): string[] {
  const cached = keyCache.get(root);
  if (cached) return cached;
  const keys = new Set<string>();
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
  if (r.status === 0) {
    const url = r.stdout.trim();
    // git@github.com:owner/repo.git · https://github.com/owner/repo(.git)
    const gh = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/);
    if (gh) keys.add(`${gh[1]}/${gh[2]}`);
    // https://dev.azure.com/org/project/_git/repo · https://org.visualstudio.com/project/_git/repo
    const ado = url.match(/\/_git\/([^/]+?)(?:\.git)?\/?$/);
    if (ado) keys.add(decodePath(ado[1]));
    // ADO over SSH carries no `_git` segment, just the v3 triple:
    // git@ssh.dev.azure.com:v3/org/project/repo · git@vs-ssh.visualstudio.com:v3/…
    const adoSsh = url.match(/(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/[^/]+\/[^/]+\/(.+?)(?:\.git)?\/?$/);
    if (adoSsh) keys.add(decodePath(adoSsh[1]));
  }
  if (keys.size === 0) keys.add(basename(root));
  const out = [...keys].map((k) => k.toLowerCase());
  keyCache.set(root, out);
  return out;
}

/** The match set repo-scoped filtering of work items / PRs tests against — every
 *  identifier of every in-scope repo (see model.ts's prInRepoScope). */
export function repoScopeKeys(repos: RepoInfo[]): Set<string> {
  const set = new Set<string>();
  for (const r of repos) for (const k of repoKeys(r.root)) set.add(k);
  return set;
}
