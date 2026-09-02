// Derives the set of git repos the user actually works in — either by looking at
// where all their agent sessions live (discoverRepos, ranked by session count),
// or by walking a path context downward for checkouts (discoverGitReposUnder).
// Used to pick which repo to create a fresh worktree in, and to scope the work
// item / PR views to the repos inside `agendo <path>`.
import { existsSync, readdirSync } from "fs";
import { spawnSync } from "child_process";
import { homedir } from "os";
import { join, dirname, basename } from "path";
import { isUnderRoot, normalizeCwd } from "./context.ts";
import { parseGithubRemote } from "./github.ts";
import { orchestratorRoles } from "./orchestrator.ts";
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

/** Collapse duplicate/trailing slashes so the segment split can't produce holes. */
function normalizeSlashes(p: string): string {
  return p.replace(/\/+/g, "/").replace(/\/+$/, "");
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

/**
 * Where to run a GLOBAL orchestrator — the one session that belongs to no single
 * repository. It coordinates repo orchestrators through the launcher's CLI and
 * never opens a checkout, so its cwd is only ever a vantage point; the goal is
 * simply that it not LOOK like it lives in one repo, which would invite it to
 * start running git there — the one thing its prompt forbids.
 *
 * So: the scope root when the launcher has one (that is literally the user's
 * declared "everything I'm working on"), else the deepest directory containing
 * every known repo. Anything degenerate — no repos, or roots so unrelated their
 * only common ancestor is `/` — falls back to `fallback` (the caller's cwd).
 *
 * EVERY route ends in `outsideCheckout`, the fallback included. All three can
 * land in one: a single known repo makes the common parent the repo itself,
 * `agendo ~/git/myrepo` declares a scope root that is a repo root, and the
 * fallback is wherever the user happened to type the command — which, with no
 * sessions indexed yet, is most often a repo they were just working in. Sitting
 * inside a checkout is exactly what makes a global orchestrator look local.
 */
export function globalOrchestratorCwd(
  repoRoots: string[],
  fallback: string,
  scopeRoot?: string | null,
): string {
  const base = scopeRoot ? normalizeSlashes(scopeRoot) : commonParent(repoRoots);
  // A DECLARED scope root is judged by the disk alone, never by membership in
  // `repoRoots`. The TUI's scoped repo list is seeded with the scope root itself
  // (`ensureRepoAtTop` in useRepoScope.ts) so the user's declared directory can't
  // fall off the picker — which means membership would report every scoped
  // launcher's root as a checkout and step out of a directory that merely HOLDS
  // repos. `agendo ~/git` would coordinate from `~`.
  const known = scopeRoot ? [] : repoRoots;
  const chosen = base && base !== "/" ? outsideCheckout(base, known) : null;
  if (chosen) return chosen;
  // `null` means both "nothing to compute from" and "stepping out would answer
  // `/`" — neither is a place to run anything, so the caller's cwd is the last
  // resort, and it earns no exemption from the step-out.
  const here = normalizeSlashes(fallback);
  return outsideCheckout(here, known) ?? here;
}

/**
 * The nearest ancestor of `dir` — `dir` itself included — that is not a git
 * checkout; null when the walk runs out of directories before finding one.
 *
 * It KEEPS GOING rather than stepping once, because checkouts nest: a
 * chezmoi/yadm user has `$HOME` itself under version control (the case
 * `bootstrapRepoRoot` below already guards against), so one step out of
 * `~/myrepo` lands in another repo — and "not inside a checkout" is the entire
 * property this function owes its caller. Each pass strictly shortens the path,
 * so `/` terminates it.
 *
 * Answering `/` would be worse than answering the checkout, so exhaustion is
 * reported as null: a signal to try somewhere else, with only the last caller in
 * the chain settling for the checkout itself.
 */
function outsideCheckout(dir: string, repoRoots: string[]): string | null {
  let at = dir;
  for (;;) {
    // A known root, or an unlisted checkout — a launcher whose repo has no
    // sessions yet contributes no root to compare against, so ask the disk too.
    // Membership is worth keeping alongside it because the disk answer can be a
    // false NEGATIVE (a checkout on a mount that is momentarily away); the caller
    // decides when the root list is trustworthy enough to consult.
    const isCheckout = repoRoots.some((r) => normalizeSlashes(r) === at) || existsSync(join(at, ".git"));
    if (!isCheckout) return at;
    const up = dirname(at);
    if (up === "/" || up === at) return null;
    at = up;
  }
}

/**
 * Group all sessions by repo root and rank by total session count.
 *
 * GLOBAL orchestrators are skipped, and that filter belongs HERE rather than at
 * each call site. Their cwd is a vantage point picked precisely because it is not
 * a checkout (`globalOrchestratorCwd`), and `repoRootForCwd` answers with the
 * bare directory when it finds no `.git` above — so one would enter this list as
 * a repo that isn't one. Everything downstream then compounds it: the TUI repo
 * picker offers a directory `git worktree add` cannot work in, and the next
 * `globalOrchestratorCwd` sees its own predecessor's vantage point among the
 * "repo roots", treats it as a checkout to step out of, and lands one directory
 * higher — every relaunch walking further from the repos it coordinates.
 */
export function discoverRepos(sessions: AgentSession[]): RepoInfo[] {
  const byRoot = new Map<string, RepoInfo>();
  const roles = orchestratorRoles();
  for (const s of sessions) {
    if (roles.get(s.id) === "global") continue;
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
    codex: 0,
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

/**
 * The identifiers a backend could use for a checkout, lowercased: its `origin`
 * remote's GitHub `owner/repo` slug, or an Azure DevOps repo name (from the
 * `…/_git/<repo>` https form or the `v3/<org>/<project>/<repo>` ssh one). The
 * GitHub slug goes through github.ts's `parseGithubRemote` — the one host-anchored
 * parser the rest of the codebase already shares (sessions.ts, clone.ts) — so a
 * look-alike host like `evilgithub.com` can't contribute a key. It's a type-only
 * dependency in the other direction, so there is no runtime cycle. The remote
 * forms are matched independently, since a target uses one tracker or the other.
 * The directory basename is only a *fallback*, for a checkout with no `origin`
 * (or one on an unrecognized host): a GitHub slug already names the owner, and
 * adding the bare repo name next to it would let a same-named repo under a
 * different owner (a fork of it, say) match the scope through
 * `PullRequest.repositoryName`.
 */
function repoKeys(root: string): string[] {
  const cached = keyCache.get(root);
  if (cached) return cached;
  const keys = new Set<string>();
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
  if (r.status === 0) {
    const url = r.stdout.trim();
    // git@github.com:owner/repo.git · https://github.com/owner/repo(.git)
    const gh = parseGithubRemote(url);
    if (gh) keys.add(`${gh.owner}/${gh.repo}`);
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
