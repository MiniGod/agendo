// Detect Claude Workflow runs (the Workflow tool's background multi-agent
// orchestrations) from the traces they leave on disk, so the CLI can report
// them alongside a session's other state. Read-only throughout.
//
// Two layers, mirroring sessions.ts:
//   • WorkflowScan — index-time extraction from the session transcript. Runs
//     inside parseClaudeMeta's existing line walk (no extra file reads), so
//     refs ride the same mtime/size cache as the rest of the session metadata.
//   • loadWorkflowDetails — on-demand enrichment from the run's own files
//     (journal.jsonl for agent progress, the script's meta literal for
//     phases, per-agent meta for models), paid only when a run is displayed.
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import type { WorkflowDetails, WorkflowPhase, WorkflowRef, WorkflowStatus } from "./types.ts";

// ── index-time transcript scan ───────────────────────────────────────────────

/**
 * Collects workflow refs from a transcript's records, fed one parsed line at a
 * time. Two record shapes matter:
 *   • a launch: the Workflow tool_result's structured `toolUseResult`
 *     ({ taskType: "local_workflow", runId, taskId, workflowName, … }),
 *   • a finish: a user message whose string content is a `<task-notification>`
 *     block naming the launch's taskId and a final `<status>`.
 * A relaunch (resume) of the same runId replaces the ref — new taskId, cleared
 * status — so a stale notification for the old taskId can't mark it finished.
 */
export class WorkflowScan {
  private byRunId = new Map<string, WorkflowRef>();
  private byTaskId = new Map<string, WorkflowRef>();
  private order: string[] = [];

  record(e: Record<string, any>): void {
    const tur = e.toolUseResult;
    if (tur && typeof tur === "object" && tur.taskType === "local_workflow" && typeof tur.runId === "string") {
      const prev = this.byRunId.get(tur.runId);
      if (prev?.taskId) this.byTaskId.delete(prev.taskId);
      const launchedAt = e.timestamp ? new Date(e.timestamp) : undefined;
      const ref: WorkflowRef = {
        runId: tur.runId,
        taskId: typeof tur.taskId === "string" ? tur.taskId : undefined,
        name: typeof tur.workflowName === "string" && tur.workflowName ? tur.workflowName : tur.runId,
        summary: typeof tur.summary === "string" ? tur.summary : undefined,
        transcriptDir: typeof tur.transcriptDir === "string" ? tur.transcriptDir : undefined,
        scriptPath: typeof tur.scriptPath === "string" ? tur.scriptPath : undefined,
        launchedAt: launchedAt && !isNaN(launchedAt.getTime()) ? launchedAt : undefined,
      };
      if (!prev) this.order.push(ref.runId);
      this.byRunId.set(ref.runId, ref);
      if (ref.taskId) this.byTaskId.set(ref.taskId, ref);
      return;
    }
    // Completion notifications are delivered as a user message with STRING
    // content (also mirrored in queue-operation records, whose text lives in a
    // top-level `content`). Requiring the block to START with the tag keeps a
    // conversation that merely quotes one from matching; requiring the task-id
    // to be a known workflow taskId keeps plain sub-agent notifications out.
    const content =
      typeof e.content === "string" ? e.content
      : typeof e.message?.content === "string" ? e.message.content
      : null;
    if (!content || !content.trimStart().startsWith("<task-notification>")) return;
    const taskId = content.match(/<task-id>([^<]+)<\/task-id>/)?.[1];
    const status = content.match(/<status>([^<]+)<\/status>/)?.[1]?.trim();
    if (!taskId || !status) return;
    const ref = this.byTaskId.get(taskId);
    if (ref) ref.notifiedStatus = status;
  }

  /** The refs in launch order, or undefined when the transcript had none. */
  finish(): WorkflowRef[] | undefined {
    if (this.order.length === 0) return undefined;
    return this.order.map((id) => this.byRunId.get(id)!);
  }
}

/**
 * Re-anchor a run's recorded paths onto the session's CURRENT sidecar dir.
 *
 * `transcriptDir` / `scriptPath` are written into the transcript as ABSOLUTE
 * paths at launch time (`<profile>/projects/<enc-cwd>/<id>/…`), so anything that
 * relocates the session afterwards — moving it to another Claude profile,
 * renaming a config dir, restoring a backup elsewhere — leaves every run's
 * details unreadable and the workflow section silently blank. Resolving them
 * against the transcript we just read instead makes that structurally impossible:
 * the recorded prefix is never trusted, only the tail below the session dir.
 *
 * The session id is always a path segment of a recorded path (the sidecar dir is
 * named after it), so everything up to and including the LAST `/<id>/` is
 * replaced with `sessionDir` — last, so an `<enc-cwd>` that happens to contain
 * the id can't be mistaken for the sidecar. A path with no such segment isn't one
 * of ours and is passed through exactly as recorded.
 */
export function rebaseWorkflowPaths(refs: WorkflowRef[], sessionDir: string, id: string): WorkflowRef[] {
  return refs.map((r) => ({
    ...r,
    transcriptDir: rebaseUnderSession(r.transcriptDir, sessionDir, id),
    scriptPath: rebaseUnderSession(r.scriptPath, sessionDir, id),
  }));
}

function rebaseUnderSession(p: string | undefined, sessionDir: string, id: string): string | undefined {
  if (!p) return p;
  const marker = `/${id}/`;
  const i = p.lastIndexOf(marker);
  return i < 0 ? p : join(sessionDir, p.slice(i + marker.length));
}

/**
 * Effective run state. A notification is authoritative; without one the run is
 * only alive if its session still has a live tmux window (workflows run
 * in-process — no session, no workflow), else it died mid-run: "interrupted".
 */
