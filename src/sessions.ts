// Discovers resumable agent sessions on disk and indexes them by branch so the
// UI can answer "what sessions exist for this work item's PR branch?".
//
// Two providers today (Claude Code, Copilot CLI) behind a small interface so
// more agent types can be added later. Both index their on-disk sessions and
// both resume natively (Claude via `claude --resume`, Copilot via
// `copilot --resume=<id>`); see launch.ts:resumeArgv.
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { ActionLine, AgentSession, AgentSource, SessionActivity, TaskItem, TaskStatus } from "./types.ts";

const COPILOT_STATE = join(homedir(), ".copilot", "session-state");

// Claude config dirs to scan. The user may run multiple subscriptions/profiles,
// each with its own ~/.claude* dir (e.g. ~/.claude and ~/.claude-work). We scan
// every ~/.claude*/projects we find and remember which config dir each came
// from (needed to set CLAUDE_CONFIG_DIR on resume). stat() follows symlinks, so
// ~/.claude pointing into a dotfiles repo works, and non-dirs like
// ~/.claude.json are skipped (no projects subdir).
async function claudeBaseDirs(): Promise<{ projects: string; configDir: string }[]> {
  const home = homedir();
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return [];
  }
  const out: { projects: string; configDir: string }[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (!e.startsWith(".claude")) return;
      const configDir = join(home, e);
      const projects = join(configDir, "projects");
      const st = await stat(projects).catch(() => null);
      if (st?.isDirectory()) out.push({ projects, configDir });
    }),
  );
  return out;
}

interface SessionProvider {
  source: AgentSource;
  index(): Promise<AgentSession[]>;
}

// ── Claude Code ───────────────────────────────────────────────────────────────
// Each session is one JSONL file under projects/<encoded-cwd>/<sessionId>.jsonl.
// Records carry `cwd`, `gitBranch`, and one of three title records. A session's
// display name comes from, in priority order:
//   1. `custom-title` (customTitle)  — set explicitly by the user via `/rename`
//   2. `ai-title`     (aiTitle)      — auto-generated summary of the conversation
//   3. `agent-name`   (agentName)    — name a session was launched under as an agent
// We read mtime for "last used".
//
// The title records appear at varying points in the file (a `/rename` is
// appended whenever the user runs it, often long after an early `ai-title`), so
// we must scan the whole file rather than stop at the first title we see — and
// keep the *last* of each, since renames can happen more than once.

// Branches a session should not be FILED under when any feature branch is
// present: a `claude -w` worktree session logs its parent base branch (master)
// heavily before HEAD settles on the worktree/feature branch. Static set keeps
// indexing cheap — no git/network call per session. (Do NOT use worktree.ts's
// remote-default-branch helper here; it shells out to git.)
const BASE_BRANCHES = new Set(["master", "main"]);

async function parseClaudeMeta(
  filePath: string,
): Promise<{ cwd?: string; branch?: string; title?: string; createdAt?: Date } | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
  let cwd: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let agentName: string | undefined;
  let createdAt: Date | undefined;
  // Take the most-RECENT gitBranch, demoting base branches (master/main). A
  // worktree that was later switched/renamed to its real feature branch (e.g. a
  // PR branch created after most of the work) should file under that current
  // branch, not the historically-dominant one — so a stale but frequent branch
  // can't outvote the branch the worktree actually ended on. We keep the last
  // NON-base branch seen (chronological — the log is append-only), falling back
  // to the last branch overall only for genuinely base-only sessions. Demoting
  // base still stops a first-few-records `master` (before HEAD settles on the
  // worktree branch), or a brief mid-session switch back to master, from winning.
  let lastNonBase: string | undefined;
  let lastAnyBranch: string | undefined;
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
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!createdAt && e.timestamp) {
      const d = new Date(e.timestamp);
      if (!isNaN(d.getTime())) createdAt = d;
    }
    if (e.gitBranch) {
      lastAnyBranch = e.gitBranch;
      if (!BASE_BRANCHES.has(e.gitBranch)) lastNonBase = e.gitBranch;
    }
    if (e.type === "custom-title" && e.customTitle) customTitle = e.customTitle;
    else if (e.type === "ai-title" && e.aiTitle) aiTitle = e.aiTitle;
    else if (e.type === "agent-name" && e.agentName) agentName = e.agentName;
  }
  const branch = lastNonBase ?? lastAnyBranch;
  return { cwd, branch, title: customTitle ?? aiTitle ?? agentName, createdAt };
}

const claudeProvider: SessionProvider = {
  source: "claude",
  async index() {
    const bases = await claudeBaseDirs();
    const sessions: AgentSession[] = [];
    await Promise.all(
      bases.map(async ({ projects, configDir }) => {
        let dirs: string[];
        try {
          dirs = await readdir(projects);
        } catch {
          return;
        }
        await Promise.all(
          dirs.map(async (dir) => {
            const dirPath = join(projects, dir);
            let files: string[];
            try {
              // `agent-<hex>.jsonl` files are sub-agent (sidechain) transcripts,
              // not resumable top-level sessions — their filename id isn't a real
              // sessionId. Skip them so they don't show up as phantom sessions.
              files = (await readdir(dirPath)).filter(
                (f) => f.endsWith(".jsonl") && !f.startsWith("agent-"),
              );
            } catch {
              return;
            }
            await Promise.all(
              files.map(async (file) => {
                const filePath = join(dirPath, file);
                const [meta, st] = await Promise.all([
                  parseClaudeMeta(filePath),
                  stat(filePath).catch(() => null),
                ]);
                if (!meta?.cwd) return;
                const id = file.replace(/\.jsonl$/, "");
                sessions.push({
                  id,
                  source: "claude",
                  cwd: meta.cwd,
                  branch: meta.branch,
                  title: meta.title || id.slice(0, 8),
                  lastUsed: st?.mtime ?? new Date(0),
                  createdAt: meta.createdAt,
                  configDir,
                  logPath: filePath,
                });
              }),
            );
          }),
        );
      }),
    );
    return sessions;
  },
};

