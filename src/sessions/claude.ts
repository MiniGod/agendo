import { readdir, stat } from "fs/promises";
import { join } from "path";
import { parseJsonLine } from "../shared/errors.ts";
import { forEachLine } from "../shared/lines.ts";
import { forEachPooled, INDEX_CONCURRENCY } from "../shared/pool.ts";
import { rebaseWorkflowPaths, WorkflowScan } from "../orchestration/workflows.ts";
import type { AgentSession, WorkflowRef } from "../shared/types.ts";
import { TranscriptCache } from "./cache.ts";
import { claudeBaseDirs, type SessionProvider } from "./provider.ts";

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

type ClaudeMeta = { cwd?: string; branch?: string; title?: string; createdAt?: Date; workflows?: WorkflowRef[] };

interface MetaDraft {
  cwd?: string;
  createdAt?: Date;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  lastNonBase?: string;
  lastAnyBranch?: string;
}

/** The first cwd and the first parseable timestamp win. */
function recordFirsts(d: MetaDraft, e: Record<string, any>): void {
  if (!d.cwd && e.cwd) d.cwd = e.cwd;
  if (!d.createdAt && e.timestamp) {
    const t = new Date(e.timestamp);
    if (!isNaN(t.getTime())) d.createdAt = t;
  }
}

/**
 * Take the most-RECENT gitBranch, demoting base branches (master/main). A
 * worktree that was later switched/renamed to its real feature branch (e.g. a
 * PR branch created after most of the work) should file under that current
 * branch, not the historically-dominant one — so a stale but frequent branch
 * can't outvote the branch the worktree actually ended on. We keep the last
 * NON-base branch seen (chronological — the log is append-only), falling back
 * to the last branch overall only for genuinely base-only sessions. Demoting
 * base still stops a first-few-records `master` (before HEAD settles on the
 * worktree branch), or a brief mid-session switch back to master, from winning.
 */
function recordBranch(d: MetaDraft, e: Record<string, any>): void {
  if (!e.gitBranch) return;
  d.lastAnyBranch = e.gitBranch;
  if (!BASE_BRANCHES.has(e.gitBranch)) d.lastNonBase = e.gitBranch;
}

/** The last of each title kind wins — renames can happen more than once. */
function recordTitle(d: MetaDraft, e: Record<string, any>): void {
  if (e.type === "custom-title" && e.customTitle) d.customTitle = e.customTitle;
  else if (e.type === "ai-title" && e.aiTitle) d.aiTitle = e.aiTitle;
  else if (e.type === "agent-name" && e.agentName) d.agentName = e.agentName;
}

function metaOf(d: MetaDraft, workflows: WorkflowScan): ClaudeMeta {
  return {
    cwd: d.cwd,
    branch: d.lastNonBase ?? d.lastAnyBranch,
    title: d.customTitle ?? d.aiTitle ?? d.agentName,
    createdAt: d.createdAt,
    workflows: workflows.finish(),
  };
}

/**
 * The line walk behind a transcript's session metadata, fed one line at a time
 * so a transcript is never held whole: only the running result is kept. Workflow
 * runs ride the same walk (and thus the same parse cache) — launches and
 * completion notifications are both transcript records.
 */
class ClaudeMetaScan {
  private d: MetaDraft = {};
  private workflows = new WorkflowScan();

  constructor(private filePath: string) {}

  /**
   * One line, numbered from 1. Skips are recorded as `<path>:<line>` warnings,
   * except on the final unterminated line — a live agent's half-written
   * trailing record is normal, not corruption.
   */
  line(text: string, lineNo: number, isLast: boolean): void {
    const t = text.trim();
    if (!t) return;
    const e: Record<string, any> | null = parseJsonLine(t, this.filePath, lineNo, { isLast });
    if (!e || typeof e !== "object") return;
    recordFirsts(this.d, e);
    recordBranch(this.d, e);
    recordTitle(this.d, e);
    this.workflows.record(e);
  }

  finish(): ClaudeMeta {
    return metaOf(this.d, this.workflows);
  }
}

/** One transcript's text as its session metadata (the in-memory form of parseClaudeMeta). */
export function scanClaudeMeta(raw: string, filePath: string): ClaudeMeta {
  const scan = new ClaudeMetaScan(filePath);
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) scan.line(lines[i], i + 1, i === lines.length - 1);
  return scan.finish();
}

/**
 * One transcript on disk as its session metadata, streamed line by line. The
 * fields are spread through the whole file — the LAST branch and title win, and
 * workflow launches and their notifications can sit anywhere — so no bounded
 * head or tail would do; streaming keeps the full walk while holding one line.
 */
