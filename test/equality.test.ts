// The re-render gate on a session's activity (src/ui/equality.ts
// `sameActivity`). The e2e suite expands rows whose activity only ever grows
// at the tail; it never sees the head shift under a full window, a task change
// its status with the actions unchanged, or a prompt change alone.
import { describe, expect, test } from "bun:test";
import type { ActionLine, SessionActivity, TaskItem } from "../src/types.ts";
import { sameActivity } from "../src/ui/equality.ts";

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
