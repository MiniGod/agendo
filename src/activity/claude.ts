// ── Claude activity ─────────────────────────────────────────────────────────
// A claude transcript is JSONL of user/assistant records; the assistant ones
// carry content blocks (thinking, text, tool_use). This reader keeps the last
// human prompt, the last assistant text, the task checklist and the action
// tail.

import { clean } from "../transcript.ts";
import type { ActionLine, SessionActivity, TaskItem } from "../types.ts";
import {
  type Detail,
  excerpt,
  finalizeActivity,
  firstValue,
  jsonlRecords,
  normalizeTaskStatus,
  readLog,
  shortPath,
  str,
  timestampOf,
} from "./common.ts";

// ── task checklist reconstruction ───────────────────────────────────────────

// Statuses that mean "this task no longer exists" (des-workflow TaskUpdate).
const REMOVED_STATUS = new Set(["deleted", "cancelled", "canceled", "removed"]);
function isRemovedStatus(raw: unknown): boolean {
  return REMOVED_STATUS.has(String(raw ?? "").toLowerCase().trim());
}

function todoItem(t: any): TaskItem | null {
  if (!t || typeof t !== "object") return null;
  const label = clean(t.content ?? t.activeForm ?? t.task);
  return label ? { label, status: normalizeTaskStatus(t.status) } : null;
}

/**
 * A TodoWrite tool_use carries the WHOLE checklist in input.todos[]; the latest
 * one in the log is authoritative — but only a non-empty one, so this is null
 * for anything that isn't a well-formed todo list with at least one usable
 * item, and a malformed, partial or empty record is simply ignored.
 */
export function todosToTasks(input: any): TaskItem[] | null {
  const todos = (input ?? {}).todos;
  if (!Array.isArray(todos)) return null;
  const tasks: TaskItem[] = [];
  for (const t of todos) {
    const item = todoItem(t);
    if (item) tasks.push(item);
  }
  return tasks.length ? tasks : null;
}

/** Mutable state for the TaskCreate/TaskUpdate fallback replay. */
export interface TaskReplay {
  map: Map<string, TaskItem>;
  order: string[];
  /** Count of TaskCreate calls seen, used to synthesize ids for the common case. */
  created: number;
}

export function newTaskReplay(): TaskReplay {
  return { map: new Map(), order: [], created: 0 };
}

type Input = Record<string, any>;

function taskSubject(input: Input): unknown {
  return input.subject ?? input.title;
}

function upsertTask(st: TaskReplay, key: string, label: string, status: TaskItem["status"]): void {
  if (!st.map.has(key)) st.order.push(key);
  st.map.set(key, { label, status });
}

function removeTask(st: TaskReplay, key: string): void {
  if (!st.map.delete(key)) return;
  const i = st.order.indexOf(key);
  if (i >= 0) st.order.splice(i, 1);
}

// The wrinkle: a real TaskCreate tool_use input carries only {subject,
// description} — the taskId is assigned in the tool_result we don't parse. Those
// ids are handed out as "1", "2", … in creation order, and TaskUpdate references
// them by that id. So we synthesize the same ordinal id for each create; an
// explicit taskId on the create (some variants include one) still takes
// precedence. This makes create↔update actually correlate on real transcripts.
function taskCreate(input: Input, st: TaskReplay): void {
  const key = String(input.taskId ?? input.id ?? ++st.created).trim();
  if (!key) return;
  const status = input.status != null ? normalizeTaskStatus(input.status) : "pending";
  upsertTask(st, key, clean(taskSubject(input) ?? `Task ${key}`), status);
}

// An update to a task the replay never saw created is taken as the creation.
function amendTask(st: TaskReplay, key: string, subject: unknown, status: unknown): void {
  const existing = st.map.get(key);
  if (!existing) return upsertTask(st, key, clean(subject ?? `Task ${key}`), normalizeTaskStatus(status ?? "pending"));
  if (status != null) existing.status = normalizeTaskStatus(status);
  if (subject) existing.label = clean(subject);
}

