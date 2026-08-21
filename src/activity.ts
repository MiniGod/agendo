// ── On-demand activity (recent action lines) ────────────────────────────────
// The session index in sessions.ts stays cheap (metadata only). When a session
// row is expanded in the UI we parse its full log here to surface the last few
// actions — the same idea as the standalone claude-tasks dashboard, but loaded
// one file at a time so it's only paid for sessions the user actually opens.

import { readFile } from "fs/promises";
import { join } from "path";
import { parseJsonLine } from "./errors.ts";
import { clean, codexUserText } from "./transcript.ts";
import type { ActionLine, AgentSession, SessionActivity, TaskItem, TaskStatus } from "./types.ts";

const ACTIVITY_LIMIT = 12; // recent actions surfaced per session

// Shorten a file path to its last couple of components for compact display.
function shortPath(p: unknown): string {
  const parts = String(p ?? "").replace(/^\/home\/[^/]+\//, "~/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : parts.join("/");
}

// ── task checklist reconstruction (Claude only) ─────────────────────────────
// Normalize the several status vocabularies we see (Claude's TodoWrite uses
// pending|in_progress|completed; des-workflow TaskUpdate uses active/closed/…)
// into the three the UI renders. Match tokens EXACTLY (after folding spaces and
// dashes to underscores) so "not_started"/"inactive" don't false-positive into
// in_progress via a substring like "started"/"active".
const IN_PROGRESS = new Set(["in_progress", "inprogress", "active", "doing", "current", "started", "working"]);
const COMPLETED = new Set(["completed", "complete", "done", "closed", "resolved", "finished"]);
function normalizeTaskStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (IN_PROGRESS.has(s)) return "in_progress";
  if (COMPLETED.has(s)) return "completed";
  return "pending";
}

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

async function loadClaudeActivity(path?: string, full = false): Promise<SessionActivity> {
  if (!path) return { actions: [] };
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { actions: [] };
  }
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
    const e: Record<string, any> | null = parseJsonLine(t, path, i + 1, { isLast: i === lines.length - 1 });
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

function copilotAction(tr: any, ts: Date, full = false): ActionLine {
  const name = String(tr.name ?? "?");
  const args = tr.arguments ?? {};
  let verb = name;
  let detail = "";
  switch (name) {
    case "view":
      verb = "View";
      detail = shortPath(args.path ?? "");
      break;
    case "create":
      verb = "Create";
      detail = shortPath(args.path ?? "");
      break;
    case "edit":
      verb = "Edit";
      detail = shortPath(args.path ?? "");
      break;
    case "bash": {
      verb = "Bash";
      const cmd = clean(args.command ?? "");
      detail = full ? cmd : cmd.slice(0, 120);
      break;
    }
    case "grep":
      verb = "Grep";
      detail = args.pattern ?? "";
      break;
    case "glob":
      verb = "Glob";
      detail = args.pattern ?? "";
      break;
    case "task": {
      verb = "Agent";
      const at = args.agent_type ? `[${args.agent_type}] ` : "";
      detail = at + (args.description ?? args.name ?? "");
      break;
    }
    case "ask_user":
      verb = "AskUser";
      detail = clean(args.message ?? "").slice(0, 80);
      break;
    case "report_intent":
      verb = "Intent";
      detail = args.intent ?? "";
      break;
    default: {
      const d = clean(Object.values(args).slice(0, 1).map(String).join(""));
      detail = full ? d : d.slice(0, 80);
    }
  }
  return { timestamp: ts, verb, detail };
}