export async function parseClaudeMeta(filePath: string): Promise<ClaudeMeta | null> {
  const scan = new ClaudeMetaScan(filePath);
  const read = await forEachLine(filePath, (text, lineNo, isLast) => scan.line(text, lineNo, isLast));
  return read === null ? null : scan.finish();
}

const claudeParseCache = new TranscriptCache();

// Test-only instrumentation: counts how many transcripts were actually read +
// parsed (cache MISSES) during index builds, so tests can prove the mtime/size
// cache serves unchanged files without re-reading. Never read in production code.
let claudeParseCount = 0;
export function __claudeParseCount(): number {
  return claudeParseCount;
}
export function __resetClaudeParseCount(): void {
  claudeParseCount = 0;
}
/** Test-only: current number of cached Claude transcript entries (to prove pruning). */
export function __claudeCacheSize(): number {
  return claudeParseCache.size;
}

/** One transcript the index will consider, with the profile it came from. */
interface ClaudeTranscript {
  dirPath: string;
  file: string;
  configDir: string;
}

/** Every top-level transcript file under one profile's `projects/` dir. */
async function profileTranscripts(projects: string, configDir: string): Promise<ClaudeTranscript[]> {
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return [];
  }
  const perDir = await Promise.all(
    dirs.map(async (dir) => {
      const dirPath = join(projects, dir);
      try {
        // `agent-<hex>.jsonl` files are sub-agent (sidechain) transcripts,
        // not resumable top-level sessions — their filename id isn't a real
        // sessionId. Skip them so they don't show up as phantom sessions.
        return (await readdir(dirPath))
          .filter((f) => f.endsWith(".jsonl") && !f.startsWith("agent-"))
          .map((file) => ({ dirPath, file, configDir }));
      } catch {
        return [];
      }
    }),
  );
  return perDir.flat();
}

/** The session a transcript describes, or null when it isn't one (no cwd). */
function sessionOf(t: ClaudeTranscript, st: { mtime: Date }, meta: ClaudeMeta | null): AgentSession | null {
  if (!meta?.cwd) return null;
  const id = t.file.replace(/\.jsonl$/, "");
  return {
    id,
    source: "claude",
    cwd: meta.cwd,
    branch: meta.branch,
    title: meta.title || id.slice(0, 8),
    lastUsed: st.mtime,
    createdAt: meta.createdAt,
    configDir: t.configDir,
    logPath: join(t.dirPath, t.file),
    // A workflow run records its dirs as ABSOLUTE paths inside the
    // transcript, so anything that relocates the session (a profile
    // move, a renamed config dir) would leave them dangling. Re-anchor
    // them on the transcript we just read, which cannot go stale.
    workflows: meta.workflows && rebaseWorkflowPaths(meta.workflows, join(t.dirPath, id), id),
  };
}

/**
 * One transcript through the cache: its session, null when it isn't one, or
 * undefined when it vanished before it could be stat'd (and so isn't `seen`).
 */
async function indexTranscript(t: ClaudeTranscript, seen: Set<string>): Promise<AgentSession | null | undefined> {
  const filePath = join(t.dirPath, t.file);
  // stat first (cheap): the cache hit path must not touch file
  // contents. A file that vanished mid-scan is skipped (and, by
  // not being marked seen, pruned from the cache below).
  const st = await stat(filePath).catch(() => null);
  if (!st) return undefined;
  seen.add(filePath);
  const cached = claudeParseCache.hit(filePath, st);
  if (cached !== undefined) return cached;
  claudeParseCount++; // cache miss: this file is actually read+parsed
  // A file with no cwd is cached as null: not a session; don't re-read it.
  const session = sessionOf(t, st, await parseClaudeMeta(filePath));
  claudeParseCache.store(filePath, st, session);
  return session;
}

export const claudeProvider: SessionProvider = {
  source: "claude",
  async index() {
    const bases = await claudeBaseDirs();
    const transcripts = (await Promise.all(bases.map(({ projects, configDir }) => profileTranscripts(projects, configDir)))).flat();
    const sessions: AgentSession[] = [];
    // Absolute paths of transcripts that still exist this scan; cache entries
    // for anything else (deleted or vanished mid-scan) are pruned afterwards.
    const seen = new Set<string>();
    // Bounded: each miss streams a whole transcript, so the number in flight —
    // not the number on disk — is what sets peak memory.
    await forEachPooled(transcripts, INDEX_CONCURRENCY, async (t) => {
      const session = await indexTranscript(t, seen);
      if (session) sessions.push(session);
    });
    // Prune cache entries for transcripts that no longer exist. The seen-set is
    // exactly the Claude files enumerated this scan, so this only ever touches
    // Claude transcript keys, and it runs after every per-file task above has
    // finished recording its path.
    claudeParseCache.prune(seen);
    return sessions;
  },
};
