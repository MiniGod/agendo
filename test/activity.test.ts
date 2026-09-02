// The codex and copilot activity readers. The e2e fixtures write a rollout and
// an events.jsonl for each, but no spec ever expands those rows, so — as the
// CRAP table showed — not one line of either reader had run under any suite.
// The records here mirror the fixture shapes (e2e/harness/fixtures.ts) plus
// the branches a fixture never takes: every tool name each reader renders, the
// two codex call shapes, torn and primitive lines, and the display cuts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadActivity } from "../src/activity.ts";
import { codexAction, codexPlanToTasks, loadCodexActivity, parseCodexLog } from "../src/activity/codex.ts";
import { ACTIVITY_LIMIT, finalizeActivity, shortPath } from "../src/activity/common.ts";
import { copilotAction, loadCopilotActivity, parseCopilotEvents } from "../src/activity/copilot.ts";
import type { ActionLine } from "../src/types.ts";

const T0 = "2026-06-18T08:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const jsonl = (records: unknown[]) => records.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n") + "\n";
const verbs = (actions: ActionLine[]) => actions.map((a) => `${a.verb}: ${a.detail}`);

// ── codex ───────────────────────────────────────────────────────────────────

const item = (s: number, payload: Record<string, unknown>) => ({ type: "response_item", timestamp: at(s), payload });
const userTurn = (s: number, text: string) => item(s, { type: "message", role: "user", content: [{ type: "input_text", text }] });
const assistantTurn = (s: number, text: string) =>
  item(s, { type: "message", role: "assistant", content: [{ type: "output_text", text }, { type: "refusal", text: "no" }] });
const call = (s: number, name: string, args: unknown) => item(s, { type: "function_call", name, arguments: JSON.stringify(args) });
const customCall = (s: number, name: string, input: string) => item(s, { type: "custom_tool_call", name, input });

describe("parseCodexLog", () => {
  test("keeps the last prompt, the last reply, the latest plan and the action tail", () => {
    const log = jsonl([
      { type: "session_meta", timestamp: T0, payload: { id: "x" } },
      userTurn(1, "Tidy the   util helpers"),
      call(2, "update_plan", { plan: [{ step: "Read the helpers", status: "completed" }, { step: "Simplify", status: "in_progress" }] }),
      item(3, { type: "reasoning", summary: [{ type: "summary_text", text: "a".repeat(40) }] }),
      call(4, "shell", { command: ["bash", "-lc", "bun test"] }),
      assistantTurn(5, "Done, all green."),
    ]);
    const a = parseCodexLog(log);
    expect(a.lastPrompt).toBe("Tidy the util helpers");
    expect(a.finalResponse).toBe("Done, all green.");
    expect(a.tasks).toEqual([
      { label: "Read the helpers", status: "completed" },
      { label: "Simplify", status: "in_progress" },
    ]);
    expect(verbs(a.actions)).toEqual(["Thinking: ~10 tokens", "Bash: bash -lc bun test", "Codex: Done, all green."]);
    expect(a.actions.map((x) => x.deltaMs)).toEqual([undefined, 1000, 1000]);
  });

  test("a new prompt clears the previous turn's reply; the action tail is capped", () => {
    const calls = Array.from({ length: ACTIVITY_LIMIT + 3 }, (_, i) => call(10 + i, "shell_command", { command: `cmd ${i}` }));
    const a = parseCodexLog(jsonl([assistantTurn(1, "old answer"), userTurn(2, "again"), ...calls]));
    expect(a.finalResponse).toBeUndefined();
    expect(a.actions).toHaveLength(ACTIVITY_LIMIT);
    expect(a.actions[0].detail).toBe("cmd 3");
    expect(a.actions[0].deltaMs).toBe(1000); // measured against the action that was cut
  });

  test("an empty or malformed update_plan does not blank out the last good plan", () => {
    const a = parseCodexLog(
      jsonl([call(1, "update_plan", { plan: [{ step: "keep me" }] }), call(2, "update_plan", { plan: [] }), call(3, "update_plan", { plan: [{ status: "done" }] }), customCall(4, "update_plan", "not json")]),
    );
    expect(a.tasks).toEqual([{ label: "keep me", status: "pending" }]);
    expect(a.actions).toEqual([]); // update_plan is the checklist, never an action line
  });

  test("skips torn lines, primitives, other record types and payload-less records", () => {
    const a = parseCodexLog(jsonl(['{"type":"response_item","payload":{"type":"message"', "42", "null", { type: "event_msg", payload: { type: "message" } }, { type: "response_item" }, userTurn(1, "hi")]));
    expect(a.lastPrompt).toBe("hi");
    expect(a.actions).toEqual([]);
  });

  test("a reasoning record without visible summary text and a reply without text add nothing", () => {
    const a = parseCodexLog(
      jsonl([item(1, { type: "reasoning", summary: [{ type: "summary_text" }] }), item(2, { type: "reasoning" }), item(3, { type: "message", role: "assistant", content: [{ type: "output_text", text: "  " }] }), item(4, { type: "message", role: "assistant" })]),
    );
    expect(a.actions).toEqual([]);
    expect(a.finalResponse).toBeUndefined();
  });

  test("--full keeps whole prompts and replies; the default cuts them", () => {
    const long = "x".repeat(300);
    const log = jsonl([userTurn(1, long), assistantTurn(2, long)]);
    expect(parseCodexLog(log).lastPrompt).toHaveLength(200);
    expect(parseCodexLog(log).actions[0].detail).toHaveLength(200);
    expect(parseCodexLog(log, true).lastPrompt).toHaveLength(300);
    expect(parseCodexLog(log, true).actions[0].detail).toHaveLength(300);
  });

  test("a record without a timestamp sits at the epoch and earns no delta", () => {
    const a = parseCodexLog(jsonl([{ type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } }, call(5, "shell", { cmd: "ls" })]));
    expect(a.actions[0].timestamp.getTime()).toBe(0);
    expect(a.actions[1].deltaMs).toBeUndefined();
  });
});