function taskUpdate(input: Input, st: TaskReplay): void {
  const subject = taskSubject(input);
  const key = String(input.taskId ?? input.id ?? subject ?? "").trim();
  if (!key) return;
  if (isRemovedStatus(input.status)) removeTask(st, key);
  else amendTask(st, key, subject, input.status);
}

/**
 * Fallback checklist: replay des-workflow TaskCreate/TaskUpdate tool calls,
 * keyed by taskId, final status winning, creation order preserved.
 */
export function recordTaskEvent(name: string, input: Input, st: TaskReplay): void {
  if (name === "TaskCreate") taskCreate(input, st);
  else taskUpdate(input, st);
}

/** The checklist the replay reconstructed, in creation order. */
export function replayedTasks(st: TaskReplay): TaskItem[] {
  return st.order.map((k) => st.map.get(k)!).filter(Boolean);
}

// ── one record ──────────────────────────────────────────────────────────────

function isTextBlock(b: any): boolean {
  return b?.type === "text" && /\w/.test(b.text ?? "");
}

function textOf(b: any): string {
  return b.text;
}

/**
 * The most recent human prompt (string content, or text blocks — never a
 * tool_result, which is also delivered as a "user" message).
 */
export function userText(content: any): string | undefined {
  if (typeof content === "string") return /\w/.test(content) ? clean(content) : undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content.filter(isTextBlock).map(textOf).join(" ");
  return text ? clean(text) : undefined;
}

type Builder = (inp: Input, full: boolean) => Detail;

function fileTool(verb: string): Builder {
  return function fileDetail(inp: Input): Detail {
    return { verb, detail: shortPath(inp.file_path) };
  };
}

function bashDetail(inp: Input, full: boolean): Detail {
  return { verb: "Bash", detail: excerpt(clean(inp.command), full, 120) };
}

function agentDetail(inp: Input): Detail {
  const at = inp.subagent_type ? `[${inp.subagent_type}] ` : "";
  return { verb: "Agent", detail: at + str(inp.description) };
}

function workflowDetail(inp: Input): Detail {
  // A Workflow launch's input is a whole orchestration script — dumping its
  // first value would spray code into the one-liner. Prefer the workflow's
  // name / script path; run identity + progress live in the workflows
  // section (see workflows.ts), not the action log.
  const fallback = typeof inp.scriptPath === "string" ? shortPath(inp.scriptPath) : "(inline script)";
  return { verb: "Workflow", detail: inp.name ?? fallback };
}

function taskCreateDetail(inp: Input): Detail {
  return { verb: "TaskCreate", detail: inp.subject ?? inp.title ?? "" };
}

function taskUpdateDetail(inp: Input): Detail {
  return { verb: `Task #${inp.taskId ?? inp.id ?? "?"}`, detail: `→ ${inp.status ?? ""}` };
}

const CLAUDE_TOOLS = new Map<string, Builder>([
  ["Write", fileTool("Write")],
  ["Edit", fileTool("Edit")],
  ["Read", fileTool("Read")],
  ["Bash", bashDetail],
  ["Agent", agentDetail],
  ["Workflow", workflowDetail],
  ["TaskCreate", taskCreateDetail],
  ["TaskUpdate", taskUpdateDetail],
]);

function thinkingAction(b: any, ts: Date): ActionLine | null {
  return b.thinking?.length > 0 ? { timestamp: ts, verb: "Thinking", detail: `~${Math.round(b.thinking.length / 4)} tokens` } : null;
}

function textAction(b: any, ts: Date, full: boolean): ActionLine | null {
  return typeof b.text === "string" && b.text.trim() ? { timestamp: ts, verb: "Claude", detail: excerpt(clean(b.text), full, 200) } : null;
}

