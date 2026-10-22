import type { Key } from "ink";
import type { BulkStep } from "../../cleanup/bulk.ts";
import type { CleanupRow, GitState } from "../../cleanup/types.ts";

// ── D in the cleanup view: delete everything that is safe to remove ──
// One confirmation naming the count and the rows, then a sequential run that
// re-judges each row right before deleting it (src/cleanup/bulk.ts), then a
// summary. The screen does the running; this is what each key means.

export interface BulkDialog {
  stage: "confirm" | "running" | "done";
  /** The rows that were safe when D was pressed, in list order. */
  rows: CleanupRow[];
  /** The first row of the list or summary on screen, for scrolling a long one. */
  top: number;
  /** One per row finished so far, in order. */
  steps: BulkStep[];
  /** Each row's git state as the confirmation showed it: D deletes only that, never what the row turned into. */
  confirmed: ReadonlyMap<string, GitState | null | undefined>;
}

/** What the screen must do after a key on the bulk dialog. */
export type BulkEffect = "none" | "cancel" | "runAll" | "refresh";

export function openBulk(rows: readonly CleanupRow[], git: (row: CleanupRow) => GitState | null | undefined = () => undefined): BulkDialog {
  return { stage: "confirm", rows: [...rows], top: 0, steps: [], confirmed: new Map(rows.map((r) => [r.key, git(r)])) };
}

/** How many lines the list or summary has, for clamping the scroll. */
function length(b: BulkDialog): number {
  return b.stage === "done" ? b.steps.length : b.rows.length;
}

/** Whether the list or summary is longer than the `page` rows on screen, so ↑/↓ scroll it. */
export function bulkScrolls(b: BulkDialog, page: number): boolean {
  return length(b) > page;
}

function scrolled(b: BulkDialog, input: string, key: Key, page: number): BulkDialog | null {
  const dir = key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : 0;
  if (!dir || !bulkScrolls(b, page)) return null;
  return { ...b, top: Math.max(0, Math.min(b.top + dir, length(b) - page)) };
}

/**
 * One key on the bulk dialog, `page` rows of it on screen. Confirm: only `y`
 * runs, ↑/↓ scroll a list that does not fit, anything else cancels. Running:
 * keys wait. Done: ↑/↓ scroll a summary that does not fit, anything else closes
 * it and re-measures what was deleted.
 */
export function bulkKey(b: BulkDialog, input: string, key: Key, page = 1): { bulk: BulkDialog | null; effect: BulkEffect } {
  if (b.stage === "running") return { bulk: b, effect: "none" };
  const scroll = scrolled(b, input, key, page);
  if (scroll) return { bulk: scroll, effect: "none" };
  if (b.stage === "done") return { bulk: null, effect: "refresh" };
  if (input === "y" || input === "Y") return { bulk: { ...b, stage: "running", top: 0 }, effect: "runAll" };
  return { bulk: null, effect: "cancel" };
}

/** A row finished. */
export function bulkStepped(b: BulkDialog, step: BulkStep): BulkDialog {
  return { ...b, steps: [...b.steps, step] };
}

/** Every row finished: show the summary. */
export function bulkDone(b: BulkDialog): BulkDialog {
  return { ...b, stage: "done", top: 0 };
}