describe("codexAction", () => {
  const ts = new Date(T0);
  const detail = (name: string, args: unknown, raw = "", full = false) => {
    const a = codexAction(name, args, raw, ts, full);
    return `${a.verb}: ${a.detail}`;
  };

  test("renders every tool it knows", () => {
    expect(detail("shell", { command: ["bash", "-lc", "make"] })).toBe("Bash: bash -lc make");
    expect(detail("shell_command", { command: "git  status" })).toBe("Bash: git status");
    expect(detail("shell", null, "raw fallback")).toBe("Bash: raw fallback");
    expect(detail("exec", null, "await tools.exec_command('ls')")).toBe("Exec: await tools.exec_command('ls')");
    expect(detail("apply_patch", null, "*** Begin Patch\n*** Update File: /home/u/repo/src/a.ts\n*** Add File: b.ts\n*** End Patch")).toBe("Edit: …/src/a.ts, b.ts");
    expect(detail("apply_patch", null, "garbage")).toBe("Edit: (patch)");
    expect(detail("view_image", { path: "/home/u/repo/docs/img/x.png" })).toBe("Read: …/img/x.png");
    expect(detail("view_image", null)).toBe("Read: ");
    expect(detail("spawn_agent", { task_name: "review" })).toBe("Agent: review");
    expect(detail("spawn_agent", { name: "guardian" })).toBe("Agent: guardian");
    expect(detail("spawn_agent", null)).toBe("Agent: ");
  });

  test("an unknown tool shows its first argument, or the raw input when there is none", () => {
    expect(detail("web_search", { query: "bun test preload" })).toBe("web_search: bun test preload");
    expect(detail("mystery", null, "the raw input")).toBe("mystery: the raw input");
    expect(detail("mystery", { q: "y".repeat(100) })).toHaveLength("mystery: ".length + 80);
    expect(detail("mystery", { q: "y".repeat(100) }, "", true)).toHaveLength("mystery: ".length + 100);
  });

  test("cuts long commands unless --full", () => {
    const cmd = "c".repeat(150);
    expect(detail("shell_command", { command: cmd })).toHaveLength("Bash: ".length + 120);
    expect(detail("shell_command", { command: cmd }, "", true)).toHaveLength("Bash: ".length + 150);
  });
});

