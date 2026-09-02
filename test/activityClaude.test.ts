// The claude activity reader. The e2e fixtures expand a claude row, so the
// happy path (a prompt, a Bash call, a text reply) runs under Playwright; what
// never did is the rest of the tool vocabulary, the des-workflow Task* replay,
// the TodoWrite/replay precedence, the task-notification guard and the
// tool_result shape of a "user" record. Those are the branches here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeAction, loadClaudeActivity, newTaskReplay, parseClaudeLog, recordTaskEvent, replayedTasks, todosToTasks, userText } from "../src/activity/claude.ts";
import { ACTIVITY_LIMIT } from "../src/activity/common.ts";
import type { ActionLine } from "../src/types.ts";

const T0 = "2026-06-18T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const jsonl = (records: unknown[]) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const verbs = (actions: ActionLine[]) => actions.map((a) => `${a.verb}: ${a.detail}`);

const user = (s: number, content: unknown) => ({ type: "user", timestamp: at(s), message: { content } });
const assistant = (s: number, content: unknown) => ({ type: "assistant", timestamp: at(s), message: { content } });
const tool = (name: string, input: unknown) => ({ type: "tool_use", name, input });
const text = (t: string) => ({ type: "text", text: t });

describe("parseClaudeLog", () => {
  test("keeps the last prompt, the last reply, the checklist and the action tail", () => {
    const log = jsonl([
      user(0, "Fix the  flaky test"),
      assistant(1, [{ type: "thinking", thinking: "h".repeat(80) }, tool("Read", { file_path: "/home/u/repo/src/ui/x.ts" })]),
      user(2, [{ type: "tool_result", content: "file contents" }]),
      assistant(3, [tool("TodoWrite", { todos: [{ content: "Read it", status: "completed" }, { activeForm: "Fixing", status: "in_progress" }] })]),
      assistant(4, [text("All fixed."), tool("Bash", { command: "bun  test" })]),
    ]);
    const a = parseClaudeLog(log, "t.jsonl");
    expect(a.lastPrompt).toBe("Fix the flaky test");
    expect(a.finalResponse).toBe("All fixed.");
    expect(a.tasks).toEqual([
      { label: "Read it", status: "completed" },
      { label: "Fixing", status: "in_progress" },
    ]);
    expect(verbs(a.actions)).toEqual(["Thinking: ~20 tokens", "Read: …/ui/x.ts", "Claude: All fixed.", "Bash: bun test"]);
    expect(a.actions.map((x) => x.deltaMs)).toEqual([undefined, 0, 3000, 0]);
  });

  test("a new prompt clears the reply; a task-notification and a tool_result do not", () => {
    const a = parseClaudeLog(jsonl([assistant(1, [text("done")]), user(2, "<task-notification>agent finished</task-notification>"), user(3, [{ type: "tool_result", content: "x" }]), user(4, [text("  "), text("really next")])]), "t");
    expect(a.lastPrompt).toBe("really next");
    expect(a.finalResponse).toBeUndefined();
    const b = parseClaudeLog(jsonl([user(1, "first"), assistant(2, [text("done")]), user(3, "<task-notification>x</task-notification>")]), "t");
    expect(b.lastPrompt).toBe("first");
    expect(b.finalResponse).toBe("done");
  });

  test("the Task* replay is the checklist when no TodoWrite ever ran, and an empty TodoWrite does not blank it", () => {
    const a = parseClaudeLog(
      jsonl([
        assistant(1, [tool("TaskCreate", { subject: "one" }), tool("TaskCreate", { subject: "two" }), tool("TaskCreate", { taskId: "x9", subject: "nine", status: "active" })]),
        assistant(2, [tool("TaskUpdate", { taskId: "1", status: "closed" }), tool("TaskUpdate", { id: "2", status: "deleted" }), tool("TaskUpdate", { taskId: "x9", subject: "nine renamed" })]),
        assistant(3, [tool("TodoWrite", { todos: [] }), tool("TodoWrite", { todos: [{ content: "" }, 5] }), tool("TodoWrite", null)]),
      ]),
      "t",
    );
    expect(a.tasks).toEqual([
      { label: "one", status: "completed" },
      { label: "nine renamed", status: "in_progress" },
    ]);
    expect(verbs(a.actions)).toEqual(["TaskCreate: one", "TaskCreate: two", "TaskCreate: nine", "Task #1: → closed", "Task #2: → deleted", "Task #x9: → "]);
  });

  test("a non-empty TodoWrite wins over the replay, whichever came first", () => {
    const a = parseClaudeLog(jsonl([assistant(1, [tool("TodoWrite", { todos: [{ task: "from todos" }] })]), assistant(2, [tool("TaskCreate", { subject: "from replay" })])]), "t");
    expect(a.tasks).toEqual([{ label: "from todos", status: "pending" }]);
  });

  test("skips torn lines, primitives and records without a message; unknown block types add nothing", () => {
    const a = parseClaudeLog(jsonl(['{"type":"assistant","message":{', "42", { type: "user" }, { type: "assistant", message: { content: "not an array" } }, assistant(1, [{ type: "image" }, { type: "thinking", thinking: "" }, text(" ")]), user(2, "ok")]), "t");
    expect(a.lastPrompt).toBe("ok");
    expect(a.actions).toEqual([]);
    expect(a.finalResponse).toBeUndefined();
  });

  test("--full keeps whole prompts and replies; the action tail is capped", () => {
    const long = "x".repeat(300);
    const many = Array.from({ length: ACTIVITY_LIMIT + 2 }, (_, i) => tool("Bash", { command: `cmd ${i}` }));
    const log = jsonl([user(1, long), assistant(2, [text(long), ...many])]);
    expect(parseClaudeLog(log, "t").lastPrompt).toHaveLength(200);
    expect(parseClaudeLog(log, "t", true).lastPrompt).toHaveLength(300);
    expect(parseClaudeLog(log, "t", true).finalResponse).toHaveLength(300);
    const a = parseClaudeLog(log, "t");
    expect(a.actions).toHaveLength(ACTIVITY_LIMIT);
    expect(a.actions[0].detail).toBe("cmd 2");
    expect(a.actions[0].deltaMs).toBe(0);
  });
});

