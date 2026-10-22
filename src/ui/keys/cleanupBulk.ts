import type { Key } from "ink";
import type { BulkStep } from "../../cleanup/bulk.ts";
import type { CleanupRow } from "../../cleanup/types.ts";

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
}

/** What the screen must do after a key on the bulk dialog. */
export type BulkEffect = "none" | "cancel" | "runAll" | "refresh";

export function openBulk(rows: readonly CleanupRow[]): BulkDialog {
  return { stage: "confirm", rows: [...rows], top: 0, steps: [] };
}

/** How many lines the list or summary has, for clamping the scroll. */
function length(b: BulkDialog): number {
  return b.stage === "done" ? b.steps.length : b.rows.length;
}

function scrolled(b: BulkDialog, input: string, key: Key): BulkDialog | null {
  const dir = key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : 0;
  if (!dir) return null;
  return { ...b, top: Math.max(0, Math.min(b.top + dir, length(b) - 1)) };
}

/**
 * One key on the bulk dialog. Confirm: only `y` runs, ↑/↓ scroll, anything
 * else cancels. Running: keys wait. Done: ↑/↓ scroll the summary, anything
 * else closes it and re-measures what was deleted.
 */
export function bulkKey(b: BulkDialog, input: string, key: Key): { bulk: BulkDialog | null; effect: BulkEffect } {
  if (b.stage === "running") return { bulk: b, effect: "none" };
  const scroll = scrolled(b, input, key);
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