export function workflowStatus(ref: WorkflowRef, sessionLive: boolean): WorkflowStatus {
  const s = ref.notifiedStatus?.toLowerCase();
  if (s) {
    if (s === "completed" || s === "success" || s === "succeeded") return "completed";
    if (/kill|stop|cancel/.test(s)) return "stopped";
    return "failed";
  }
  return sessionLive ? "running" : "interrupted";
}

// ── on-demand detail from the run's files ────────────────────────────────────

/**
 * Read a run's own files for display detail. Every source is optional — a
 * missing journal/script/dir just leaves its fields empty, so a ref whose
 * files were cleaned up still renders (as identity only).
 */
export async function loadWorkflowDetails(ref: WorkflowRef): Promise<WorkflowDetails> {
  const [journal, files, meta] = await Promise.all([
    readJournal(ref.transcriptDir),
    scanRunDir(ref.transcriptDir),
    readScriptMeta(ref.scriptPath),
  ]);
  return {
    agentsStarted: journal.started.size,
    agentsDone: journal.done.size,
    lastActivity: files.lastActivity,
    description: meta.description,
    phases: meta.phases,
    modelCounts: files.modelCounts,
  };
}

/** journal.jsonl: `started` / `result` events, one per agent spawn / finish. */
async function readJournal(dir?: string): Promise<{ started: Set<string>; done: Set<string> }> {
  const started = new Set<string>();
  const done = new Set<string>();
  if (!dir) return { started, done };
  let raw: string;
  try {
    raw = await readFile(join(dir, "journal.jsonl"), "utf-8");
  } catch {
    return { started, done };
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || typeof e.agentId !== "string") continue;
    if (e.type === "started") started.add(e.agentId);
    else if (e.type === "result") done.add(e.agentId);
  }
  return { started, done };
}

/**
 * Stat the run dir for a last-activity heartbeat (agent transcripts are
 * appended to continuously while agents run) and tally agent models from the
 * tiny per-agent `agent-<id>.meta.json` files.
 */
async function scanRunDir(dir?: string): Promise<{ lastActivity?: Date; modelCounts?: Record<string, number> }> {
  if (!dir) return {};
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return {};
  }
  let last = 0;
  const counts: Record<string, number> = {};
  await Promise.all(
    entries.map(async (f) => {
      const p = join(dir, f);
      const st = await stat(p).catch(() => null);
      if (st && st.mtimeMs > last) last = st.mtimeMs;
      if (f.startsWith("agent-") && f.endsWith(".meta.json")) {
        try {
          const m = JSON.parse(await readFile(p, "utf-8"));
          if (m && typeof m.model === "string") counts[m.model] = (counts[m.model] ?? 0) + 1;
        } catch {
          /* unreadable meta: skip */
        }
      }
    }),
  );
  return {
    lastActivity: last > 0 ? new Date(last) : undefined,
    modelCounts: Object.keys(counts).length ? counts : undefined,
  };
}

/** Read + parse the script's `export const meta = {…}` literal, if present. */
async function readScriptMeta(path?: string): Promise<{ description?: string; phases?: WorkflowPhase[] }> {
  if (!path) return {};
  let src: string;
  try {
    src = await readFile(path, "utf-8");
  } catch {
    return {};
  }
  return parseWorkflowMeta(src);
}

/**
 * Extract description + phases from a workflow script's meta. The tool
 * contract makes meta a PURE literal (no computed values), so a string-aware
 * brace scan bounds the object and simple regexes read the fields. Anything
 * malformed degrades to {} — display just loses the extra context.
 * Exported for tests.
 */
export function parseWorkflowMeta(src: string): { description?: string; phases?: WorkflowPhase[] } {
  const head = src.match(/export\s+const\s+meta\s*=/);
  if (head?.index === undefined) return {};
  const open = src.indexOf("{", head.index);
  if (open < 0) return {};
  const close = scanBalanced(src, open, "{", "}");
  if (close < 0) return {};
  const meta = src.slice(open, close + 1);

  const out: { description?: string; phases?: WorkflowPhase[] } = {};
  out.description = readStringProp(meta, "description");

  const phasesKey = meta.match(/\bphases\s*:\s*/);
  if (phasesKey?.index !== undefined) {
    const arrOpen = meta.indexOf("[", phasesKey.index);
    if (arrOpen >= 0) {
      const arrClose = scanBalanced(meta, arrOpen, "[", "]");
      if (arrClose > arrOpen) {
        const phases: WorkflowPhase[] = [];
        let i = arrOpen + 1;
        while (i < arrClose) {
          const entryOpen = meta.indexOf("{", i);
          if (entryOpen < 0 || entryOpen >= arrClose) break;
          const entryClose = scanBalanced(meta, entryOpen, "{", "}");
          if (entryClose < 0) break;
          const entry = meta.slice(entryOpen, entryClose + 1);
          const title = readStringProp(entry, "title");
          if (title) {
            phases.push({
              title,
              detail: readStringProp(entry, "detail"),
              model: readStringProp(entry, "model"),
            });
          }
          i = entryClose + 1;
        }
        if (phases.length) out.phases = phases;
      }
    }
  }
  return out;
}

/** First `key: '…'` / `key: "…"` / key: `…` value in an object-literal slice. */
function readStringProp(slice: string, key: string): string | undefined {
  const m = slice.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`));
  return m ? m[2].replace(/\\(.)/g, "$1") : undefined;
}

/**
 * Index of the delimiter closing the one at `openIdx`, skipping quoted strings
 * (', ", `) and their escapes so braces inside meta strings don't miscount.
 * Returns -1 when unbalanced.
 */
function scanBalanced(src: string, openIdx: number, open: string, close: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++; // skip the escaped char
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  return -1;
}
