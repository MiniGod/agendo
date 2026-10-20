import { describe, expect, test } from "bun:test";
import { formatSize, nextSort, sortRows, totalSize } from "../src/cleanup/sort.ts";
import type { CleanupRow, RowSizes } from "../src/cleanup/types.ts";

const row = (key: string, updated: number, created: number): CleanupRow => ({
  key, title: key, session: null, repoRoot: "/r", worktree: null, path: "/r",
  branchHint: null, updated: new Date(updated), created: new Date(created), run: "idle",
});
const sz = (worktree: number | null | undefined, transcript: number | null | undefined = null, tmp: number | null | undefined = null): RowSizes => ({ worktree, transcript, tmp });

describe("sorting", () => {
  const rows = [row("a", 1, 30), row("b", 3, 10), row("c", 2, 20)];
  const sizes = new Map([["a", sz(500)], ["b", sz(10, 5)], ["c", sz(undefined)]]);

  test("s cycles updated → created → size → updated", () => {
    expect(nextSort("updated")).toBe("created");
    expect(nextSort("created")).toBe("size");
    expect(nextSort("size")).toBe("updated");
  });

  test("each key sorts descending by default, ascending when reversed", () => {
    const keys = (s: Parameters<typeof sortRows>[1], rev = false) => sortRows(rows, s, rev, sizes).map((r) => r.key);
    expect(keys("updated")).toEqual(["b", "c", "a"]);
    expect(keys("updated", true)).toEqual(["a", "c", "b"]);
    expect(keys("created")).toEqual(["a", "c", "b"]);
    // c is still being measured, so it sorts below every measured row.
    expect(keys("size")).toEqual(["a", "b", "c"]);
    expect(keys("size", true)).toEqual(["c", "b", "a"]);
  });

  test("ties keep key order, and the input is not mutated", () => {
    const tied = [row("y", 1, 1), row("x", 1, 1)];
    expect(sortRows(tied, "updated", false, new Map()).map((r) => r.key)).toEqual(["x", "y"]);
    expect(sortRows(tied, "updated", true, new Map()).map((r) => r.key)).toEqual(["x", "y"]);
    expect(tied.map((r) => r.key)).toEqual(["y", "x"]);
  });
});

describe("sizes", () => {
  test("totalSize waits for every part, then sums the ones that exist", () => {
    expect(totalSize(undefined)).toBeUndefined();
    expect(totalSize({ worktree: 1, transcript: undefined, tmp: null })).toBeUndefined();
    expect(totalSize(sz(1, 2, 3))).toBe(6);
    expect(totalSize(sz(null, null, null))).toBe(0);
  });

  test("formatSize", () => {
    expect(formatSize(undefined)).toBe("…");
    expect(formatSize(null)).toBe("—");
    expect(formatSize(0)).toBe("0B");
    expect(formatSize(1023)).toBe("1023B");
    expect(formatSize(1024)).toBe("1.0K");
    expect(formatSize(4.25 * 1024)).toBe("4.3K");
    expect(formatSize(37 * 1024 * 1024)).toBe("37M");
    expect(formatSize(1.3 * 1024 ** 3)).toBe("1.3G");
    expect(formatSize(5 * 1024 ** 5)).toBe("5120T");
  });
});
