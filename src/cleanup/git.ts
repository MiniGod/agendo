// The git probe behind the cleanup view: is a checkout dirty, does it hold
// commits no remote has, and is its branch merged. Every call is an async spawn
// of `git -C <dir>` so the TUI keeps drawing while a slow repo answers; none of
// it reads ref files directly (that is src/repositories/gitRefs.ts, which the
// TUI must not reach — see test/gitrefsReach.test.ts).
//
// "Merged" has to survive squash merges, which leave no ancestry behind. It is
// decided offline, in three steps, cheapest first:
//   1. ancestry — the branch tip is reachable from the base;
//   2. tree — some base commit since the merge base has exactly the branch
//      tip's tree (a squash of a branch that was up to date with the base);
//   3. patch-id — the branch's whole diff from the merge base has the same
//      `git patch-id --verbatim` as one base commit (a squash onto a base that
//      moved on elsewhere). Verbatim, not --stable: --stable ignores whitespace,
//      so a later re-indent — which changes what Python does — would read as
//      already merged and be deleted unasked.
// A false "unmerged" (the base later rewrote the same lines) only costs a
// second confirmation; nothing here can produce a false "merged". That holds
// only for the raw bytes, so every patch is taken with the user's diff
// configuration switched off (PATCH_FLAGS): a textconv driver or an external
// diff tool can print nothing at all for a change git still has to keep.
import { spawn } from "child_process";
import { existsSync } from "fs";
import { realpath } from "fs/promises";
import { join } from "path";
import { managedWorktreeOf } from "./rows.ts";
import type { GitState } from "./types.ts";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** How many base commits since the merge base the squash checks look at. */
const SQUASH_WINDOW = 400;

/**
 * The bytes git stores, whatever textconv, external-diff, colour or submodule
 * settings the user configured. `--submodule=short` matters as much as the
 * rest: under `diff.submodule=log` a bump prints as a log, which patch-id skips
 * as commit text, so a branch that bumped a submodule would match a base
 * commit that did not.
 */
const PATCH_FLAGS = ["--binary", "--no-textconv", "--no-ext-diff", "--no-color", "--ignore-submodules=none", "--submodule=short"];

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

const spawnGit = (dir: string, args: string[], bin = "git") =>
  spawn(bin, ["-C", dir, ...args], { env: { ...process.env, ...GIT_ENV }, stdio: ["pipe", "pipe", "pipe"] });

