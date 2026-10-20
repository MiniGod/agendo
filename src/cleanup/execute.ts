// Carrying out a cleanup the dialog confirmed. Every destructive step re-checks
// its own preconditions against the disk as it is NOW, not as it was when the
// dialog opened — the dialog may have sat open while a session wrote to the
// worktree — and refuses rather than guessing:
//
//   • nothing at all for a running session, or a worktree another running
//     session or a live agendo pane is in, and nothing unconfirmed for one
//     written to moments ago;
//   • no worktree with another worktree nested inside it;
//   • the worktree only if it resolves (symlinks followed) to a direct child of
//     `<repoRoot>/.claude/worktrees/` AND git lists it as a linked worktree of
//     that repo — never the main checkout, never anything outside;
//   • `--force` only when the user passed the second confirmation, and only
//     when the checkout is dirty (git refuses a dirty one without it);
//   • the branch never when the main checkout, or any worktree still standing,
//     has it checked out, nor when it is the base branch itself;
//   • and nothing risky at all when a fresh probe shows MORE at stake than the
//     one the user confirmed against.
import { lstat, realpath, rm, stat } from "fs/promises";
import { dirname, sep } from "path";
import { isRisky, riskGrew } from "./classify.ts";
import { invalidateUsage } from "./disk.ts";
import { git, listWorktrees, probeGit } from "./git.ts";
import { ACTIVE_MS, activityPathsOf, tmpDirOf, transcriptPathsOf } from "./rows.ts";
import type { CleanupRow, GitState, Selection } from "./types.ts";

export interface CleanupPlan {
  row: CleanupRow;
  sel: Selection;
  /** The git state the dialog showed, which any confirmation was given against. */
  git: GitState | null | undefined;
  /** Whether the user passed the second confirmation. */
  confirmed: boolean;
  /**
   * Whether that confirmation warned the row was active. A `y` given for a dirty
   * worktree is no consent to delete under an agent that started since.
   */
  activeConfirmed: boolean;
  /** Another running session lives in the same worktree. */
  othersRunning: boolean;
  tmpRoot: string;
  uid: number;
  /** The clock the run-time activity check is judged against. */
  now: number;
  /** Other sessions' files in the same worktree (`sharedActivityPaths`), which that check reads too. */
  shared?: string[];
}