// ── Copilot CLI ───────────────────────────────────────────────────────────────
// Sessions live under session-state/<id>/workspace.yaml (flat key: value).
function parseFlatYaml(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m && m[2] !== "|-" && m[2] !== "|") out[m[1]] = m[2].trim();
  }
  return out;
}

const copilotProvider: SessionProvider = {
  source: "copilot",
  async index() {
    let dirs: string[];
    try {
      dirs = await readdir(COPILOT_STATE);
    } catch {
      return [];
    }
    const sessions: AgentSession[] = [];
    await Promise.all(
      dirs.map(async (dir) => {
        const sessionDir = join(COPILOT_STATE, dir);
        const wsPath = join(sessionDir, "workspace.yaml");
        const [raw, st] = await Promise.all([
          readFile(wsPath, "utf-8").catch(() => null),
          stat(sessionDir).catch(() => null),
        ]);
        if (!raw) return;
        const ws = parseFlatYaml(raw);
        if (!ws.cwd) return;
        // createdAt is intentionally omitted for Copilot: the index reads only
        // workspace.yaml; deriving createdAt from events.jsonl would add per-session
        // I/O at index time. Sorting falls back to lastUsed for Copilot sessions.
        sessions.push({
          id: ws.id ?? dir,
          source: "copilot",
          cwd: ws.cwd,
          branch: ws.branch,
          repository: ws.repository,
          title: ws.name || (ws.id ?? dir).slice(0, 8),
          lastUsed: st?.mtime ?? new Date(0),
          logPath: sessionDir,
        });
      }),
    );
    return sessions;
  },
};

const PROVIDERS = [claudeProvider, copilotProvider];

/** An index of all discovered sessions, queryable by branch. */
export class SessionIndex {
  private byBranch = new Map<string, AgentSession[]>();
  readonly all: AgentSession[] = [];

  static async build(): Promise<SessionIndex> {
    const idx = new SessionIndex();
    const lists = await Promise.all(PROVIDERS.map((p) => p.index()));
    // Dedupe by source:id — the same session file can be discovered more than
    // once when two scanned config dirs resolve to the same place (e.g. a
    // symlinked ~/.claude). Keep the most-recently-used copy so it isn't listed
    // (or keyed in the UI) twice.
    const byId = new Map<string, AgentSession>();
    for (const list of lists) {
      for (const s of list) {
        const key = `${s.source}:${s.id}`;
        const prev = byId.get(key);
        if (!prev || s.lastUsed.getTime() > prev.lastUsed.getTime()) byId.set(key, s);
      }
    }
    for (const s of byId.values()) {
      idx.all.push(s);
      if (s.branch) {
        const arr = idx.byBranch.get(s.branch) ?? [];
        arr.push(s);
        idx.byBranch.set(s.branch, arr);
      }
    }
    for (const arr of idx.byBranch.values()) {
      arr.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
    }
    return idx;
  }

  forBranch(branch: string | undefined): AgentSession[] {
    if (!branch) return [];
    return this.byBranch.get(branch) ?? [];
  }

  /**
   * Sessions tied to a work item by its id appearing in the branch name or
   * working directory (e.g. branch `worktree-…-231938`, worktree dir `…-231938`).
   * Used to surface sessions for items that have no PR to match on. The digit
   * boundaries prevent #231938 from matching e.g. 1231938 or 2319380.
   */
  forWorkItem(id: number): AgentSession[] {
    const re = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    return this.all.filter((s) => (s.branch && re.test(s.branch)) || re.test(s.cwd));
  }
}

// ── On-demand activity (recent action lines) ────────────────────────────────
// The index above stays cheap (metadata only). When a session row is expanded
// in the UI we parse its full log here to surface the last few actions — the
// same idea as the standalone claude-tasks dashboard, but loaded one file at a
// time so it's only paid for sessions the user actually opens.
const ACTIVITY_LIMIT = 12; // recent actions surfaced per session

function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

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
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(t);
    } catch {
      continue;
    }
    // JSON.parse("null")/"42"/"\"x\"" succeed but aren't records — skip them so a
    // stray primitive line can't crash the field access below.
    if (!e || typeof e !== "object") continue;
    const ts = e.timestamp ? new Date(e.timestamp) : new Date(0);
    if (e.type === "user") {
      const txt = userText(e.message?.content);
      // A genuine new human prompt (not a tool_result) starts a fresh turn, so
      // the previous turn's answer is no longer "the final response".
      if (txt) {
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
  let raw: string;
  try {
    raw = await readFile(join(dir, "events.jsonl"), "utf-8");
  } catch {
    return { actions: [] };
  }
  const actions: ActionLine[] = [];
  let lastPrompt: string | undefined;
  let finalResponse: string | undefined;
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

/** Options for on-demand activity loading. `full` skips display truncation. */
export interface LoadActivityOpts {
  /** When true, don't truncate the last prompt or action details (for `agendo status --full`). */
  full?: boolean;
}

/** Parse a session's recent activity on demand (called when its row expands). */
export function loadActivity(s: AgentSession, opts: LoadActivityOpts = {}): Promise<SessionActivity> {
  return s.source === "claude"
    ? loadClaudeActivity(s.logPath, opts.full)
    : loadCopilotActivity(s.logPath, opts.full);
}