describe("codexPlanToTasks", () => {
  test("maps steps onto the checklist and drops the unusable ones", () => {
    expect(codexPlanToTasks({ plan: [{ step: "a", status: "completed" }, { content: "b" }, null, { status: "done" }, 7] })).toEqual([
      { label: "a", status: "completed" },
      { label: "b", status: "pending" },
    ]);
  });

  test("is null for a non-plan, a non-array plan and an empty one", () => {
    expect(codexPlanToTasks(null)).toBeNull();
    expect(codexPlanToTasks({ plan: "later" })).toBeNull();
    expect(codexPlanToTasks({ plan: [] })).toBeNull();
  });
});

// ── copilot ─────────────────────────────────────────────────────────────────

const userMsg = (s: number, content: unknown) => ({ type: "user.message", timestamp: at(s), data: { content } });
const reply = (s: number, content: unknown, toolRequests?: unknown) => ({ type: "assistant.message", timestamp: at(s), data: { content, toolRequests } });

describe("parseCopilotEvents", () => {
  test("mirrors the e2e fixture: a prompt, a tool turn and a text turn", () => {
    const log = jsonl([
      userMsg(0, "Try the  experiment"),
      reply(3, "", [{ name: "bash", arguments: { command: "npm test" } }]),
      reply(6, "Looks good.", []),
    ]);
    const a = parseCopilotEvents(log, "events.jsonl");
    expect(a.lastPrompt).toBe("Try the experiment");
    expect(a.finalResponse).toBe("Looks good.");
    expect(a.tasks).toBeUndefined();
    expect(verbs(a.actions)).toEqual(["Bash: npm test", "Copilot: Looks good."]);
    expect(a.actions[1].deltaMs).toBe(3000);
  });

  test("a reply with both text and tool requests is shown as its requests, and its text is the final response", () => {
    const a = parseCopilotEvents(jsonl([reply(1, "Let me look.", [{ name: "view", arguments: { path: "/home/u/r/src/x.ts" } }])]), "e");
    expect(verbs(a.actions)).toEqual(["View: …/src/x.ts"]);
    expect(a.finalResponse).toBe("Let me look.");
  });

  test("intent pings are dropped, a new prompt clears the reply, blank prompts and non-string content are ignored", () => {
    const a = parseCopilotEvents(
      jsonl([reply(1, "first", []), reply(2, "", [{ name: "report_intent", arguments: { intent: "Reading" } }]), userMsg(3, "   "), userMsg(4, { nested: true }), userMsg(5, "next"), reply(6, { not: "text" }, "nope")]),
      "e",
    );
    expect(a.lastPrompt).toBe("next");
    expect(a.finalResponse).toBeUndefined();
    expect(verbs(a.actions)).toEqual(["Copilot: first"]);
  });

  test("skips torn lines, primitives and events without data", () => {
    const a = parseCopilotEvents(jsonl(['{"type":"user.message"', "7", { type: "user.message" }, { type: "assistant.message" }, userMsg(1, "ok")]), "e");
    expect(a.lastPrompt).toBe("ok");
    expect(a.actions).toEqual([]);
  });

  test("--full keeps whole prompts and replies", () => {
    const long = "p".repeat(300);
    const log = jsonl([userMsg(1, long), reply(2, long, [])]);
    expect(parseCopilotEvents(log, "e").lastPrompt).toHaveLength(200);
    expect(parseCopilotEvents(log, "e").actions[0].detail).toHaveLength(200);
    expect(parseCopilotEvents(log, "e", true).lastPrompt).toHaveLength(300);
    expect(parseCopilotEvents(log, "e", true).actions[0].detail).toHaveLength(300);
  });
});

