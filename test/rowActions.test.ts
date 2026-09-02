// The row actions of list mode (src/ui/keys/rowActions.ts): `c`, `m` and `o`
// on the row under the cursor. The e2e suite presses `o` on a work item and
// `c` on a session; it never reaches the wrong-row notices, a row whose
// targets hold no URL, `m`, or a chord that must be declined.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { handleListRowActionKeys, hasLink, hoveredSession, isOpenable, openTitle } from "../src/ui/keys/rowActions.ts";
import type { Row } from "../src/ui/rows.ts";
import { V } from "../src/ui/vocabState.ts";

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

const session = { id: "s1", source: "claude", cwd: "/w", title: "a session", lastUsed: new Date() } as const;
const pr = { id: 9, url: "https://x/pr/9" };
const workItem = { id: 7, url: "https://x/wi/7" };
const sessRow = (open?: object): Row => ({ kind: "session", key: "k1", session, running: false, expanded: false, open }) as unknown as Row;
const itemRow = (open?: object): Row => ({ kind: "item", item: { id: 7, title: "Item" }, expanded: false, running: 0, open }) as unknown as Row;
const prRow = (open?: object): Row => ({ kind: "pr", pr: { id: 9, title: "Fix" }, expanded: false, running: 0, open }) as unknown as Row;
const header: Row = { kind: "header", label: "h" };

function ctxOver(rows: Row[], cursor = 0) {
  return { rows, cursor, setNotice: mock(), setMode: mock(), continueInOtherAgent: mock(), enterProfilePicker: mock() };
}

describe("rowActions helpers", () => {
  test("hoveredSession returns the session, or notices and returns null", () => {
    const on = ctxOver([sessRow()]);
    expect(hoveredSession(on, "need")).toBe(session);
    expect(on.setNotice).not.toHaveBeenCalled();
    const off = ctxOver([header]);
    expect(hoveredSession(off, "need")).toBeNull();
    expect(off.setNotice.mock.calls).toEqual([["need"]]);
    expect(hoveredSession(ctxOver([], 3), "need")).toBeNull();
  });

  test("which rows can carry a link, and which targets hold one", () => {
    expect([itemRow(), prRow(), sessRow(), header, undefined].map(isOpenable)).toEqual([true, true, true, false, false]);
    expect(hasLink({ pr })).toBe(true);
    expect(hasLink({ workItem })).toBe(true);
    expect(hasLink({})).toBe(false);
    expect(hasLink(undefined)).toBe(false);
  });

  test("the open dialog's title per row kind", () => {
    expect(openTitle(itemRow() as never)).toBe("#7 — Item");
    expect(openTitle(prRow() as never)).toBe(`PR ${V.prPrefix}9 — Fix`);
    expect(openTitle(sessRow() as never)).toBe("a session");
  });
});

describe("handleListRowActionKeys", () => {
  test("c continues the hovered session; on any other row it says so", () => {
    const on = ctxOver([sessRow()]);
    expect(handleListRowActionKeys("c", NONE, on)).toBe(true);
    expect(on.continueInOtherAgent.mock.calls).toEqual([[session]]);
    const off = ctxOver([itemRow()]);
    expect(handleListRowActionKeys("c", NONE, off)).toBe(true);
    expect(off.continueInOtherAgent).not.toHaveBeenCalled();
    expect(off.setNotice.mock.calls).toEqual([["Select a session row first to continue it in another agent."]]);
  });

  test("m opens the profile picker for the hovered session; on any other row it says so", () => {
    const on = ctxOver([sessRow()]);
    expect(handleListRowActionKeys("m", NONE, on)).toBe(true);
    expect(on.enterProfilePicker.mock.calls).toEqual([[session]]);
    const off = ctxOver([header]);
    expect(handleListRowActionKeys("m", NONE, off)).toBe(true);
    expect(off.setNotice.mock.calls).toEqual([["Select a session row first to move it to another profile."]]);
  });

  test("o opens a linked row and clears the notice; an unlinked or wrong row gets the notice", () => {
    const item = ctxOver([itemRow({ workItem })]);
    expect(handleListRowActionKeys("o", NONE, item)).toBe(true);
    expect(item.setNotice.mock.calls).toEqual([[null]]);
    expect(item.setMode.mock.calls).toEqual([[{ kind: "open", targets: { workItem }, title: "#7 — Item" }]]);
    const sess = ctxOver([sessRow({ pr, workItem })]);
    handleListRowActionKeys("o", NONE, sess);
    expect(sess.setMode.mock.calls).toEqual([[{ kind: "open", targets: { pr, workItem }, title: "a session" }]]);
    for (const rows of [[prRow({})], [prRow()], [header], []]) {
      const ctx = ctxOver(rows);
      expect(handleListRowActionKeys("o", NONE, ctx)).toBe(true);
      expect(ctx.setMode).not.toHaveBeenCalled();
      expect(ctx.setNotice.mock.calls).toEqual([["Nothing to open in the browser for this row."]]);
    }
  });

  test("c and m need the bare letter, o takes any modifier, and other keys are declined", () => {
    const ctx = ctxOver([sessRow({ pr })]);
    expect(handleListRowActionKeys("c", key({ ctrl: true }), ctx)).toBe(false);
    expect(handleListRowActionKeys("m", key({ meta: true }), ctx)).toBe(false);
    expect(handleListRowActionKeys("x", NONE, ctx)).toBe(false);
    expect(ctx.setNotice).not.toHaveBeenCalled();
    expect(handleListRowActionKeys("o", key({ ctrl: true }), ctx)).toBe(true);
    expect(ctx.setMode).toHaveBeenCalledTimes(1);
  });
});
