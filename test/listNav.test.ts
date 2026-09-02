// Arrow-key navigation over the flat row list: the tree read off it
// (src/ui/keys/rowTree.ts) and the handler that dispatches on it. The e2e
// suite presses → and ← on a few rows; what it never reaches is ← climbing
// past a non-selectable row, → on an open leaf row, enter on every kind, the
// vi letters, and the no-row edge, which is where the untested half of the
// old handler lived.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { handleListNavKeys, navKeyOf } from "../src/ui/keys/list.ts";
import { ancestorIndex, depthOf, expandKeyOf, firstChildIndex, isExpandable, isOpen } from "../src/ui/keys/rowTree.ts";
import type { Row } from "../src/ui/rows.ts";

const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });

const session = { id: "s1", source: "claude", cwd: "/w", title: "t", lastUsed: new Date() } as const;
const toggle = (open: boolean): Row => ({ kind: "toggle", id: "sec", label: "Section", count: 1, open });
const item = (expanded: boolean): Row => ({ kind: "item", item: { id: 7, project: "P" }, expanded, running: 0, open: {} }) as unknown as Row;
const pr = (expanded: boolean): Row => ({ kind: "pr", pr: { id: 9, repositoryId: "R" }, expanded, running: 0, open: {} }) as unknown as Row;
const sess = (expanded: boolean): Row => ({ kind: "session", key: "k1", session, running: false, expanded }) as unknown as Row;
const fresh: Row = { kind: "fresh", key: "f", target: { kind: "item" } } as unknown as Row;
const header: Row = { kind: "header", label: "h" };
const meta: Row = { kind: "sessmeta", key: "m", label: "l", value: "v" };

describe("rowTree", () => {
  test("which rows expand, which are open, and their expansion keys", () => {
    expect([toggle(true), item(false), pr(false), sess(false)].map(isExpandable)).toEqual([true, true, true, true]);
    expect([fresh, header, meta, { kind: "newsess" } as Row].map(isExpandable)).toEqual([false, false, false, false]);
    expect([toggle(true), toggle(false), item(true), pr(false), sess(true), fresh, header].map(isOpen)).toEqual([true, false, true, false, true, false, false]);
    expect(expandKeyOf(item(false))).toBe("wi:P:7");
    expect(expandKeyOf(pr(false))).toBe("pr:R:9");
    expect(expandKeyOf(sess(false))).toBe("sx:k1");
    expect(expandKeyOf(toggle(false))).toBeNull();
    expect(expandKeyOf(header)).toBeNull();
  });

  test("depth, first child and ancestor", () => {
    const rows = [toggle(true), header, item(true), sess(false), meta, fresh, pr(true), sess(false)];
    expect(rows.map(depthOf)).toEqual([0, 0, 1, 2, 0, 2, 1, 2]);
    expect(firstChildIndex(rows, 0)).toBe(-1); // a header sits below the section
    expect(firstChildIndex(rows, 2)).toBe(3);
    expect(firstChildIndex(rows, 7)).toBe(-1); // nothing below the last row
    expect(ancestorIndex(rows, 3)).toBe(2); // session → its item
    expect(ancestorIndex(rows, 5)).toBe(2); // fresh → the item, skipping the sessmeta row
    expect(ancestorIndex(rows, 2)).toBe(0); // item → the section, skipping the header
    expect(ancestorIndex(rows, 0)).toBe(-1);
    expect(ancestorIndex(rows, 4)).toBe(-1); // a depth-0 row has nothing shallower above it
  });
});

describe("navKeyOf", () => {
  test("arrows, enter and the vi letters; anything else is null", () => {
    expect(navKeyOf("", key({ upArrow: true }))).toBe("up");
    expect(navKeyOf("", key({ downArrow: true }))).toBe("down");
    expect(navKeyOf("", key({ rightArrow: true }))).toBe("right");
    expect(navKeyOf("", key({ leftArrow: true }))).toBe("left");
    expect(navKeyOf("", key({ return: true }))).toBe("enter");
    expect(["k", "j", "l", "h"].map((c) => navKeyOf(c, NONE))).toEqual(["up", "down", "right", "left"]);
    expect(navKeyOf("x", NONE)).toBeNull();
  });
});

