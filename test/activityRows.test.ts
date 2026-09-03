// The sub-rows under an expanded session (src/ui/rows.ts `activityRows`). The
// e2e suite expands sessions whose fixture logs carry a prompt, tasks and
// actions; it never expands one that is still loading, one whose log could not
// be read, one with tasks but no actions, or one with a prompt and nothing else.
import { describe, expect, test } from "bun:test";
import type { ActionLine, SessionActivity } from "../src/types.ts";
import { activityRows } from "../src/ui/rows.ts";

const action = (verb: string): ActionLine => ({ timestamp: new Date(0), verb, detail: "d" }) as ActionLine;
const kinds = (act: SessionActivity | "loading" | "error" | undefined) => activityRows("k", act).map((r) => `${r.kind}:${(r as { key?: string }).key}`);

describe("activityRows", () => {
  test("a note while loading and when the log could not be read", () => {
    expect(activityRows("k", undefined)).toEqual([{ kind: "sessnote", key: "k:note", text: "loading activity…" }]);
    expect(kinds("loading")).toEqual(["sessnote:k:note"]);
    expect(activityRows("k", "error")).toEqual([{ kind: "sessnote", key: "k:note", text: "couldn't read session log" }]);
  });

  test("the prompt, then the tasks, then the actions, each keyed by its index", () => {
    const act: SessionActivity = { lastPrompt: "p", tasks: [{ label: "t", status: "pending" }], actions: [action("Read"), action("Edit")] };
    expect(kinds(act)).toEqual(["sessprompt:k:prompt", "task:k:t0", "action:k:a0", "action:k:a1"]);
  });

  test("tasks alone are worth showing; a prompt alone, or nothing, gets the empty note", () => {
    expect(kinds({ tasks: [{ label: "t", status: "completed" }], actions: [] })).toEqual(["task:k:t0"]);
    expect(kinds({ lastPrompt: "p", actions: [] })).toEqual(["sessprompt:k:prompt", "sessnote:k:note"]);
    expect(activityRows("k", { actions: [] })).toEqual([{ kind: "sessnote", key: "k:note", text: "no recent activity" }]);
  });
});
