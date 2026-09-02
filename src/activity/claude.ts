// ── Claude activity ─────────────────────────────────────────────────────────
// A claude transcript is JSONL of user/assistant records; the assistant ones
// carry content blocks (thinking, text, tool_use). This reader keeps the last
// human prompt, the last assistant text, the task checklist and the action
// tail.

import { parseJsonLine } from "../errors.ts";
import { clean } from "../transcript.ts";
import type { ActionLine, SessionActivity, TaskItem } from "../types.ts";
import { finalizeActivity, normalizeTaskStatus, readLog, shortPath } from "./common.ts";

// ── task checklist reconstruction ───────────────────────────────────────────

// Statuses that mean "this task no longer exists" (des-workflow TaskUpdate).
const REMOVED_STATUS = new Set(["deleted", "cancelled", "canceled", "removed"]);
function isRemovedStatus(raw: unknown): boolean {
  return REMOVED_STATUS.has(String(raw ?? "").toLowerCase().trim());
}

// A TodoWrite tool_use carries the WHOLE checklist in input.todos[]; the latest
// one in the log is authoritative. Returns null for anything that isn't a
// well-formed todo list, so a malformed/partial record is simply ignored.
function todosToTasks(input: any): TaskItem[] | null {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return null;
  const tasks: TaskItem[] = [];
  for (const t of todos) {
    if (!t || typeof t !== "object") continue;
    const label = clean(t.content ?? t.activeForm ?? t.task);
    if (!label) continue;
    tasks.push({ label, status: normalizeTaskStatus(t.status) });
  }
  return tasks;
}

// Mutable state for the TaskCreate/TaskUpdate fallback replay.
interface TaskReplay {
  map: Map<string, TaskItem>;
  order: string[];
  /** Count of TaskCreate calls seen, used to synthesize ids for the common case. */
  created: number;
}

// Fallback checklist: replay des-workflow TaskCreate/TaskUpdate tool calls,
// keyed by taskId, final status winning, creation order preserved.
//
// The wrinkle: a real TaskCreate tool_use input carries only {subject,
// description} — the taskId is assigned in the tool_result we don't parse. Those
// ids are handed out as "1", "2", … in creation order, and TaskUpdate references
// them by that id. So we synthesize the same ordinal id for each create; an
// explicit taskId on the create (some variants include one) still takes
// precedence. This makes create↔update actually correlate on real transcripts.
function recordTaskEvent(name: string, input: any, st: TaskReplay): void {
  const subject = input?.subject ?? input?.title;
  if (name === "TaskCreate") {
    const key = String(input?.taskId ?? input?.id ?? ++st.created).trim();
    if (!key) return;
    const status = input?.status != null ? normalizeTaskStatus(input.status) : "pending";
    if (!st.map.has(key)) st.order.push(key);
    st.map.set(key, { label: clean(subject ?? `Task ${key}`), status });
    return;
  }
  // TaskUpdate
  const key = String(input?.taskId ?? input?.id ?? subject ?? "").trim();
  if (!key) return;
  if (isRemovedStatus(input?.status)) {
    if (st.map.delete(key)) {
      const i = st.order.indexOf(key);
      if (i >= 0) st.order.splice(i, 1);
    }
    return;
  }
  const existing = st.map.get(key);
  if (!existing) {
    st.order.push(key);
    st.map.set(key, { label: clean(subject ?? `Task ${key}`), status: normalizeTaskStatus(input?.status ?? "pending") });
    return;
  }
  if (input?.status != null) existing.status = normalizeTaskStatus(input.status);
  if (subject) existing.label = clean(subject);
}

// The most recent human prompt (string content, or text blocks — never a
// tool_result, which is also delivered as a "user" message).
function userText(content: any): string | undefined {
  if (typeof content === "string") return /\w/.test(content) ? clean(content) : undefined;
  if (Array.isArray(content)) {
    const text = content
      .filter((b) => b?.type === "text" && /\w/.test(b.text ?? ""))
      .map((b) => b.text)
      .join(" ");
    return text ? clean(text) : undefined;
  }
  return undefined;
}