/** One line of the result summary. */
export interface CleanupResult {
  ok: boolean;
  text: string;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/** The real path of a managed worktree, or null when it is not a direct child of the repo's `.claude/worktrees/`. */
export async function managedPath(repoRoot: string, worktree: string): Promise<string | null> {
  const [root, wt] = await Promise.all([realpath(repoRoot).catch(() => null), realpath(worktree).catch(() => null)]);
  if (!root || !wt) return null;
  const container = `${root}${sep}.claude${sep}worktrees`;
  return dirname(wt) === container ? wt : null;
}

/** This process's working directory as a realpath; null once it is gone. */
export async function ownCwd(): Promise<string | null> {
  try {
    return await realpath(process.cwd());
  } catch {
    return null;
  }
}

const inside = (p: string | null, dir: string) => p !== null && (p === dir || p.startsWith(dir + sep));

async function removeWorktree(plan: CleanupPlan, fresh: GitState): Promise<CleanupResult> {
  const { repoRoot, worktree } = plan.row;
  const path = worktree ? await managedPath(repoRoot, worktree) : null;
  if (!path) return { ok: false, text: `worktree: refused — not under ${repoRoot}/.claude/worktrees/` };
  const listed = await listWorktrees(repoRoot);
  const resolved = await Promise.all(listed.map((w) => realpath(w.path).catch(() => w.path)));
  const at = resolved.indexOf(path);
  if (at <= 0) return { ok: false, text: `worktree: refused — git does not list ${path} as a linked worktree` };
  // `git worktree remove` would take a worktree nested inside this one with it, dirty or not.
  const nested = resolved.find((p) => p.startsWith(path + sep));
  if (nested) return { ok: false, text: `worktree: refused — it contains the worktree ${nested}; clean that up first` };
  // --force skips git's own status check, so with no status of ours either nothing would stand in for it.
  if (fresh.statusError) return { ok: false, text: `worktree: refused — git status fails there (${fresh.statusError})` };
  if (inside(await ownCwd(), path)) return { ok: false, text: "worktree: refused — agendo itself is running in it; start agendo elsewhere to remove it" };
  // git refuses any worktree holding a checked-out submodule without --force, clean or not.
  const force = plan.confirmed && (fresh.dirty > 0 || fresh.submodules > 0);
  const r = await git(repoRoot, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
  invalidateUsage(path);
  if (r.code !== 0) return { ok: false, text: `worktree: ${firstLine(r.stderr) || "git worktree remove failed"}` };
  return { ok: true, text: `removed worktree ${path}${force ? " (forced)" : ""}` };
}

async function deleteBranch(plan: CleanupPlan, fresh: GitState): Promise<CleanupResult> {
  const branch = fresh.branch;
  if (!branch) return { ok: false, text: "branch: no branch to delete" };
  if (branch === fresh.mainBranch) return { ok: false, text: `branch: refused — ${branch} is checked out in the main checkout` };
  if (fresh.base && branch === fresh.base.replace(/^[^/]+\//, "")) return { ok: false, text: `branch: refused — ${branch} is the default branch` };
  const holder = (await listWorktrees(plan.row.repoRoot)).find((w) => w.branch === branch);
  if (holder) return { ok: false, text: `branch: refused — ${branch} is checked out at ${holder.path}` };
  const r = await git(plan.row.repoRoot, ["branch", "-D", branch]);
  if (r.code !== 0) return { ok: false, text: `branch: ${firstLine(r.stderr) || "git branch -D failed"}` };
  return { ok: true, text: `deleted branch ${branch}` };
}

async function removePaths(label: string, paths: readonly string[]): Promise<CleanupResult> {
  if (paths.length === 0) return { ok: false, text: `${label}: nothing to delete` };
  try {
    // `rm --force` succeeds on a path that was never there: say so instead of "deleted".
    const present = (await Promise.all(paths.map((p) => lstat(p).then(() => p, () => null)))).filter((p): p is string => !!p);
    if (present.length === 0) return { ok: true, text: `${label}: nothing on disk` };
    for (const p of present) {
      await rm(p, { recursive: true, force: true });
      invalidateUsage(p);
    }
  } catch (e) {
    return { ok: false, text: `${label}: ${(e as Error).message}` };
  }
  return { ok: true, text: `deleted ${label}` };
}

/** Why the worktree / branch steps must not run, or null when they may. */
function checkoutRefusal(plan: CleanupPlan, fresh: GitState | null): string | null {
  if (!fresh) return "the worktree and branch are gone already";
  if (riskGrew(plan.git, fresh)) return "more is at stake than when the dialog opened — reopen it to review";
  if (isRisky(fresh) && !plan.confirmed) return "would lose work and was not confirmed";
  return null;
}

async function cleanCheckout(plan: CleanupPlan): Promise<CleanupResult[]> {
  const { row, sel } = plan;
  const fresh = await probeGit(row.repoRoot, row.path, row.branchHint);
  const refusal = checkoutRefusal(plan, fresh);
  if (refusal || !fresh) return [{ ok: false, text: `worktree/branch: refused — ${refusal}` }];
  const results: CleanupResult[] = [];
  if (sel.worktree) {
    results.push(await removeWorktree(plan, fresh));
    if (!results[0].ok) return results; // the branch is still checked out there
  }
  if (sel.branch) results.push(await deleteBranch(plan, fresh));
  return results;
}

/**
 * Whether the row was written to moments ago, judged from the disk at run time
 * rather than from the row: the transcript of a session, the directory of a
 * worktree-only row. A session resumed in a plain terminal while the dialog sat
 * open shows up here.
 */
async function writtenJustNow(row: CleanupRow, now: number, shared: readonly string[] = []): Promise<boolean> {
  const own = row.session ? activityPathsOf(row.session) : row.worktree ? [row.worktree] : [];
  const paths = [...own, ...shared];
  const stats = await Promise.all(paths.map((p) => stat(p).catch(() => null)));
  return stats.some((st) => !!st && now - st.mtimeMs < ACTIVE_MS);
}

/** Why nothing at all may run for this row, or null when the steps may go ahead. */
async function blockedBecause(plan: CleanupPlan): Promise<string | null> {
  const { row } = plan;
  if (row.run === "running") return "refused — the session is running; pause or kill it first";
  const active = row.active || (await writtenJustNow(row, plan.now, plan.shared));
  if (active && !(plan.confirmed && plan.activeConfirmed)) return "refused — it was active moments ago and may be in use; reopen to confirm";
  return null;
}

async function checkoutSteps(plan: CleanupPlan): Promise<CleanupResult[]> {
  if (!plan.sel.worktree && !plan.sel.branch) return [];
  if (plan.othersRunning) return [{ ok: false, text: "worktree/branch: refused — a running session uses this worktree" }];
  return cleanCheckout(plan);
}

async function sessionSteps(plan: CleanupPlan): Promise<CleanupResult[]> {
  const s = plan.row.session;
  if (!s) return [];
  const results: CleanupResult[] = [];
  if (plan.sel.transcript) results.push(await removePaths("session transcript", transcriptPathsOf(s)));
  if (plan.sel.tmp) {
    const tmp = tmpDirOf(s, plan.tmpRoot, plan.uid);
    results.push(await removePaths("tmp/scratch files", tmp ? [tmp] : []));
  }
  return results;
}

/** Run the selected steps, worktree first, and say what happened to each. */
export async function executeCleanup(plan: CleanupPlan): Promise<CleanupResult[]> {
  const why = await blockedBecause(plan);
  if (why) return [{ ok: false, text: why }];
  const checkout = await checkoutSteps(plan);
  return [...checkout, ...(await sessionSteps(plan))];
}