async function loadCopilotActivity(dir?: string, full = false): Promise<SessionActivity> {
  if (!dir) return { actions: [] };
  const eventsPath = join(dir, "events.jsonl");
  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf-8");
  } catch {
    return { actions: [] };
  }
  const actions: ActionLine[] = [];
  let lastPrompt: string | undefined;
  let finalResponse: string | undefined;
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const e: Record<string, any> | null = parseJsonLine(t, eventsPath, i + 1, { isLast: i === lines.length - 1 });
    if (!e || typeof e !== "object") continue;
    const ts = e.timestamp ? new Date(e.timestamp) : new Date(0);
    const data = e.data ?? {};
    if (e.type === "user.message") {
      const c = String(data.content ?? "");
      if (c.trim()) {
        lastPrompt = full ? clean(c) : clean(c).slice(0, 200);
        finalResponse = undefined; // a new prompt starts a fresh turn
      }
    } else if (e.type === "assistant.message") {
      const content = typeof data.content === "string" ? data.content : "";
      const reqs = Array.isArray(data.toolRequests) ? data.toolRequests : [];
      if (content.trim()) finalResponse = content.trim();
      if (content.trim() && reqs.length === 0) {
        actions.push({ timestamp: ts, verb: "Copilot", detail: full ? clean(content) : clean(content).slice(0, 200) });
      }
      for (const tr of reqs) actions.push(copilotAction(tr, ts, full));
    }
  }
  // Copilot has no task checklist; only a final response. Drop low-signal
  // intent pings, then finalize.
  return finalizeActivity(lastPrompt, actions.filter((a) => a.verb !== "Intent"), { finalResponse });
}

// Compute inter-action deltas across the FULL log, then keep only the tail so
// the first surfaced line still shows the real gap from the action before it.
// The task checklist and final response are NOT capped — they describe overall
// state, not the rolling window of recent actions.
function finalizeActivity(
  lastPrompt: string | undefined,
  actions: ActionLine[],
  extra: { tasks?: TaskItem[]; finalResponse?: string } = {},
): SessionActivity {
  for (let i = 1; i < actions.length; i++) {
    const prev = actions[i - 1].timestamp.getTime();
    const cur = actions[i].timestamp.getTime();
    if (prev > 0 && cur > 0) actions[i].deltaMs = Math.max(0, cur - prev);
  }
  return {
    lastPrompt,
    actions: actions.slice(-ACTIVITY_LIMIT),
    tasks: extra.tasks && extra.tasks.length ? extra.tasks : undefined,
    finalResponse: extra.finalResponse,
  };
}

// Codex tool calls come in two record shapes, both under `response_item`:
// `function_call` (JSON-string `arguments`) and `custom_tool_call` (raw-string
// `input`). Names are stable across both: `shell`/`shell_command` run commands,
// `apply_patch` edits files, `update_plan` carries the whole task checklist.
function codexAction(name: string, args: any, raw: string, ts: Date, full = false): ActionLine | null {
  // update_plan is surfaced as the task checklist (see loadCodexActivity), not
  // as an action line — its payload is the whole plan, useless as a one-liner.
  if (name === "update_plan") return null;
  switch (name) {
    case "shell":
    case "shell_command": {
      // `shell` passes an argv array (["bash","-lc",…]); `shell_command` a string.
      const c = args?.command ?? args?.cmd;
      const cmd = clean(Array.isArray(c) ? c.join(" ") : (c ?? raw));
      return { timestamp: ts, verb: "Bash", detail: full ? cmd : cmd.slice(0, 120) };
    }
    case "exec": {
      // Codex's sandboxed tool-runner: `input` is a JS program driving
      // `tools.exec_command(…)`, not a command line — so show the script itself
      // rather than mislabelling it as a shell invocation.
      const script = clean(raw);
      return { timestamp: ts, verb: "Exec", detail: full ? script : script.slice(0, 120) };
    }
    case "apply_patch": {
      // The patch body is `*** Update File: <path>` blocks; name the files touched.
      const files = [...raw.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => shortPath(m[1]));
      return { timestamp: ts, verb: "Edit", detail: files.length ? files.join(", ") : "(patch)" };
    }
    case "view_image":
      return { timestamp: ts, verb: "Read", detail: shortPath(args?.path ?? "") };
    case "spawn_agent":
      return { timestamp: ts, verb: "Agent", detail: clean(args?.task_name ?? args?.name ?? "") };
    default: {
      const d = clean(args && typeof args === "object" ? Object.values(args).slice(0, 1).map(String).join("") : raw);
      return { timestamp: ts, verb: name, detail: full ? d : d.slice(0, 80) };
    }
  }
}