/** Run `git -C <dir> …args`, never prompting, resolving with the exit code instead of throwing. */
export function git(dir: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnGit(dir, args);
    } catch (e) {
      resolve({ code: 127, stdout: "", stderr: String(e) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => resolve({ code: 127, stdout, stderr: stderr || String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {}); // a git that exits before reading its input
    child.stdin.end(input ?? "");
  });
}

async function out(dir: string, args: string[]): Promise<string | null> {
  const r = await git(dir, args);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  return (await out(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== null;
}

/** One `git worktree list --porcelain` entry. */
export interface WorktreeEntry {
  path: string;
  branch: string | null;
}

/** The repo's worktrees, main checkout first; empty when `dir` is not in a repo. */
export async function listWorktrees(dir: string): Promise<WorktreeEntry[]> {
  const raw = await out(dir, ["worktree", "list", "--porcelain"]);
  if (raw === null) return [];
  const entries: WorktreeEntry[] = [];
  for (const block of raw.split(/\n\n+/)) {
    const path = block.match(/^worktree (.+)$/m)?.[1];
    if (!path) continue;
    entries.push({ path, branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? null });
  }
  return entries;
}

/** The remote default branch to judge merges against: origin/HEAD, else origin/master, else origin/main. */
export async function baseRef(dir: string): Promise<string | null> {
  const head = await out(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head;
  for (const ref of ["origin/master", "origin/main"]) if (await refExists(dir, ref)) return ref;
  return null;
}

/**
 * The patch-ids of what `git <args>` prints (`log -p`, `diff`), one per patch.
 * The patch text is piped straight from one git into `git patch-id` and never
 * held here: a few hundred base commits with binary assets would otherwise be
 * hundreds of MB of base85 in the TUI's memory. Empty when either side fails —
 * a git too old for `--verbatim` included, which only ever reads as unmerged.
 * `idArgs` (the reading side) and `srcBin` (the writing side's binary) are
 * swappable so a test can make either one fail.
 */
export function patchIds(dir: string, args: string[], idArgs = ["patch-id", "--verbatim"], srcBin = "git"): Promise<string[]> {
  return new Promise((resolve) => {
    let src;
    let ids;
    try {
      src = spawnGit(dir, args, srcBin);
      ids = spawnGit(dir, idArgs);
    } catch {
      src?.kill();
      resolve([]);
      return;
    }
    let stdout = "";
    let failed = false;
    const reader = ids;
    // A writer that never started never ends the reader's input: end it here.
    src.on("error", () => {
      failed = true;
      reader.stdin.destroy();
      reader.kill();
    });
    ids.on("error", () => (failed = true));
    ids.stdin.on("error", () => {}); // patch-id gone early: its own exit code says so
    src.stdout.pipe(ids.stdin);
    src.stderr.resume();
    ids.stderr.resume();
    ids.stdout.on("data", (d) => (stdout += d));
    const srcDone = new Promise<number>((r) => src.on("close", (c) => r(c ?? 1)));
    ids.on("close", async (code) => {
      // A reader that quit early leaves the writer blocked on a full pipe for good.
      if (failed || code !== 0) src.kill();
      const srcCode = await srcDone;
      const ok = !failed && code === 0 && srcCode === 0;
      resolve(ok ? stdout.split("\n").map((l) => l.split(" ")[0]).filter(Boolean) : []);
    });
  });
}

/** Whether `ref`'s changes since its merge base with `base` landed on `base` as a squash. */
export async function squashMerged(dir: string, ref: string, base: string): Promise<boolean> {
  const mb = await out(dir, ["merge-base", base, ref]);
  if (!mb) return false;
  const range = `${mb}..${base}`;
  const tree = await out(dir, ["rev-parse", `${ref}^{tree}`]);
  const trees = (await out(dir, ["log", `-n${SQUASH_WINDOW}`, "--format=%T", range])) ?? "";
  if (tree && trees.split("\n").includes(tree)) return true;
  if (tree && tree === (await out(dir, ["rev-parse", `${mb}^{tree}`]))) return true; // nothing left that the base lacks
  const [mine] = await patchIds(dir, ["diff", ...PATCH_FLAGS, mb, ref]);
  if (!mine) return false;
  const theirs = await patchIds(dir, ["log", `-n${SQUASH_WINDOW}`, "-p", ...PATCH_FLAGS, "--no-merges", "--format=commit %H", range]);
  return theirs.includes(mine);
}

/** Whether `ref` is merged into `base`, by ancestry or as a squash. */
export async function isMerged(dir: string, ref: string, base: string | null): Promise<boolean> {
  if (!base) return false;
  if ((await git(dir, ["merge-base", "--is-ancestor", ref, base])).code === 0) return true;
  return squashMerged(dir, ref, base);
}

/** Commits on `ref` that its upstream lacks, else that `origin/<branch>` lacks, else that no remote has. */
export async function aheadCount(dir: string, ref: string, branch: string | null): Promise<number> {
  const upstream = branch ? await out(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]) : null;
  const tracked = upstream ?? (branch && (await refExists(dir, `origin/${branch}`)) ? `origin/${branch}` : null);
  const args = tracked ? ["rev-list", "--count", `${tracked}..${ref}`] : ["rev-list", "--count", ref, "--not", "--remotes"];
  return Number(await out(dir, args)) || 0;
}

/**
 * Files status is told not to look at — `update-index --skip-worktree` (tag S)
 * or `--assume-unchanged` (a lowercase tag), the usual way to keep a local
 * config out of commits — that are on disk, where an edit to them may sit. A
 * sparse checkout's S entries are not on disk, and hold nothing.
 */
async function hiddenFrom(dir: string): Promise<string[]> {
  const r = await git(dir, ["ls-files", "-v", "-z"]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\0")
    .filter((e) => /^(S|[a-z]) /.test(e))
    .map((e) => e.slice(2))
    .filter((p) => existsSync(join(dir, p)));
}

/** Ignored output any checkout regenerates, so losing it loses nothing. */
const REGENERABLE = new Set(["node_modules", "dist", "build", "out", "coverage", "target", ".cache", ".next", ".turbo", ".venv", "venv", "__pycache__"]);

/**
 * A wholly ignored directory comes back as one `name/` entry, and only that
 * shape is regenerable output: an ignored `build/prod.env` inside a tracked
 * `build/` is a file somebody wrote, not something a build makes again.
 */
const regenerable = (path: string) => path.endsWith("/") && REGENERABLE.has(path.slice(0, -1).split("/").pop() ?? "");

/**
 * `status --porcelain --ignored`: the dirty entries, and the ignored ones worth
 * keeping. Untracked files and submodules are asked for explicitly: a user's
 * `status.showUntrackedFiles=no` would otherwise hide exactly the files a
 * plain `git worktree remove` then deletes without asking.
 */
async function statusOf(dir: string): Promise<{ dirty: number; changed: string[]; ignored: string[]; error?: string }> {
  // Not `out()`: its trim would eat the leading blank of a first ` M path`, and the path's first letter with it.
  const r = await git(dir, ["status", "--porcelain", "--ignored", "--untracked-files=normal", "--ignore-submodules=none"]);
  if (r.code !== 0) return { dirty: 0, changed: [], ignored: [], error: r.stderr.trim().split("\n")[0] || `exit ${r.code}` };
  const lines = r.stdout.split("\n").filter(Boolean);
  const ignored = lines.filter((l) => l.startsWith("!! ")).map((l) => l.slice(3));
  const changed = [...lines.filter((l) => !l.startsWith("!! ")).map((l) => l.slice(3)), ...(await hiddenFrom(dir))];
  return { dirty: changed.length, changed, ignored: ignored.filter((p) => !regenerable(p)) };
}

/** Submodules the checkout has checked out: gitlinks in its index with a `.git` in their directory. */
async function submodulesOf(dir: string): Promise<number> {
  const r = await git(dir, ["ls-files", "--stage", "-z"]);
  if (r.code !== 0) return 0;
  const links = r.stdout.split("\0").filter((e) => e.startsWith("160000 ")).map((e) => e.slice(e.indexOf("\t") + 1));
  return links.filter((p) => existsSync(join(dir, p, ".git"))).length;
}

async function samePath(a: string, b: string): Promise<boolean> {
  const [ra, rb] = await Promise.all([realpath(a).catch(() => a), realpath(b).catch(() => b)]);
  return ra === rb;
}

/** Where to look: the live checkout, else the surviving branch in the main repo, else nothing. */
async function locate(
  repoRoot: string,
  path: string,
  branchHint: string | null,
): Promise<{ dir: string; ref: string; branch: string | null; checkout: boolean } | null> {
  const top = existsSync(path) ? await out(path, ["rev-parse", "--show-toplevel"]) : null;
  // A managed worktree's directory that lost its `.git` resolves to the repo
  // above it: that is not this row's checkout, and its branch may still be.
  const stray = top !== null && managedWorktreeOf(path)?.worktree === path && !(await samePath(top, path));
  if (top && !stray) {
    const branch = await out(top, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return { dir: top, ref: "HEAD", branch, checkout: true };
  }
  if (branchHint && existsSync(repoRoot) && (await refExists(repoRoot, `refs/heads/${branchHint}`))) {
    return { dir: repoRoot, ref: `refs/heads/${branchHint}`, branch: branchHint, checkout: false };
  }
  return null;
}

/**
 * The git state of a row: its checkout at `path` when that exists, else the
 * branch it left behind in `repoRoot`; null when there is neither.
 */
export async function probeGit(repoRoot: string, path: string, branchHint: string | null): Promise<GitState | null> {
  const at = await locate(repoRoot, path, branchHint);
  if (!at) return null;
  const worktrees = await listWorktrees(at.dir);
  const main = worktrees[0];
  const base = await baseRef(at.dir);
  const merged = await isMerged(at.dir, at.ref, base);
  const status = at.checkout ? await statusOf(at.dir) : { dirty: 0, changed: [], ignored: [] };
  const head = await out(at.dir, ["rev-parse", "--verify", "--quiet", `${at.ref}^{commit}`]);
  const submodules = at.checkout ? await submodulesOf(at.dir) : 0;
  return {
    worktreeExists: at.checkout,
    isMain: at.checkout && !!main && (await samePath(main.path, at.dir)),
    branch: at.branch,
    head,
    mainBranch: main?.branch ?? null,
    dirty: status.dirty,
    changed: status.changed,
    ignored: status.ignored,
    submodules,
    ...(status.error ? { statusError: status.error } : {}),
    unpushed: merged ? 0 : await aheadCount(at.dir, at.ref, at.branch),
    merged,
    base,
  };
}
