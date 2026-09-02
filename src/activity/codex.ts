// ── Codex activity ──────────────────────────────────────────────────────────
// A codex rollout is JSONL whose model-facing conversation sits under
// `response_item` records: user/assistant messages, reasoning summaries and
// tool calls. This reader walks that stream once and keeps the last prompt,
// the last assistant message, the latest `update_plan` and the action tail.

import { clean, codexUserText } from "../transcript.ts";
import type { ActionLine, SessionActivity, TaskItem } from "../types.ts";
import {
  type Detail,
  excerpt,
  finalizeActivity,
  firstValue,
  normalizeTaskStatus,
  readLog,
  shortPath,
  str,
  timestampOf,
} from "./common.ts";

// ── tool calls ──────────────────────────────────────────────────────────────
// Codex tool calls come in two record shapes, both under `response_item`:
// `function_call` (JSON-string `arguments`) and `custom_tool_call` (raw-string
// `input`). Names are stable across both: `shell`/`shell_command` run commands,
// `apply_patch` edits files, `update_plan` carries the whole task checklist.

type Builder = (args: any, raw: string, full: boolean) => Detail;

function shellDetail(args: any, raw: string, full: boolean): Detail {
  // `shell` passes an argv array (["bash","-lc",…]); `shell_command` a string.
  const { command, cmd } = args ?? {};
  const c = command ?? cmd;
  const line = clean(Array.isArray(c) ? c.join(" ") : (c ?? raw));
  return { verb: "Bash", detail: excerpt(line, full, 120) };
}

function execDetail(_args: any, raw: string, full: boolean): Detail {
  // Codex's sandboxed tool-runner: `input` is a JS program driving
  // `tools.exec_command(…)`, not a command line — so show the script itself
  // rather than mislabelling it as a shell invocation.
  return { verb: "Exec", detail: excerpt(clean(raw), full, 120) };
}

function patchedFile(m: RegExpMatchArray): string {
  return shortPath(m[1]);
}

