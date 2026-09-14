// The re-render gate on a session's activity (src/ui/models/equality.ts
// `sameActivity`). The e2e suite expands rows whose activity only ever grows
// at the tail; it never sees the head shift under a full window, a task change
// its status with the actions unchanged, or a prompt change alone.
//
// Also the tmux-identity gates `sameLiveWindows`/`sameLocations`: pure structural
// checks, so a case the e2e polling suite would need several real ticks to hit
// (a pane-hosted session's HOST session getting renamed between polls, with the
// pane id unchanged) is cheap to pin here instead.
import { describe, expect, test } from "bun:test";
import type { ActionLine, SessionActivity, TaskItem } from "../src/shared/types.ts";
import type { LiveTarget } from "../src/runtime/tmux/index.ts";
import { sameActivity, sameLiveWindows, sameLocations } from "../src/ui/models/equality.ts";

const at = (t: number, verb = "Read", detail = "a.ts"): ActionLine => ({ timestamp: new Date(t), verb, detail }) as ActionLine;
const task = (label: string, status: TaskItem["status"] = "pending"): TaskItem => ({ label, status });
const act = (over: Partial<SessionActivity> = {}): SessionActivity => ({ lastPrompt: "p", actions: [at(1), at(2), at(3)], tasks: [task("t")], ...over });

describe("sameActivity", () => {
  test("loading, error and undefined never equal anything, not even themselves", () => {
    expect(sameActivity("loading", "loading")).toBe(false);
    expect(sameActivity("error", "error")).toBe(false);
    expect(sameActivity(undefined, act())).toBe(false);
    expect(sameActivity(act(), undefined)).toBe(false);
  });

  test("equal when the prompt, the tasks and both ends of the action window agree", () => {
    expect(sameActivity(act(), act())).toBe(true);
    expect(sameActivity(act({ actions: [] }), act({ actions: [] }))).toBe(true);
    expect(sameActivity(act({ tasks: undefined }), act({ tasks: [] }))).toBe(true);
    expect(sameActivity(act({ actions: [at(1), at(9), at(3)] }), act())).toBe(true);
  });

  test("a changed prompt, task, count, head or tail is a change", () => {
    expect(sameActivity(act({ lastPrompt: "q" }), act())).toBe(false);
    expect(sameActivity(act({ tasks: [task("t", "completed")] }), act())).toBe(false);
    expect(sameActivity(act({ tasks: [task("t"), task("u")] }), act())).toBe(false);
    expect(sameActivity(act({ actions: [at(1), at(2)] }), act())).toBe(false);
    expect(sameActivity(act({ actions: [at(0), at(2), at(3)] }), act())).toBe(false);
    expect(sameActivity(act({ actions: [at(1), at(2), at(3, "Edit")] }), act())).toBe(false);
    expect(sameActivity(act({ actions: [at(1), at(2), at(3, "Read", "b.ts")] }), act())).toBe(false);
  });
});

const win = (over: Partial<LiveTarget> = {}): LiveTarget =>
  ({ name: "cl-claude-x", target: "=agendo:=cl-claude-x", session: "agendo", windowIndex: "2", ...over }) as LiveTarget;

describe("sameLiveWindows", () => {
  test("equal maps, same content", () => {
    expect(sameLiveWindows(new Map([["cl-claude-x", win()]]), new Map([["cl-claude-x", win()]]))).toBe(true);
  });

  test("a different key set is never equal", () => {
    expect(sameLiveWindows(new Map([["cl-claude-x", win()]]), new Map())).toBe(false);
    expect(sameLiveWindows(new Map([["cl-claude-x", win()]]), new Map([["cl-claude-y", win()]]))).toBe(false);
  });

  test("a changed name, target or windowIndex is a change", () => {
    const a = new Map([["cl-claude-x", win()]]);
    expect(sameLiveWindows(a, new Map([["cl-claude-x", win({ name: "cl-claude-y" })]]))).toBe(false);
    expect(sameLiveWindows(a, new Map([["cl-claude-x", win({ target: "%9" })]]))).toBe(false);
    expect(sameLiveWindows(a, new Map([["cl-claude-x", win({ windowIndex: "3" })]]))).toBe(false);
  });

  // Regression: a pane-hosted target's `target` is a bare pane id (`%N`) that
  // never encodes its host session, unlike a window target (`windowTarget`
  // embeds the session). Only comparing `.session` itself catches its host
  // being renamed between polls — dropping this check would leave a stale host
  // name on the expanded row's tmux line.
  test("a pane-hosted target whose HOST SESSION was renamed (pane id unchanged) is a change", () => {
    const a = new Map([["cl-bg-orch", win({ target: "%4", windowIndex: null, session: "agendo" })]]);
    const b = new Map([["cl-bg-orch", win({ target: "%4", windowIndex: null, session: "work" })]]);
    expect(sameLiveWindows(a, b)).toBe(false);
  });
});

describe("sameLocations", () => {
  test("equal, same order", () => {
    expect(sameLocations(new Map([["cl-claude-x", ["agendo:2", "work:0"]]]), new Map([["cl-claude-x", ["agendo:2", "work:0"]]]))).toBe(true);
  });

  test("a different key set, length, or order is a change", () => {
    const a = new Map([["cl-claude-x", ["agendo:2", "work:0"]]]);
    expect(sameLocations(a, new Map())).toBe(false);
    expect(sameLocations(a, new Map([["cl-claude-x", ["agendo:2"]]]))).toBe(false);
    expect(sameLocations(a, new Map([["cl-claude-x", ["work:0", "agendo:2"]]]))).toBe(false);
  });
});
