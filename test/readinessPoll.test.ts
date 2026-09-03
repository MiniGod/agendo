// The bookkeeping under the readiness poll (src/ui/hooks/useReadinessPoll.ts):
// the frozen reset instant, what leaving the limited state forgets, what a
// vanished window leaves behind, and when a fresh snapshot is the same as the
// last. The e2e suite drives the poll through a fixture pane that is limited
// with its reset line showing and then recovers; it never has a window vanish
// between reloads, never re-parses after a missed reset line, and never
// compares two snapshots that differ only in the compaction percent.
import { describe, expect, test } from "bun:test";
import type { PaneState } from "../src/ui/format.ts";
import { forgetLimit, frozenResetAt, type LimitBooks, pruneVanished, samePanes } from "../src/ui/hooks/useReadinessPoll.ts";

const books = (init: Partial<LimitBooks> = {}): LimitBooks => ({
  limitWindows: new Map(), resumeFired: new Map(), dialogRevealed: new Set(), ...init,
});
const ESC = String.fromCharCode(27);
const LIMIT_LINE = "⎿  You've hit your session limit · resets 2:10pm (Atlantic/Reykjavik)";

describe("frozenResetAt", () => {
  test("a frozen instant is returned without re-parsing; a parse is frozen; a miss stays null and is retried", () => {
    const b = books({ limitWindows: new Map([["s", 42]]) });
    expect(frozenResetAt(b, "s", "resets 9pm")).toBe(42);
    const parsed = frozenResetAt(b, "t", `${ESC}[1m${LIMIT_LINE}${ESC}[0m`);
    expect(typeof parsed).toBe("number");
    expect(b.limitWindows.get("t")).toBe(parsed);
    expect(frozenResetAt(b, "u", "❯ 1. Stop and wait for limit to reset")).toBeNull();
    expect(b.limitWindows.get("u")).toBeNull();
    expect(frozenResetAt(b, "u", LIMIT_LINE)).toBe(b.limitWindows.get("u")!);
    expect(b.limitWindows.get("u")).not.toBeNull();
  });
});

describe("forgetLimit and pruneVanished", () => {
  test("forgetting drops all three records for one session and no other", () => {
    const b = books({
      limitWindows: new Map([["a", 1], ["b", 2]]), resumeFired: new Map([["a", 1]]), dialogRevealed: new Set(["a", "b"]),
    });
    forgetLimit(b, "a");
    expect([...b.limitWindows.keys()]).toEqual(["b"]);
    expect(b.resumeFired.size).toBe(0);
    expect([...b.dialogRevealed]).toEqual(["b"]);
  });

  test("pruning keeps only the windows still live", () => {
    const b = books({
      limitWindows: new Map([["a", 1], ["gone", null]]), resumeFired: new Map([["gone", 3], ["a", 1]]), dialogRevealed: new Set(["gone"]),
    });
    pruneVanished(b, new Set(["a"]));
    expect([...b.limitWindows.keys()]).toEqual(["a"]);
    expect([...b.resumeFired.keys()]).toEqual(["a"]);
    expect(b.dialogRevealed.size).toBe(0);
  });
});

describe("samePanes", () => {
  const pane = (p: Partial<PaneState> = {}): PaneState => ({ readiness: "ready", shells: 0, resetAt: undefined, compactionPercent: null, ...p });
  test("same size and every field equal is the same; any field, a missing key, or a size change is not", () => {
    const prev = new Map([["a", pane()], ["b", pane({ readiness: "compacting", compactionPercent: 40 })]]);
    expect(samePanes(prev, new Map([["a", pane()], ["b", pane({ readiness: "compacting", compactionPercent: 40 })]]))).toBe(true);
    expect(samePanes(prev, new Map([["a", pane()], ["b", pane({ readiness: "compacting", compactionPercent: 41 })]]))).toBe(false);
    expect(samePanes(prev, new Map([["a", pane({ shells: 1 })], ["b", pane({ readiness: "compacting", compactionPercent: 40 })]]))).toBe(false);
    expect(samePanes(prev, new Map([["a", pane({ resetAt: 5 })], ["b", pane({ readiness: "compacting", compactionPercent: 40 })]]))).toBe(false);
    expect(samePanes(prev, new Map([["a", pane()], ["c", pane({ readiness: "compacting", compactionPercent: 40 })]]))).toBe(false);
    expect(samePanes(prev, new Map([["a", pane()]]))).toBe(false);
    expect(samePanes(new Map(), new Map())).toBe(true);
  });
});