function patchDetail(_args: any, raw: string): Detail {
  // The patch body is `*** Update File: <path>` blocks; name the files touched.
  const files = [...raw.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(patchedFile);
  return { verb: "Edit", detail: files.length ? files.join(", ") : "(patch)" };
}

function viewImageDetail(args: any): Detail {
  return { verb: "Read", detail: shortPath((args ?? {}).path) };
}

function spawnAgentDetail(args: any): Detail {
  const { task_name, name } = args ?? {};
  return { verb: "Agent", detail: clean(task_name ?? name ?? "") };
}

function genericDetail(name: string, args: any, raw: string, full: boolean): Detail {
  const d = args && typeof args === "object" ? firstValue(args) : raw;
  return { verb: name, detail: excerpt(d, full, 80) };
}

const CODEX_TOOLS = new Map<string, Builder>([
  ["shell", shellDetail],
  ["shell_command", shellDetail],
  ["exec", execDetail],
  ["apply_patch", patchDetail],
  ["view_image", viewImageDetail],
  ["spawn_agent", spawnAgentDetail],
]);

/**
 * The action line for one codex tool call. `args` is the parsed JSON of the
 * call (null when it was not JSON — a `custom_tool_call` carries a raw patch
 * body or script, and `raw` is the fallback then).
 */
export function codexAction(name: string, args: any, raw: string, ts: Date, full = false): ActionLine {
  const build = CODEX_TOOLS.get(name);
  return { timestamp: ts, ...(build ? build(args, raw, full) : genericDetail(name, args, raw, full)) };
}

// ── task checklist ──────────────────────────────────────────────────────────

function planStep(p: any): TaskItem | null {
  const { step, content, status } = p ?? {};
  const label = clean(step ?? content);
  return label ? { label, status: normalizeTaskStatus(status) } : null;
}

/**
 * Codex's `update_plan` steps use the same three-state vocabulary as Claude's
 * TodoWrite (pending / in_progress / completed), so they map straight onto the
 * task checklist. The latest call in the log is authoritative — but only a
 * non-empty one: null for anything that is not a well-formed plan or has no
 * usable step, so a malformed or empty call cannot blank out the last good one.
 */
export function codexPlanToTasks(args: any): TaskItem[] | null {
  const plan = (args ?? {}).plan;
  if (!Array.isArray(plan)) return null;
  const tasks: TaskItem[] = [];
  for (const p of plan) {
    const t = planStep(p);
    if (t) tasks.push(t);
  }
  return tasks.length ? tasks : null;
}

// ── the walk ────────────────────────────────────────────────────────────────

interface CodexScan {
  actions: ActionLine[];
  lastPrompt?: string;
  finalResponse?: string;
  latestPlan: TaskItem[] | null;
}

function jsonOrNull(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null;
}

/** The `{record, payload}` of a `response_item` line; null for every other line. */
function responseItem(line: string): { e: Record<string, any>; p: Record<string, any> } | null {
  const t = line.trim();
  const e = t ? jsonOrNull(t) : null;
  if (!isRecord(e) || !isRecord(e.payload) || e.type !== "response_item") return null;
  return { e, p: e.payload };
}

function isOutputText(c: any): boolean {
  return c?.type === "output_text" && typeof c.text === "string";
}

function textOf(c: any): string {
  return c.text;
}

function codexMessage(st: CodexScan, p: Record<string, any>, ts: Date, full: boolean): void {
  if (p.role !== "assistant" || !Array.isArray(p.content)) return;
  const msg = clean(p.content.filter(isOutputText).map(textOf).join(" "));
  if (!msg) return;
  st.finalResponse = msg;
  st.actions.push({ timestamp: ts, verb: "Codex", detail: excerpt(msg, full, 200) });
}

function summaryText(sm: any): string {
  return typeof sm?.text === "string" ? sm.text : "";
}

function codexReasoning(st: CodexScan, p: Record<string, any>, ts: Date): void {
  // `summary` is the visible reasoning; `encrypted_content` (the bulk) is
  // opaque, so a summary-less record has nothing to report.
  if (!Array.isArray(p.summary)) return;
  const txt = p.summary.map(summaryText).join(" ").trim();
  if (txt) st.actions.push({ timestamp: ts, verb: "Thinking", detail: `~${Math.round(txt.length / 4)} tokens` });
}

function codexToolCall(st: CodexScan, p: Record<string, any>, ts: Date, full: boolean): void {
  const name = String(p.name ?? "?");
  const rawArgs = str(p.arguments ?? p.input);
  // custom_tool_call `input` is a raw string (a patch body, a script) — not
  // JSON, so `args` is null and the builders fall back to `rawArgs`.
  const args = jsonOrNull(rawArgs);
  // update_plan is surfaced as the task checklist, not as an action line —
  // its payload is the whole plan, useless as a one-liner.
  if (name === "update_plan") {
    st.latestPlan = codexPlanToTasks(args) ?? st.latestPlan;
    return;
  }
  st.actions.push(codexAction(name, args, rawArgs, ts, full));
}

function scanCodexRecord(st: CodexScan, e: Record<string, any>, p: Record<string, any>, full: boolean): void {
  const ts = timestampOf(e);
  const prompt = codexUserText(e, p);
  if (prompt) {
    st.lastPrompt = excerpt(prompt, full, 200);
    st.finalResponse = undefined; // a new prompt starts a fresh turn
    return;
  }
  switch (p.type) {
    case "message":
      return codexMessage(st, p, ts, full);
    case "reasoning":
      return codexReasoning(st, p, ts);
    case "function_call":
    case "custom_tool_call":
      return codexToolCall(st, p, ts, full);
  }
}

/** The activity in one rollout's text. Lines that are not codex records are skipped silently. */
export function parseCodexLog(raw: string, full = false): SessionActivity {
  const st: CodexScan = { actions: [], latestPlan: null };
  for (const line of raw.split("\n")) {
    const r = responseItem(line);
    if (r) scanCodexRecord(st, r.e, r.p, full);
  }
  return finalizeActivity(st.lastPrompt, st.actions, { tasks: st.latestPlan ?? undefined, finalResponse: st.finalResponse });
}

export async function loadCodexActivity(path?: string, full = false): Promise<SessionActivity> {
  const raw = await readLog(path);
  return raw === null ? { actions: [] } : parseCodexLog(raw, full);
}
