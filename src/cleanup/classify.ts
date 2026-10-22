// The pure half of the cleanup dialog: what may be deleted, what starts ticked,
// what would be lost, and when a second confirmation is required. Everything
// here is a function of a row, its probed git state and a selection — no I/O —
// so every rule the dialog enforces is unit tested in test/cleanupClassify.test.ts.
import { transcriptPathsOf } from "./rows.ts";
import { BOXES, type Box, type CleanupRow, type GitState, type Offer, type Offers, type Selection } from "./types.ts";

const RUNNING = "session is running — pause or kill it first";

/** What the dialog says about a row written to moments ago with no agendo window holding it. */
export const ACTIVE_NOTICE = "this, or a session in the same worktree, was written to moments ago — an agent may still be using it outside agendo";

/** Nothing ticked. */
export function emptySelection(): Selection {
  return { worktree: false, branch: false, transcript: false, tmp: false };
}

/** Whether deleting this checkout or branch could lose work. */
export function isRisky(git: GitState): boolean {
  return !!git.statusError || git.dirty > 0 || git.ignored.length > 0 || git.submodules > 0 || git.unpushed > 0 || !git.merged;
}

/** The short name of the merge base ref (`origin/master` → `master`). */
function baseBranch(git: GitState): string | null {
  return git.base ? git.base.replace(/^[^/]+\//, "") : null;
}

function worktreeOffer(row: CleanupRow, git: GitState | null | undefined): Offer {
  if (!row.worktree) return { enabled: false, reason: "not an agendo worktree (.claude/worktrees/)" };
  if (git === undefined) return { enabled: false, reason: "checking…" };
  if (!git?.worktreeExists) return { enabled: false, reason: "no worktree on disk" };
  if (git.isMain) return { enabled: false, reason: "the repo's main checkout" };
  return { enabled: true };
}

function branchOffer(git: GitState | null | undefined): Offer {
  if (git === undefined) return { enabled: false, reason: "checking…" };
  if (!git?.branch) return { enabled: false, reason: "no branch" };
  if (git.isMain || git.branch === git.mainBranch) return { enabled: false, reason: "checked out in the main checkout" };
  if (git.branch === baseBranch(git)) return { enabled: false, reason: "the default branch" };
  return { enabled: true };
}

function transcriptOffer(row: CleanupRow): Offer {
  if (!row.session) return { enabled: false, reason: "no session" };
  if (!row.session.logPath) return { enabled: false, reason: "no transcript on disk" };
  if (transcriptPathsOf(row.session).length === 0) return { enabled: false, reason: "its transcript can't be told apart safely" };
  return { enabled: true };
}

function tmpOffer(row: CleanupRow): Offer {
  if (!row.session) return { enabled: false, reason: "no session" };
  if (row.session.source !== "claude") return { enabled: false, reason: `${row.session.source} keeps no scratch dir` };
  return { enabled: true };
}

/**
 * What the dialog may offer for a row. A RUNNING session offers nothing: its
 * worktree and branch are in use, and its transcript and scratch dir are still
 * being written. `othersRunning` covers a second, running session that shares
 * the worktree — removing the checkout from under it is the same hazard.
 */
export function offersFor(row: CleanupRow, git: GitState | null | undefined, othersRunning = false): Offers {
  const offers: Offers = {
    worktree: worktreeOffer(row, git),
    branch: branchOffer(git),
    transcript: transcriptOffer(row),
    tmp: tmpOffer(row),
  };
  // A branch checked out in a worktree that can't go too can't be deleted either.
  if (git?.worktreeExists && !offers.worktree.enabled && offers.branch.enabled) {
    offers.branch = { enabled: false, reason: "checked out in a worktree that can't be removed here" };
  }
  if (othersRunning) {
    const reason = "a running session uses this worktree";
    if (offers.worktree.enabled) offers.worktree = { enabled: false, reason };
    if (offers.branch.enabled) offers.branch = { enabled: false, reason };
  }
  if (row.run !== "running") return offers;
  const off: Offer = { enabled: false, reason: RUNNING };
  return { worktree: off, branch: off, transcript: off, tmp: off };
}

/**
 * The boxes ticked when the dialog opens. The session itself is KEPT by
 * default, so the transcript and scratch boxes start clear. The worktree and
 * branch start ticked only when deleting them cannot lose anything: a clean
 * checkout, nothing unpushed, and the branch merged.
 */
export function defaultSelection(offers: Offers, git: GitState | null | undefined, active = false): Selection {
  const safe = !!git && !isRisky(git) && !active;
  return {
    worktree: offers.worktree.enabled && safe,
    branch: offers.branch.enabled && safe,
    transcript: false,
    tmp: false,
  };
}

/**
 * Whether the dialog would open with the worktree or the branch ticked — the
 * one definition of "safe to remove" (deleting it loses nothing) that the
 * view's filter reuses rather than restating. Unprobed git is never safe.
 */
export function safeToRemove(offers: Offers, git: GitState | null | undefined, active = false): boolean {
  const sel = defaultSelection(offers, git, active);
  return sel.worktree || sel.branch;
}

/** Everything that would be lost by removing the checkout and its branch, one line each; empty when nothing. */
export function lossLines(git: GitState | null | undefined): string[] {
  if (!git) return [];
  const lines: string[] = [];
  if (git.statusError) lines.push(`unknown local changes — git status failed: ${git.statusError}`);
  if (git.dirty > 0) lines.push(`${git.dirty} dirty file${git.dirty === 1 ? "" : "s"} (uncommitted or untracked)`);
  if (git.ignored.length > 0) lines.push(ignoredLine(git.ignored));
  if (git.submodules > 0) lines.push(`${git.submodules} checked-out submodule${git.submodules === 1 ? "" : "s"}, whose own work is not checked`);
  if (git.unpushed > 0) lines.push(`${git.unpushed} unpushed commit${git.unpushed === 1 ? "" : "s"}`);
  if (!git.merged) lines.push(git.base ? `branch not merged into ${git.base}` : "no origin default branch to check the merge against");
  return lines;
}

function ignoredLine(ignored: readonly string[]): string {
  const n = ignored.length;
  const named = ignored.slice(0, 3).join(", ") + (n > 3 ? ", …" : "");
  return `${n} ignored file${n === 1 ? "" : "s"} git would not keep (${named})`;
}

/**
 * Whether this selection needs the second confirmation: it deletes a risky
 * worktree or branch, or anything at all of a session that was `active`
 * moments ago and so may be running outside agendo.
 */
export function needsConfirm(sel: Selection, git: GitState | null | undefined, active = false): boolean {
  if (active && BOXES.some((b) => sel[b])) return true;
  return (sel.worktree || sel.branch) && !!git && isRisky(git);
}

/** Why this selection cannot run as it stands, or null when it can. */
export function selectionProblem(sel: Selection, offers: Offers, git: GitState | null | undefined): string | null {
  const picked = BOXES.filter((b) => sel[b]);
  if (picked.length === 0) return "nothing selected";
  const blocked = picked.find((b) => !offers[b].enabled);
  if (blocked) return `${boxLabel(blocked)}: ${offers[blocked].reason}`;
  if (sel.branch && !sel.worktree && git?.worktreeExists) return "the branch is checked out in the worktree — select the worktree too";
  return null;
}

/**
 * Whether a fresh probe shows more at stake than the one the user confirmed
 * against — or simply something else: another branch checked out, or the same
 * branch moved to other commits, is not what the user agreed to lose even when
 * the counts happen to match.
 */
export function riskGrew(before: GitState | null | undefined, after: GitState): boolean {
  if (!before) return isRisky(after);
  if (after.branch !== before.branch || after.head !== before.head || (after.statusError && !before.statusError)) return true;
  const more = after.dirty > before.dirty || after.submodules > before.submodules || after.unpushed > before.unpushed;
  return more || newTo(before.changed, after.changed) || newTo(before.ignored, after.ignored) || (before.merged && !after.merged);
}

/** Whether `after` names a path `before` did not: the same count can hide a different file. */
const newTo = (before: readonly string[], after: readonly string[]) => after.some((p) => !before.includes(p));

const LABELS: Record<Box, string> = {
  worktree: "worktree",
  branch: "branch",
  transcript: "session transcript",
  tmp: "tmp/scratch files",
};

export function boxLabel(b: Box): string {
  return LABELS[b];
}