describe("copilotAction", () => {
  const ts = new Date(T0);
  const detail = (name: string, args?: unknown, full = false) => {
    const a = copilotAction({ name, arguments: args }, ts, full);
    return `${a.verb}: ${a.detail}`;
  };

  test("renders every tool it knows", () => {
    expect(detail("view", { path: "/home/u/repo/src/ui/x.ts" })).toBe("View: …/ui/x.ts");
    expect(detail("create", { path: "a/b.ts" })).toBe("Create: a/b.ts");
    expect(detail("edit", {})).toBe("Edit: ");
    expect(detail("bash", { command: "  npm   test " })).toBe("Bash: npm test");
    expect(detail("grep", { pattern: "TODO" })).toBe("Grep: TODO");
    expect(detail("glob", {})).toBe("Glob: ");
    expect(detail("task", { agent_type: "explore", description: "find it" })).toBe("Agent: [explore] find it");
    expect(detail("task", { name: "fallback" })).toBe("Agent: fallback");
    expect(detail("ask_user", { message: "m".repeat(100) })).toHaveLength("AskUser: ".length + 80);
    expect(detail("report_intent", { intent: "Reading" })).toBe("Intent: Reading");
  });

  test("an unknown tool shows its first argument; a nameless request shows ?", () => {
    expect(detail("web_fetch", { url: "https://example.test", other: "x" })).toBe("web_fetch: https://example.test");
    expect(detail("web_fetch", { url: "u".repeat(100) })).toHaveLength("web_fetch: ".length + 80);
    expect(detail("web_fetch", { url: "u".repeat(100) }, true)).toHaveLength("web_fetch: ".length + 100);
    expect(copilotAction({}, ts).verb).toBe("?");
  });

  test("cuts long commands unless --full", () => {
    const command = "c".repeat(150);
    expect(detail("bash", { command })).toHaveLength("Bash: ".length + 120);
    expect(detail("bash", { command }, true)).toHaveLength("Bash: ".length + 150);
  });
});

// ── the loaders and the dispatch ────────────────────────────────────────────

describe("loading from disk", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agendo-activity-"));
    writeFileSync(join(dir, "rollout.jsonl"), jsonl([userTurn(1, "from disk")]));
    mkdirSync(join(dir, "copilot"));
    writeFileSync(join(dir, "copilot", "events.jsonl"), jsonl([userMsg(1, "from events")]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("codex reads the rollout, and is empty for no path or a missing file", async () => {
    expect((await loadCodexActivity(join(dir, "rollout.jsonl"))).lastPrompt).toBe("from disk");
    expect(await loadCodexActivity(undefined)).toEqual({ actions: [] });
    expect(await loadCodexActivity(join(dir, "nope.jsonl"))).toEqual({ actions: [] });
  });

  test("copilot reads events.jsonl under the session dir, and is empty for no dir or a missing file", async () => {
    expect((await loadCopilotActivity(join(dir, "copilot"))).lastPrompt).toBe("from events");
    expect(await loadCopilotActivity(undefined)).toEqual({ actions: [] });
    expect(await loadCopilotActivity(join(dir, "nope"))).toEqual({ actions: [] });
  });

  test("loadActivity dispatches on the session's source", async () => {
    const base = { id: "s", cwd: "/w", title: "t", lastUsed: new Date() };
    expect((await loadActivity({ ...base, source: "codex", logPath: join(dir, "rollout.jsonl") })).lastPrompt).toBe("from disk");
    expect((await loadActivity({ ...base, source: "copilot", logPath: join(dir, "copilot") })).lastPrompt).toBe("from events");
    expect(await loadActivity({ ...base, source: "claude" })).toEqual({ actions: [] });
    expect(await loadActivity({ ...base, source: "claude" }, { full: true })).toEqual({ actions: [] });
  });
});

// ── shared pieces ───────────────────────────────────────────────────────────

describe("common", () => {
  test("shortPath folds the home dir and keeps the last two components", () => {
    expect(shortPath("/home/someone/repo/src/ui/x.ts")).toBe("…/ui/x.ts");
    expect(shortPath("/home/someone/x.ts")).toBe("~/x.ts");
    expect(shortPath("a/b")).toBe("a/b");
    expect(shortPath(undefined)).toBe("");
  });

  test("finalizeActivity stamps deltas across the whole list before cutting the tail, and drops an empty checklist", () => {
    const actions = Array.from({ length: ACTIVITY_LIMIT + 1 }, (_, i) => ({ timestamp: new Date(1000 * (i + 1)), verb: "v", detail: "" }));
    actions[3].timestamp = new Date(0); // clock-less action: no delta on either side
    const a = finalizeActivity("p", actions, { tasks: [], finalResponse: "r" });
    expect(a.actions).toHaveLength(ACTIVITY_LIMIT);
    expect(a.actions[0].deltaMs).toBe(1000); // measured against the action the cut removed
    expect(a.actions[2].deltaMs).toBeUndefined();
    expect(a.actions[3].deltaMs).toBeUndefined();
    expect(a.tasks).toBeUndefined();
    expect(a.lastPrompt).toBe("p");
    expect(a.finalResponse).toBe("r");
  });
});