/**
 * Codex's `update_plan` steps use the same three-state vocabulary as Claude's
 * TodoWrite (pending / in_progress / completed), so they map straight onto the
 * task checklist. The latest call in the log is authoritative.
 */
function codexPlanToTasks(args: any): TaskItem[] | null {
  const plan = args?.plan;
  if (!Array.isArray(plan)) return null;
  const tasks: TaskItem[] = [];
  for (const p of plan) {
    const label = clean(p?.step ?? p?.content);
    if (label) tasks.push({ label, status: normalizeTaskStatus(p?.status) });
  }
  return tasks;
}

async function loadCodexActivity(path?: string, full = false): Promise<SessionActivity> {
  if (!path) return { actions: [] };
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return { actions: [] };
  }
  const actions: ActionLine[] = [];
  let lastPrompt: string | undefined;
  let finalResponse: string | undefined;
  let latestPlan: TaskItem[] | null = null;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const p = e.payload;
    if (!p || typeof p !== "object") continue;
    if (e.type !== "response_item") continue;
    const ts = e.timestamp ? new Date(e.timestamp) : new Date(0);
    const prompt = codexUserText(e, p);
    if (prompt) {
      lastPrompt = full ? prompt : prompt.slice(0, 200);
      finalResponse = undefined; // a new prompt starts a fresh turn
    } else if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      const msg = clean(
        p.content
          .filter((c: any) => c?.type === "output_text" && typeof c.text === "string")
          .map((c: any) => c.text)
          .join(" "),
      );
      if (msg) {
        finalResponse = msg;
        actions.push({ timestamp: ts, verb: "Codex", detail: full ? msg : msg.slice(0, 200) });
      }
    } else if (p.type === "reasoning" && Array.isArray(p.summary)) {
      // `summary` is the visible reasoning; `encrypted_content` (the bulk) is
      // opaque, so a summary-less record has nothing to report.
      const txt = p.summary.map((sm: any) => (typeof sm?.text === "string" ? sm.text : "")).join(" ").trim();
      if (txt) actions.push({ timestamp: ts, verb: "Thinking", detail: `~${Math.round(txt.length / 4)} tokens` });
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const name = String(p.name ?? "?");
      const rawArgs = String(p.arguments ?? p.input ?? "");
      let args: any = null;
      try {
        args = JSON.parse(rawArgs);
      } catch {
        // custom_tool_call `input` is a raw string (a patch body, a script) —
        // not JSON, and codexAction falls back to it.
      }
      if (name === "update_plan") {
        const parsed = codexPlanToTasks(args);
        if (parsed && parsed.length) latestPlan = parsed;
      }
      const a = codexAction(name, args, rawArgs, ts, full);
      if (a) actions.push(a);
    }
  }
  return finalizeActivity(lastPrompt, actions, { tasks: latestPlan ?? undefined, finalResponse });
}

/** Options for on-demand activity loading. `full` skips display truncation. */
export interface LoadActivityOpts {
  /** When true, don't truncate the last prompt or action details (for `agendo status --full`). */
  full?: boolean;
}

/** Parse a session's recent activity on demand (called when its row expands). */
export function loadActivity(s: AgentSession, opts: LoadActivityOpts = {}): Promise<SessionActivity> {
  switch (s.source) {
    case "claude":
      return loadClaudeActivity(s.logPath, opts.full);
    case "copilot":
      return loadCopilotActivity(s.logPath, opts.full);
    case "codex":
      return loadCodexActivity(s.logPath, opts.full);
  }
}
