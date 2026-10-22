// Deleting every row that is safe to remove, one after another (D in the
// cleanup view), and working out which measurements a deletion can have
// changed. The judging and the deleting are handed in, so the order, the
// skip-and-carry-on and the summary are unit tested on their own
// (test/cleanupBulk.test.ts) without a repository.
import type { CleanupPlan, CleanupResult } from "./execute.ts";
import type { CleanupRow, GitState } from "./types.ts";

/** What happened to one row of a bulk run. */
export interface BulkStep {
  key: string;
  title: string;
  outcome: "removed" | "failed" | "skipped";
  lines: CleanupResult[];
}

/** A row judged again right before it goes: its plan, or why it is skipped. */
export type BulkCheck = { title: string; plan: CleanupPlan } | { title: string; skip: string };

export interface BulkDeps {
  /** Judge the row as it is NOW (a fresh git probe) — it may have changed since the confirmation was asked. */
  check: (key: string) => Promise<BulkCheck>;
  execute: (plan: CleanupPlan) => Promise<CleanupResult[]>;
  /** Called once per row, in order, as soon as it is done. */
  onStep: (step: BulkStep) => void;
}

async function oneRow(key: string, deps: BulkDeps): Promise<BulkStep> {
  let c: BulkCheck;
  try {
    c = await deps.check(key);
  } catch (e) {
    return { key, title: key, outcome: "failed", lines: [{ ok: false, text: e instanceof Error ? e.message : String(e) }] };
  }
  if ("skip" in c) return { key, title: c.title, outcome: "skipped", lines: [{ ok: false, text: c.skip }] };
  try {
    const lines = await deps.execute(c.plan);
    return { key, title: c.title, outcome: lines.every((l) => l.ok) ? "removed" : "failed", lines };
  } catch (e) {
    return { key, title: c.title, outcome: "failed", lines: [{ ok: false, text: e instanceof Error ? e.message : String(e) }] };
  }
}

/**
 * Run the rows one at a time, in the order given. A skipped or failed row does
 * not stop the run: every row is tried and reported.
 */
export async function runBulk(keys: readonly string[], deps: BulkDeps): Promise<BulkStep[]> {
  const steps: BulkStep[] = [];
  for (const key of keys) {
    const step = await oneRow(key, deps);
    steps.push(step);
    deps.onStep(step);
  }
  return steps;
}

/**
 * The rows whose measurements a cleanup of `done` can have changed: those rows
 * themselves, and every row of the same repo sharing one's checkout or its
 * branch. Everything else keeps the size and git state it was measured with.
 */
export function touchedBy(
  done: readonly CleanupRow[],
  rows: readonly CleanupRow[],
  git: (row: CleanupRow) => GitState | null | undefined,
): string[] {
  const branchOf = (r: CleanupRow) => git(r)?.branch ?? r.branchHint;
  const shares = (r: CleanupRow, d: CleanupRow) =>
    r.repoRoot === d.repoRoot && ((!!d.worktree && r.worktree === d.worktree) || (!!branchOf(d) && branchOf(r) === branchOf(d)));
  const keys = new Set(done.map((d) => d.key));
  for (const r of rows) if (done.some((d) => shares(r, d))) keys.add(r.key);
  return [...keys];
}
