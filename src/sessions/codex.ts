import { readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { homedir } from "os";
import { parseGithubRemote } from "../providers/github/index.ts";
import { codexUserText } from "./transcript.ts";
import type { AgentSession } from "../shared/types.ts";
import { TranscriptCache } from "./cache.ts";
import type { SessionProvider } from "./provider.ts";
import { forEachLine } from "../shared/lines.ts";
import { forEachPooled, INDEX_CONCURRENCY } from "../shared/pool.ts";

// ── Codex CLI ─────────────────────────────────────────────────────────────────
// Sessions ("threads") are JSONL rollout files under
// $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<uuid>.jsonl. The uuid in
// the filename is the thread id `codex resume <id>` takes.
//
// The FIRST line is a `session_meta` record carrying everything the index needs
// — id, cwd, start timestamp, and a `git` block with the branch and origin URL —
// so unlike Claude we never have to walk the whole transcript to build a row.
// We do read a bounded head of the file (CODEX_HEAD_BYTES) to find a title,
// since codex records none: the first genuine user message stands in.

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_SESSIONS = join(CODEX_HOME, "sessions");

// How much of a rollout to read when indexing. The session_meta line alone can
// run to tens of KB (it embeds the full base instructions), and the first user
// message follows within a few records, so this comfortably covers both while
// keeping the scan bounded on multi-MB transcripts.
const CODEX_HEAD_BYTES = 256 * 1024;
// Read in smaller steps than that, since the scan usually stops in the first one.
const CODEX_CHUNK_BYTES = 64 * 1024;

/**
 * Reduce a git remote URL to the identity domain `sessionInScope` compares in:
 * an `owner/repo` slug when it's a GitHub remote, else the bare repo name. Codex
 * records the raw URL (`git@ssh.dev.azure.com:v3/org/proj/repo`,
 * `https://github.com/o/r.git`), which matches neither domain as-is.
 */
function repoIdFromRemote(url: string): string | undefined {
  const gh = parseGithubRemote(url);
  if (gh) return `${gh.owner}/${gh.repo}`;
  const bare = url.trim().replace(/\.git$/, "").split(/[/:]/).pop();
  return bare || undefined;
}

export interface CodexMeta {
  id?: string;
  cwd?: string;
  branch?: string;
  repository?: string;
  title?: string;
  createdAt?: Date;
  /** A sub-agent / non-interactive thread, which must not be listed as resumable. */
  skip?: boolean;
}

/** One line of a rollout head, parsed: the event and its payload, both objects. */
interface HeadLine {
  e: Record<string, any>;
  p: Record<string, any>;
}

function parseHeadLine(line: string): HeadLine | null {
  const t = line.trim();
  if (!t) return null;
  let e: unknown;
  try {
    e = JSON.parse(t);
  } catch {
    // The last line of a bounded head read is usually truncated mid-JSON.
    return null;
  }
  if (!e || typeof e !== "object") return null;
  const p = (e as Record<string, any>).payload;
  if (!p || typeof p !== "object") return null;
  return { e: e as Record<string, any>, p };
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function dateOf(ts: unknown): Date | undefined {
  if (!ts) return undefined;
  const d = new Date(ts as string | number);
  return isNaN(d.getTime()) ? undefined : d;
}

// Threads codex spawned for itself, and `codex exec` runs, are not sessions
// the user can pick up interactively — `codex resume` hides them behind
// --include-non-interactive — so they must not be listed. A sub-agent is
// marked by `thread_source`, by a `{subagent: …}` source object, or by having
// a parent thread. A user's own `codex fork` records `forked_from_id` instead
// of `parent_thread_id`, so it stays listed.
export function skipsListing(p: Record<string, any>): boolean {
  const subagent = p.thread_source === "subagent" || (typeof p.source === "object" && p.source?.subagent);
  return !!subagent || p.source === "exec" || !!p.parent_thread_id;
}

export function sessionMetaOf(p: Record<string, any>): CodexMeta {
  const url = str(p.git?.repository_url);
  return {
    id: str(p.id),
    cwd: str(p.cwd),
    branch: str(p.git?.branch),
    repository: url === undefined ? undefined : repoIdFromRemote(url),
    createdAt: dateOf(p.timestamp),
    skip: skipsListing(p),
  };
}

// Title: codex records none, so the first genuine user message stands in.
function takeTitle(meta: CodexMeta, line: HeadLine): boolean {
  const msg = codexUserText(line.e, line.p);
  if (!msg) return false;
  meta.title = msg.slice(0, 120);
  return true;
}

/**
 * The walk over a rollout's head, fed one line at a time so it can stop the
 * moment it has what it needs — usually within the first few records, long
 * before CODEX_HEAD_BYTES.
 */
class CodexHeadScan {
  meta: CodexMeta | null = null;

  /** One line; true once nothing later in the file can change the result. */
  line(text: string): boolean {
    const line = parseHeadLine(text);
    if (!line) return false;
    if (line.e.type === "session_meta") {
      this.meta = sessionMetaOf(line.p);
      return !!this.meta.skip; // nothing else to learn about a thread we won't list
    }
    // The meta line always precedes the first message, so that is everything.
    return !!this.meta && !this.meta.title && takeTitle(this.meta, line);
  }
}

export function parseCodexHead(head: string): CodexMeta | null {
  const scan = new CodexHeadScan();
  for (const text of head.split("\n")) if (scan.line(text)) break;
  return scan.meta;
}

/**
 * A rollout's head, streamed: exactly parseCodexHead of its first
 * CODEX_HEAD_BYTES, without holding them. Undefined when nothing could be read
 * (a missing, unreadable or empty file), which the caller does not cache.
 */
export async function readCodexHead(filePath: string): Promise<CodexMeta | null | undefined> {
  const scan = new CodexHeadScan();
  const read = await forEachLine(filePath, (text) => scan.line(text), { maxBytes: CODEX_HEAD_BYTES, chunkBytes: CODEX_CHUNK_BYTES });
  return read ? scan.meta : undefined;
}

const CODEX_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const codexParseCache = new TranscriptCache();

/** The session a rollout head describes, or null when it isn't a listable one. */
function sessionOf(file: string, filePath: string, st: { mtime: Date }, meta: CodexMeta | null): AgentSession | null {
  // Sub-agent threads and malformed rollouts are cached as "not a
  // session" — codex writes one sub-agent rollout per real one, so
  // re-reading their heads every rebuild would dominate the scan.
  if (!meta || meta.skip || !meta.cwd) return null;
  // Fall back to the trailing uuid in the filename when the record has
  // no id — it's the same value, and it's what `codex resume` matches
  // on. (The name is `rollout-<timestamp>-<uuid>.jsonl`, and the
  // timestamp is dash-separated too, so anchor on the uuid shape.)
  const id = meta.id ?? file.match(CODEX_FILE_ID)?.[1];
  if (!id) return null;
  return {
    id,
    source: "codex",
    cwd: meta.cwd,
    branch: meta.branch,
    repository: meta.repository,
    title: meta.title || id.slice(0, 8),
    lastUsed: st.mtime,
    createdAt: meta.createdAt,
    logPath: filePath,
  };
}

/**
 * One rollout through the cache: its session, null when it isn't one, or
 * undefined when it couldn't be stat'd or read (a read failure is not cached,
 * so the next rebuild tries again).
 */
async function indexRollout(filePath: string, seen: Set<string>): Promise<AgentSession | null | undefined> {
  const st = await stat(filePath).catch(() => null);
  if (!st) return undefined;
  seen.add(filePath);
  const cached = codexParseCache.hit(filePath, st);
  if (cached !== undefined) return cached;
  const meta = await readCodexHead(filePath);
  if (meta === undefined) return undefined;
  const session = sessionOf(basename(filePath), filePath, st, meta);
  codexParseCache.store(filePath, st, session);
  return session;
}

/** Every rollout file in the given day dirs. */
async function rolloutFiles(dayDirs: string[]): Promise<string[]> {
  const perDay = await Promise.all(
    dayDirs.map(async (dir) => {
      try {
        return (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
      } catch {
        return [];
      }
    }),
  );
  return perDay.flat();
}

export const codexProvider: SessionProvider = {
  source: "codex",
  async index() {
    // sessions/<YYYY>/<MM>/<DD>/*.jsonl — walk the date tree rather than glob,
    // so an unexpected extra level can't blow the scan up.
    const files = await rolloutFiles(await codexDayDirs());
    const sessions: AgentSession[] = [];
    const seen = new Set<string>();
    // Bounded: each miss holds a read buffer and up to CODEX_HEAD_BYTES of a
    // pending line, so the number in flight — not the number on disk — is what
    // sets peak memory.
    await forEachPooled(files, INDEX_CONCURRENCY, async (filePath) => {
      const session = await indexRollout(filePath, seen);
      if (session) sessions.push(session);
    });
    codexParseCache.prune(seen);
    return sessions;
  },
};

/** Every `sessions/<YYYY>/<MM>/<DD>` directory under the codex home. */
async function codexDayDirs(): Promise<string[]> {
  const level = async (base: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(base, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => join(base, e.name));
  };
  const years = await level(CODEX_SESSIONS);
  const months = (await Promise.all(years.map(level))).flat();
  return (await Promise.all(months.map(level))).flat();
}
