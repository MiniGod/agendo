// ── Copilot activity ────────────────────────────────────────────────────────
// A copilot session directory holds `events.jsonl`: `user.message` and
// `assistant.message` events, the latter carrying the reply text and the tool
// requests it made. Copilot has no task checklist; the reader keeps the last
// prompt, the last reply and the action tail.

import { join } from "path";
import { clean } from "../transcript.ts";
import type { ActionLine, SessionActivity } from "../types.ts";
import { type Detail, excerpt, finalizeActivity, firstValue, jsonlRecords, readLog, shortPath, str, timestampOf } from "./common.ts";

// ── tool requests ───────────────────────────────────────────────────────────

type Args = Record<string, any>;
type Builder = (args: Args, full: boolean) => Detail;

function pathTool(verb: string): Builder {
  return function pathDetail(args: Args): Detail {
    return { verb, detail: shortPath(args.path) };
  };
}

function patternTool(verb: string): Builder {
  return function patternDetail(args: Args): Detail {
    return { verb, detail: str(args.pattern) };
  };
}

function bashDetail(args: Args, full: boolean): Detail {
  return { verb: "Bash", detail: excerpt(clean(args.command), full, 120) };
}

function agentDetail(args: Args): Detail {
  const at = args.agent_type ? `[${args.agent_type}] ` : "";
  return { verb: "Agent", detail: at + str(args.description ?? args.name) };
}

function askUserDetail(args: Args): Detail {
  return { verb: "AskUser", detail: clean(args.message).slice(0, 80) };
}

function intentDetail(args: Args): Detail {
  return { verb: "Intent", detail: str(args.intent) };
}

const COPILOT_TOOLS = new Map<string, Builder>([
  ["view", pathTool("View")],
  ["create", pathTool("Create")],
  ["edit", pathTool("Edit")],
  ["bash", bashDetail],
  ["grep", patternTool("Grep")],
  ["glob", patternTool("Glob")],
  ["task", agentDetail],
  ["ask_user", askUserDetail],
  ["report_intent", intentDetail],
]);

/** The action line for one entry of an `assistant.message`'s `toolRequests`. */
export function copilotAction(tr: any, ts: Date, full = false): ActionLine {
  const name = String(tr.name ?? "?");
  const args: Args = tr.arguments ?? {};
  const build = COPILOT_TOOLS.get(name);
  return { timestamp: ts, ...(build ? build(args, full) : { verb: name, detail: excerpt(firstValue(args), full, 80) }) };
}

// ── the walk ────────────────────────────────────────────────────────────────

interface CopilotScan {
  actions: ActionLine[];
  lastPrompt?: string;
  finalResponse?: string;
}

function copilotPrompt(st: CopilotScan, data: Args, full: boolean): void {
  const c = str(data.content);
  if (!c.trim()) return;
  st.lastPrompt = excerpt(clean(c), full, 200);
  st.finalResponse = undefined; // a new prompt starts a fresh turn
}

function copilotMessage(st: CopilotScan, data: Args, ts: Date, full: boolean): void {
  const content = typeof data.content === "string" ? data.content : "";
  const reqs: any[] = Array.isArray(data.toolRequests) ? data.toolRequests : [];
  if (content.trim()) {
    st.finalResponse = content.trim();
    // A reply that made no tool request is the visible turn; one that did is
    // shown as its requests, and the text lives on as the final response.
    if (reqs.length === 0) st.actions.push({ timestamp: ts, verb: "Copilot", detail: excerpt(clean(content), full, 200) });
  }
  for (const tr of reqs) st.actions.push(copilotAction(tr, ts, full));
}

function scanCopilotEvent(st: CopilotScan, e: Record<string, any>, full: boolean): void {
  const data: Args = e.data ?? {};
  if (e.type === "user.message") copilotPrompt(st, data, full);
  else if (e.type === "assistant.message") copilotMessage(st, data, timestampOf(e), full);
}

function notIntent(a: ActionLine): boolean {
  return a.verb !== "Intent";
}

/**
 * The activity in one `events.jsonl`'s text. `path` names the file in the
 * warning a torn line earns (see `parseJsonLine`).
 */
export function parseCopilotEvents(raw: string, path: string, full = false): SessionActivity {
  const st: CopilotScan = { actions: [] };
  for (const e of jsonlRecords(raw, path)) scanCopilotEvent(st, e, full);
  // Copilot has no task checklist; only a final response. Drop low-signal
  // intent pings, then finalize.
  return finalizeActivity(st.lastPrompt, st.actions.filter(notIntent), { finalResponse: st.finalResponse });
}

export async function loadCopilotActivity(dir?: string, full = false): Promise<SessionActivity> {
  const eventsPath = dir ? join(dir, "events.jsonl") : undefined;
  const raw = await readLog(eventsPath);
  return raw === null ? { actions: [] } : parseCopilotEvents(raw, eventsPath!, full);
}
