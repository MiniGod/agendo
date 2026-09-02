// ── Activity: the pieces every reader shares ────────────────────────────────
// One reader per agent (claude.ts, copilot.ts, codex.ts) turns a session log
// into a SessionActivity; this is the vocabulary they agree on — how a path is
// shortened, how a status word is folded, how the tail of the action list is
// cut — and the finalizer that stamps inter-action deltas on the result.

import { readFile } from "fs/promises";
import { parseJsonLine } from "../errors.ts";
import { clean } from "../transcript.ts";
import type { ActionLine, SessionActivity, TaskItem, TaskStatus } from "../types.ts";

export const ACTIVITY_LIMIT = 12; // recent actions surfaced per session

/** The verb/detail half of an action line, before the timestamp is attached. */
export type Detail = Pick<ActionLine, "verb" | "detail">;

/** Shorten a file path to its last couple of components for compact display. */
export function shortPath(p: unknown): string {
  const parts = String(p ?? "").replace(/^\/home\/[^/]+\//, "~/").split("/");
  return parts.length > 3 ? "…/" + parts.slice(-2).join("/") : parts.join("/");
}

/** A display cut: the whole string under `--full`, else its first `n` chars. */
export function excerpt(s: string, full: boolean, n: number): string {
  return full ? s : s.slice(0, n);
}

/** `String(v)` with null and undefined reading as the empty string. */
export function str(v: unknown): string {
  return String(v ?? "");
}

/**
 * The generic one-liner for a tool we have no special rendering for: the first
 * argument value, whatever it is.
 */
export function firstValue(args: object): string {
  return clean(Object.values(args).slice(0, 1).map(String).join(""));
}

/** A record's `timestamp` as a Date, or the epoch when it carries none. */
export function timestampOf(e: Record<string, any>): Date {
  return e.timestamp ? new Date(e.timestamp) : new Date(0);
}

/** The log at `path`, or null when there is no path or the file cannot be read. */
export async function readLog(path: string | undefined): Promise<string | null> {
  if (!path) return null;
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * The object records of a JSONL transcript, in order. Malformed lines go
 * through `parseJsonLine` (torn-append recovery, one warning per file) and are
 * dropped; so are lines that parse but are not objects — JSON.parse("null"),
 * "42", "\"x\"" all succeed and none of them can carry a field.
 */
export function* jsonlRecords(raw: string, path: string): Generator<Record<string, any>> {
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const e = parseJsonLine(t, path, i + 1, { isLast: i === lines.length - 1 });
    if (e && typeof e === "object") yield e;
  }
}

// ── task checklist vocabulary ───────────────────────────────────────────────
// Normalize the several status vocabularies we see (Claude's TodoWrite uses
// pending|in_progress|completed; des-workflow TaskUpdate uses active/closed/…;
// Codex's update_plan uses Claude's three) into the three the UI renders. Match
// tokens EXACTLY (after folding spaces and dashes to underscores) so
// "not_started"/"inactive" don't false-positive into in_progress via a
// substring like "started"/"active".
const IN_PROGRESS = new Set(["in_progress", "inprogress", "active", "doing", "current", "started", "working"]);
const COMPLETED = new Set(["completed", "complete", "done", "closed", "resolved", "finished"]);
export function normalizeTaskStatus(raw: unknown): TaskStatus {
  const s = String(raw ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (IN_PROGRESS.has(s)) return "in_progress";
  if (COMPLETED.has(s)) return "completed";
  return "pending";
}

/**
 * Compute inter-action deltas across the FULL log, then keep only the tail so
 * the first surfaced line still shows the real gap from the action before it.
 * The task checklist and final response are NOT capped — they describe overall
 * state, not the rolling window of recent actions.
 */
export function finalizeActivity(
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