function toolUseAction(b: any, ts: Date, full: boolean): ActionLine | null {
  // TodoWrite is surfaced as the task checklist (see claudeToolUse), not as
  // an action line — its input is the whole todo list, useless as a one-liner.
  if (b.name === "TodoWrite") return null;
  const inp: Input = b.input ?? {};
  const name = String(b.name ?? "?");
  const build = CLAUDE_TOOLS.get(name);
  return { timestamp: ts, ...(build ? build(inp, full) : { verb: name, detail: excerpt(firstValue(inp), full, 80) }) };
}

/** The action line for one assistant content block, or null when it makes none. */
export function claudeAction(b: any, ts: Date, full = false): ActionLine | null {
  switch (b.type) {
    case "thinking":
      return thinkingAction(b, ts);
    case "text":
      return textAction(b, ts, full);
    case "tool_use":
      return toolUseAction(b, ts, full);
    default:
      return null;
  }
}

// ── the walk ────────────────────────────────────────────────────────────────

interface ClaudeScan {
  actions: ActionLine[];
  lastPrompt?: string;
  finalResponse?: string;
  // Task checklist: the latest non-empty TodoWrite wins; the Task* replay is
  // the fallback for des-workflow sessions that never call TodoWrite.
  latestTodos: TaskItem[] | null;
  replay: TaskReplay;
}

function claudePrompt(st: ClaudeScan, e: Record<string, any>, full: boolean): void {
  const txt = userText(e.message?.content);
  // A genuine new human prompt (not a tool_result) starts a fresh turn, so
  // the previous turn's answer is no longer "the final response". Injected
  // task-notifications (background agent/workflow completions) are user-typed
  // records but not human prompts — they must not clobber either field.
  if (txt && !txt.startsWith("<task-notification>")) {
    st.lastPrompt = excerpt(txt, full, 200);
    st.finalResponse = undefined;
  }
}

function claudeToolUse(st: ClaudeScan, b: any): void {
  switch (b.name) {
    case "TodoWrite":
      // Only a non-empty list supersedes; an empty/all-malformed todos[] must
      // not blank out a Task*-derived checklist via the ?? in parseClaudeLog.
      st.latestTodos = todosToTasks(b.input) ?? st.latestTodos;
      return;
    case "TaskCreate":
    case "TaskUpdate":
      recordTaskEvent(b.name, b.input ?? {}, st.replay);
  }
}

function claudeBlock(st: ClaudeScan, b: any, ts: Date, full: boolean): void {
  const a = claudeAction(b, ts, full);
  if (a) st.actions.push(a);
  // Keep the full text of the last assistant message for orchestrators. A text
  // block makes an action exactly when it has text.
  if (b.type === "text" && a) st.finalResponse = b.text.trim();
  else if (b.type === "tool_use") claudeToolUse(st, b);
}

function claudeAssistant(st: ClaudeScan, e: Record<string, any>, full: boolean): void {
  const content = e.message?.content;
  if (!Array.isArray(content)) return;
  const ts = timestampOf(e);
  for (const b of content) claudeBlock(st, b, ts, full);
}

function scanClaudeRecord(st: ClaudeScan, e: Record<string, any>, full: boolean): void {
  if (e.type === "user") claudePrompt(st, e, full);
  else if (e.type === "assistant") claudeAssistant(st, e, full);
}

/**
 * The activity in one transcript's text. `path` names the file in the warning
 * a torn line earns (see `parseJsonLine`).
 */
export function parseClaudeLog(raw: string, path: string, full = false): SessionActivity {
  const st: ClaudeScan = { actions: [], latestTodos: null, replay: newTaskReplay() };
  for (const e of jsonlRecords(raw, path)) scanClaudeRecord(st, e, full);
  const tasks = st.latestTodos ?? replayedTasks(st.replay);
  return finalizeActivity(st.lastPrompt, st.actions, { tasks, finalResponse: st.finalResponse });
}

export async function loadClaudeActivity(path?: string, full = false): Promise<SessionActivity> {
  const raw = await readLog(path);
  return raw === null ? { actions: [] } : parseClaudeLog(raw, path!, full);
}