describe("claudeAction", () => {
  const ts = new Date(T0);
  const detail = (name: string, input: unknown, full = false) => {
    const a = claudeAction(tool(name, input), ts, full)!;
    return `${a.verb}: ${a.detail}`;
  };

  test("renders every tool it knows", () => {
    expect(detail("Write", { file_path: "/home/u/repo/src/a.ts" })).toBe("Write: …/src/a.ts");
    expect(detail("Edit", { file_path: "a/b.ts" })).toBe("Edit: a/b.ts");
    expect(detail("Read", {})).toBe("Read: ");
    expect(detail("Bash", { command: "  git   status " })).toBe("Bash: git status");
    expect(detail("Agent", { subagent_type: "Explore", description: "find it" })).toBe("Agent: [Explore] find it");
    expect(detail("Agent", {})).toBe("Agent: ");
    expect(detail("Workflow", { name: "review-changes" })).toBe("Workflow: review-changes");
    expect(detail("Workflow", { scriptPath: "/home/u/repo/.claude/workflows/w.js" })).toBe("Workflow: …/workflows/w.js");
    expect(detail("Workflow", { script: "export const meta = {}" })).toBe("Workflow: (inline script)");
    expect(detail("TaskCreate", { subject: "s" })).toBe("TaskCreate: s");
    expect(detail("TaskCreate", { title: "t" })).toBe("TaskCreate: t");
    expect(detail("TaskCreate", {})).toBe("TaskCreate: ");
    expect(detail("TaskUpdate", { taskId: "3", status: "closed" })).toBe("Task #3: → closed");
    expect(detail("TaskUpdate", { id: "4" })).toBe("Task #4: → ");
    expect(detail("TaskUpdate", {})).toBe("Task #?: → ");
  });

  test("an unknown tool shows its first argument, cut unless --full; a nameless one shows ?", () => {
    expect(detail("Grep", { pattern: "TODO", path: "src" })).toBe("Grep: TODO");
    expect(detail("Grep", { pattern: "p".repeat(100) })).toHaveLength("Grep: ".length + 80);
    expect(detail("Grep", { pattern: "p".repeat(100) }, true)).toHaveLength("Grep: ".length + 100);
    expect(claudeAction({ type: "tool_use" }, ts)!.verb).toBe("?");
  });

  test("cuts long commands unless --full, and returns null for TodoWrite and unknown block types", () => {
    const command = "c".repeat(150);
    expect(detail("Bash", { command })).toHaveLength("Bash: ".length + 120);
    expect(detail("Bash", { command }, true)).toHaveLength("Bash: ".length + 150);
    expect(claudeAction(tool("TodoWrite", { todos: [] }), ts)).toBeNull();
    expect(claudeAction({ type: "image" }, ts)).toBeNull();
    expect(claudeAction({ type: "thinking" }, ts)).toBeNull();
    expect(claudeAction({ type: "text", text: 7 }, ts)).toBeNull();
  });
});