describe("handleListNavKeys", () => {
  function ctxOver(rows: Row[], cursor: number) {
    return {
      rows,
      cursor,
      setCursor: mock(),
      move: mock(),
      toggleExpand: mock(),
      toggleSection: mock(),
      ensureActivity: mock(),
      open: mock(),
      model: undefined,
      enterFresh: mock(),
      enterNewSession: mock(),
    };
  }

  test("↑/↓ and k/j move; an unbound key is declined", () => {
    const ctx = ctxOver([item(false)], 0);
    expect(handleListNavKeys("", key({ upArrow: true }), ctx as any)).toBe(true);
    expect(handleListNavKeys("j", NONE, ctx as any)).toBe(true);
    expect(ctx.move.mock.calls).toEqual([[-1], [1]]);
    expect(handleListNavKeys("x", NONE, ctx as any)).toBe(false);
  });

  test("→ expands a closed row, descends into an open one, and ignores the rest", () => {
    const rows = [toggle(false), item(true), sess(false), header, sess(true), meta];
    const closed = ctxOver(rows, 0);
    handleListNavKeys("l", NONE, closed as any);
    expect(closed.toggleSection.mock.calls).toEqual([["sec"]]);
    const open = ctxOver(rows, 1);
    handleListNavKeys("", key({ rightArrow: true }), open as any);
    expect(open.setCursor.mock.calls).toEqual([[2]]);
    expect(open.toggleExpand).not.toHaveBeenCalled();
    const leafBelow = ctxOver(rows, 4); // open session whose next row is not selectable
    handleListNavKeys("l", NONE, leafBelow as any);
    expect(leafBelow.setCursor).not.toHaveBeenCalled();
    const closedSession = ctxOver(rows, 2);
    handleListNavKeys("l", NONE, closedSession as any);
    expect(closedSession.ensureActivity.mock.calls).toEqual([[session]]);
    expect(closedSession.toggleExpand.mock.calls).toEqual([["sx:k1"]]);
    const onHeader = ctxOver(rows, 3);
    expect(handleListNavKeys("l", NONE, onHeader as any)).toBe(true);
    expect(onHeader.toggleExpand).not.toHaveBeenCalled();
    expect(handleListNavKeys("l", NONE, ctxOver(rows, 99) as any)).toBe(true);
  });

  test("← collapses an open row, else climbs to the nearest selectable ancestor", () => {
    const rows = [toggle(true), pr(true), sess(false), fresh];
    const open = ctxOver(rows, 1);
    handleListNavKeys("h", NONE, open as any);
    expect(open.toggleExpand.mock.calls).toEqual([["pr:R:9"]]);
    expect(open.setCursor).not.toHaveBeenCalled();
    const child = ctxOver(rows, 3);
    handleListNavKeys("", key({ leftArrow: true }), child as any);
    expect(child.setCursor.mock.calls).toEqual([[1]]);
    const top = ctxOver(rows, 0);
    handleListNavKeys("h", NONE, top as any);
    expect(top.toggleSection.mock.calls).toEqual([["sec"]]);
    const closedTop = ctxOver([toggle(false)], 0);
    handleListNavKeys("h", NONE, closedTop as any);
    expect(closedTop.setCursor).not.toHaveBeenCalled();
    expect(handleListNavKeys("h", NONE, ctxOver(rows, 99) as any)).toBe(true);
  });

  test("enter resumes a session, starts a fresh or new one, toggles an expandable, and ignores the rest", () => {
    const rows = [sess(false), fresh, { kind: "newsess" } as Row, item(false), header];
    const s = ctxOver(rows, 0);
    handleListNavKeys("", key({ return: true }), s as any);
    expect(s.open).toHaveBeenCalledTimes(1);
    const f = ctxOver(rows, 1);
    handleListNavKeys("", key({ return: true }), f as any);
    expect(f.enterFresh.mock.calls).toEqual([[{ kind: "item" }]]);
    const n = ctxOver(rows, 2);
    handleListNavKeys("", key({ return: true }), n as any);
    expect(n.enterNewSession).toHaveBeenCalledTimes(1);
    const i = ctxOver(rows, 3);
    handleListNavKeys("", key({ return: true }), i as any);
    expect(i.toggleExpand.mock.calls).toEqual([["wi:P:7"]]);
    expect(i.ensureActivity).not.toHaveBeenCalled();
    const h = ctxOver(rows, 4);
    expect(handleListNavKeys("", key({ return: true }), h as any)).toBe(true);
    expect(h.toggleExpand).not.toHaveBeenCalled();
    expect(handleListNavKeys("", key({ return: true }), ctxOver(rows, 99) as any)).toBe(true);
  });
});
