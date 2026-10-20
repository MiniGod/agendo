// Sorting and size arithmetic for the cleanup view. Pure, unit tested in
// test/cleanupSort.test.ts.
import type { CleanupRow, RowSizes } from "./types.ts";

export type CleanupSort = "updated" | "created" | "size";

const ORDER: readonly CleanupSort[] = ["updated", "created", "size"];

/** `s` cycles updated → created → size → updated. */
export function nextSort(s: CleanupSort): CleanupSort {
  return ORDER[(ORDER.indexOf(s) + 1) % ORDER.length];
}

/**
 * A row's total on-disk bytes: undefined while any part is still being
 * measured, else the sum of the parts that exist (0 when none does).
 */
export function totalSize(s: RowSizes | undefined): number | undefined {
  if (!s) return undefined;
  const parts = [s.worktree, s.transcript, s.tmp];
  if (parts.some((p) => p === undefined)) return undefined;
  return parts.reduce<number>((sum, p) => sum + (p ?? 0), 0);
}

/** The value a row sorts by, larger first. An unmeasured size sorts below every measured one. */
function sortValue(row: CleanupRow, sort: CleanupSort, sizes: ReadonlyMap<string, RowSizes>): number {
  if (sort === "updated") return row.updated.getTime();
  if (sort === "created") return row.created.getTime();
  return totalSize(sizes.get(row.key)) ?? -1;
}

/** Rows ordered by `sort`, descending (newest / largest first), or ascending when `reversed`. Ties keep key order. */
export function sortRows(
  rows: readonly CleanupRow[],
  sort: CleanupSort,
  reversed: boolean,
  sizes: ReadonlyMap<string, RowSizes>,
): CleanupRow[] {
  const dir = reversed ? -1 : 1;
  return [...rows].sort((a, b) => {
    const d = sortValue(b, sort, sizes) - sortValue(a, sort, sizes);
    if (d !== 0) return d * dir;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

const UNITS = ["K", "M", "G", "T"];

/** `…` while measuring, `—` for nothing on disk, else a compact size (`812B`, `4.2K`, `37M`, `1.3G`). */
export function formatSize(bytes: number | null | undefined): string {
  if (bytes === undefined) return "…";
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes}B`;
  let v = bytes / 1024;
  let unit = 0;
  while (v >= 1024 && unit < UNITS.length - 1) {
    v /= 1024;
    unit++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}${UNITS[unit]}`;
}