describe("the Task* replay", () => {
  test("creates correlate with updates by ordinal id, by explicit id, and by subject", () => {
    const st = newTaskReplay();
    recordTaskEvent("TaskCreate", { subject: "a" }, st);
    recordTaskEvent("TaskCreate", { id: "k", title: "b", status: "not started" }, st);
    recordTaskEvent("TaskCreate", { subject: "c" }, st);
    recordTaskEvent("TaskUpdate", { taskId: "2", status: "in-progress" }, st); // "2": the second SYNTHESIZED id, so "c"
    recordTaskEvent("TaskUpdate", { subject: "k", status: "done" }, st); // keyed by subject, which also becomes the label
    recordTaskEvent("TaskUpdate", { taskId: "new", subject: "d" }, st);
    recordTaskEvent("TaskUpdate", { taskId: "k", subject: "" }, st); // a blank subject keeps the label
    recordTaskEvent("TaskUpdate", {}, st); // no key at all
    expect(replayedTasks(st)).toEqual([
      { label: "a", status: "pending" },
      { label: "k", status: "completed" },
      { label: "c", status: "in_progress" },
      { label: "d", status: "pending" },
    ]);
  });

  test("a removal drops the task and its slot; removing an unknown id is a no-op; a blank create id is ignored", () => {
    const st = newTaskReplay();
    recordTaskEvent("TaskCreate", { subject: "a" }, st);
    recordTaskEvent("TaskCreate", { subject: "b" }, st);
    recordTaskEvent("TaskUpdate", { taskId: "1", status: "cancelled" }, st);
    recordTaskEvent("TaskUpdate", { taskId: "zz", status: "removed" }, st);
    recordTaskEvent("TaskCreate", { taskId: " ", subject: "blank" }, st);
    recordTaskEvent("TaskCreate", { taskId: "2", subject: "b again", status: "closed" }, st); // re-create keeps the slot
    expect(replayedTasks(st)).toEqual([{ label: "b again", status: "completed" }]);
  });
});

describe("todosToTasks and userText", () => {
  test("todosToTasks is null for a non-list, an empty list and a list with no usable item", () => {
    expect(todosToTasks(undefined)).toBeNull();
    expect(todosToTasks({ todos: "later" })).toBeNull();
    expect(todosToTasks({ todos: [] })).toBeNull();
    expect(todosToTasks({ todos: [null, "x", { status: "done" }] })).toBeNull();
    expect(todosToTasks({ todos: [{ content: " a ", status: "done" }] })).toEqual([{ label: "a", status: "completed" }]);
  });

  test("userText reads a string or the text blocks, and nothing else", () => {
    expect(userText("  hello  world ")).toBe("hello world");
    expect(userText("---")).toBeUndefined();
    expect(userText([text("a"), { type: "tool_result", content: "b" }, { type: "text" }, text("c")])).toBe("a c");
    expect(userText([{ type: "tool_result" }])).toBeUndefined();
    expect(userText({ text: "object" })).toBeUndefined();
  });
});

describe("loading from disk", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agendo-claude-"));
    writeFileSync(join(dir, "t.jsonl"), jsonl([user(1, "from disk")]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("reads the transcript, and is empty for no path or a missing file", async () => {
    expect((await loadClaudeActivity(join(dir, "t.jsonl"))).lastPrompt).toBe("from disk");
    expect(await loadClaudeActivity(undefined)).toEqual({ actions: [] });
    expect(await loadClaudeActivity(join(dir, "nope.jsonl"))).toEqual({ actions: [] });
  });
});
