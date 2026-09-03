// The list screen's view-level keys (src/ui/keys/list.ts). The e2e suite
// presses most of them on the way through its flows; what it never does is
// group or re-sort the sessions view, press `a` or `f` with no path scope, or
// wrap the view tabs backwards from the first. Each binding sits beside the one
// next to it, on a context of mocks, with the state updaters it hands React
// called by hand.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { View } from "../src/ui/keys/context.ts";
import {
  handleGroupSortKeys, handleListViewKeys, handleScopeKeys, handleScreenKeys, handleViewSwitchKeys, refreshList,
} from "../src/ui/keys/list.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });

/** The updater a mocked setter was last handed, applied to a value. */
const updated = <T,>(setter: ReturnType<typeof mock>, from: T): T => (setter.mock.calls.at(-1)![0] as (v: T) => T)(from);

function ctxIn(view: View, filterRoot: string | null = "/w") {
  return {
    view, filterRoot,
    switchView: mock(), setCursor: mock(), setGlobalView: mock(), setRepoFilterOn: mock(),
    setGrouped: mock(), setPrsGrouped: mock(), setPrSort: mock(), setSessionSort: mock(),
    enterNewSession: mock(), enterOrchestrator: mock(), enterGlobalOrchestrator: mock(),
    setSearchFocus: mock(), enterSettings: mock(), enterIdentity: mock(),
    setNotice: mock(), setActivity: mock(), requested: { current: new Set<string>(["x"]) }, setRescanKey: mock(), reload: mock(),
  };
}

describe("view switching", () => {
  test("tab cycles forward and wraps; shift-tab backward and wraps; digits jump", () => {
    const c = ctxIn("sessions");
    expect(handleViewSwitchKeys("", key({ tab: true }), c)).toBe(true);
    expect(c.switchView).toHaveBeenLastCalledWith("items");
    expect(handleViewSwitchKeys("", key({ tab: true, shift: true }), ctxIn("items")).valueOf()).toBe(true);
    const back = ctxIn("items");
    handleViewSwitchKeys("", key({ tab: true, shift: true }), back);
    expect(back.switchView).toHaveBeenLastCalledWith("sessions");
    for (const [k, v] of [["1", "items"], ["2", "prs"], ["3", "sessions"]] as const) {
      const d = ctxIn("prs");
      expect(handleViewSwitchKeys(k, NONE, d)).toBe(true);
      expect(d.switchView).toHaveBeenLastCalledWith(v);
    }
    expect(handleViewSwitchKeys("4", NONE, c)).toBe(false);
  });
});

describe("scope keys", () => {
  test("a and f flip their toggles and reset the cursor, only under a path scope", () => {
    const c = ctxIn("items");
    expect(handleScopeKeys("a", c)).toBe(true);
    expect(updated(c.setGlobalView, false)).toBe(true);
    expect(handleScopeKeys("f", c)).toBe(true);
    expect(updated(c.setRepoFilterOn, true)).toBe(false);
    expect(c.setCursor).toHaveBeenCalledTimes(2);
    expect(handleScopeKeys("z", c)).toBe(false);
    const global = ctxIn("items", null);
    expect(handleScopeKeys("a", global)).toBe(false);
    expect(handleScopeKeys("f", global)).toBe(false);
    expect(global.setCursor).not.toHaveBeenCalled();
  });
});

describe("group and sort keys", () => {
  test("sessions: g groups the view, s flips updated ↔ created", () => {
    const c = ctxIn("sessions");
    expect(handleGroupSortKeys("g", c)).toBe(true);
    expect(updated(c.setGrouped, false)).toBe(true);
    expect(handleGroupSortKeys("s", c)).toBe(true);
    expect(updated(c.setSessionSort, "updated")).toBe("created");
    expect(updated(c.setSessionSort, "created")).toBe("updated");
    expect(c.setPrsGrouped).not.toHaveBeenCalled();
  });

  test("PRs: g groups the sections, s flips created ↔ updated; items: neither", () => {
    const c = ctxIn("prs");
    expect(handleGroupSortKeys("g", c)).toBe(true);
    expect(updated(c.setPrsGrouped, true)).toBe(false);
    expect(handleGroupSortKeys("s", c)).toBe(true);
    expect(updated(c.setPrSort, "created")).toBe("updated");
    expect(updated(c.setPrSort, "updated")).toBe("created");
    const items = ctxIn("items");
    expect(handleGroupSortKeys("g", items)).toBe(false);
    expect(handleGroupSortKeys("s", items)).toBe(false);
    expect(items.setCursor).not.toHaveBeenCalled();
  });
});

describe("screen keys and refresh", () => {
  test("/ focuses the search, comma opens settings, u the identity picker", () => {
    const c = ctxIn("items");
    expect(handleScreenKeys("/", c)).toBe(true);
    expect(c.setSearchFocus).toHaveBeenCalledWith("input");
    expect(handleScreenKeys(",", c)).toBe(true);
    expect(c.enterSettings).toHaveBeenCalled();
    expect(handleScreenKeys("u", c)).toBe(true);
    expect(c.enterIdentity).toHaveBeenCalled();
    expect(handleScreenKeys("q", c)).toBe(false);
  });

  test("r clears the notice and the activity cache, bumps the rescan key, reloads", () => {
    const c = ctxIn("items");
    refreshList(c);
    expect(c.setNotice).toHaveBeenCalledWith(null);
    expect((c.setActivity.mock.calls[0]![0] as Map<string, unknown>).size).toBe(0);
    expect(c.requested.current.size).toBe(0);
    expect(updated(c.setRescanKey, 3)).toBe(4);
    expect(c.reload).toHaveBeenCalled();
  });

  test("the dispatcher: every group in turn, r last, anything else declined", () => {
    const c = ctxIn("sessions");
    expect(handleListViewKeys("r", NONE, c)).toBe(true);
    expect(c.reload).toHaveBeenCalled();
    expect(handleListViewKeys("n", NONE, c)).toBe(true);
    expect(c.enterNewSession).toHaveBeenCalled();
    expect(handleListViewKeys("q", NONE, c)).toBe(false);
  });
});