function claudeAction(b: any, ts: Date, full = false): ActionLine | null {
  if (b.type === "thinking" && b.thinking?.length > 0) {
    return { timestamp: ts, verb: "Thinking", detail: `~${Math.round(b.thinking.length / 4)} tokens` };
  }
  if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
    const txt = clean(b.text);
    return { timestamp: ts, verb: "Claude", detail: full ? txt : txt.slice(0, 200) };
  }
  if (b.type !== "tool_use") return null;
  // TodoWrite is surfaced as the task checklist (see loadClaudeActivity), not as
  // an action line — its input is the whole todo list, useless as a one-liner.
  if (b.name === "TodoWrite") return null;
  const inp = b.input ?? {};
  let verb = String(b.name ?? "?");
  let detail = "";
  switch (b.name) {
    case "Write":
    case "Edit":
    case "Read":
      detail = shortPath(inp.file_path ?? "");
      break;
    case "Bash": {
      const cmd = clean(inp.command ?? "");
      detail = full ? cmd : cmd.slice(0, 120);
      break;
    }
    case "Agent": {
      const at = inp.subagent_type ? `[${inp.subagent_type}] ` : "";
      detail = at + (inp.description ?? "");
      break;
    }
    // A Workflow launch's input is a whole orchestration script — dumping its
    // first value would spray code into the one-liner. Prefer the workflow's
    // name / script path; run identity + progress live in the workflows
    // section (see workflows.ts), not the action log.
    case "Workflow":
      detail = inp.name ?? (typeof inp.scriptPath === "string" ? shortPath(inp.scriptPath) : "(inline script)");
      break;
    case "TaskCreate":
      detail = inp.subject ?? inp.title ?? "";
      break;
    case "TaskUpdate":
      verb = `Task #${inp.taskId ?? inp.id ?? "?"}`;
      detail = `→ ${inp.status ?? ""}`;
      break;
    default: {
      const d = clean(Object.values(inp).slice(0, 1).map(String).join(""));
      detail = full ? d : d.slice(0, 80);
    }
  }
  return { timestamp: ts, verb, detail };
}

export async function loadClaudeActivity(path?: string, full = false): Promise<SessionActivity> {
  const raw = await readLog(path);
  if (raw === null) return { actions: [] };
  const actions: ActionLine[] = [];
  let lastPrompt: string | undefined;
  let finalResponse: string | undefined;
  // Task checklist: the latest non-empty TodoWrite wins; the Task* replay is the
  // fallback for des-workflow sessions that never call TodoWrite.
  let latestTodos: TaskItem[] | null = null;
  const replay: TaskReplay = { map: new Map(), order: [], created: 0 };
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const e: Record<string, any> | null = parseJsonLine(t, path!, i + 1, { isLast: i === lines.length - 1 });
    // JSON.parse("null")/"42"/"\"x\"" succeed but aren't records — skip them so a
    // stray primitive line can't crash the field access below.
    if (!e || typeof e !== "object") continue;
    const ts = e.timestamp ? new Date(e.timestamp) : new Date(0);
    if (e.type === "user") {
      const txt = userText(e.message?.content);
      // A genuine new human prompt (not a tool_result) starts a fresh turn, so
      // the previous turn's answer is no longer "the final response". Injected
      // task-notifications (background agent/workflow completions) are user-typed
      // records but not human prompts — they must not clobber either field.
      if (txt && !txt.startsWith("<task-notification>")) {
        lastPrompt = full ? txt : txt.slice(0, 200);
        finalResponse = undefined;
      }
    } else if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        const a = claudeAction(b, ts, full);
        if (a) actions.push(a);
        // Keep the full text of the last assistant message for orchestrators.
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
          finalResponse = b.text.trim();
        }
        if (b?.type === "tool_use") {
          if (b.name === "TodoWrite") {
            const parsed = todosToTasks(b.input);
            // Only a non-empty list supersedes; an empty/all-malformed todos[]
            // must not blank out a Task*-derived checklist via the ?? below.
            if (parsed && parsed.length) latestTodos = parsed;
          } else if (b.name === "TaskCreate" || b.name === "TaskUpdate") {
            recordTaskEvent(b.name, b.input ?? {}, replay);
          }
        }
      }
    }
  }
  const tasks = latestTodos ?? replay.order.map((k) => replay.map.get(k)!).filter(Boolean);
  return finalizeActivity(lastPrompt, actions, { tasks, finalResponse });
}
