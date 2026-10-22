// Filtering for the cleanup view: which rows `f` keeps, and the `/` text match.
// Pure, unit tested in test/cleanupFilter.test.ts. "Safe to remove" is not
// decided here — it is classify.ts's `safeToRemove`, the very predicate that
// decides whether the dialog opens with the worktree and branch ticked.
import { isRisky, safeToRemove } from "./classify.ts";
import type { CleanupRow, GitState, Offers } from "./types.ts";

export type CleanupFilter = "all" | "safe" | "risk";

const ORDER: readonly CleanupFilter[] = ["all", "safe", "risk"];

const LABELS: Record<CleanupFilter, string> = {
  all: "all",
  safe: "safe to remove",
  risk: "has something to lose",
};

/** `f` cycles all → safe to remove → has something to lose → all. */
export function nextFilter(f: CleanupFilter): CleanupFilter {
  return ORDER[(ORDER.indexOf(f) + 1) % ORDER.length];
}

export function filterLabel(f: CleanupFilter): string {
  return LABELS[f];
}

/**
 * Where a row stands for the filter. `pending` while its git state is still
 * being probed: such a row is in neither the safe nor the at-risk list until
 * it is measured. `other` is everything with nothing to judge or nothing on
 * offer: the main checkout, a session whose checkout and branch are gone, and
 * a running or just-written row whose git shows nothing at risk (one that does
 * is `risk`).
 */
export type Verdict = "pending" | "safe" | "risk" | "other";

export function verdictOf(row: CleanupRow, git: GitState | null | undefined, offers: Offers): Verdict {
  if (git === undefined) return "pending";
  if (safeToRemove(offers, git, row.active)) return "safe";
  if (git && !git.isMain && isRisky(git)) return "risk";
  return "other";
}

/**
 * The verdict a row is FILTERED by: a row being measured again after a delete
 * keeps the place its last measurement gave it until the new one lands (not
 * after R: a re-scan starts every row over), so it does not blink out of a filtered list and take the cursor with
 * it. Only visibility: whether a row is safe to delete is always `now`.
 */
export function shownVerdict(now: Verdict, last: Verdict | undefined): Verdict {
  return now === "pending" && last ? last : now;
}

/** Whether `query` (case-insensitive) is in the row's title, branch or path. An empty query matches all. */
export function matchesQuery(row: CleanupRow, git: GitState | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const branch = git?.branch ?? row.branchHint ?? "";
  return [row.title, branch, row.path].some((s) => s.toLowerCase().includes(q));
}

/** The rows `filter` and `query` keep, in the order given. */
export function filterRows(
  rows: readonly CleanupRow[],
  filter: CleanupFilter,
  query: string,
  verdict: (row: CleanupRow) => Verdict,
  git: (row: CleanupRow) => GitState | null | undefined,
): CleanupRow[] {
  return rows.filter((r) => (filter === "all" || verdict(r) === filter) && matchesQuery(r, git(r), query));
}
