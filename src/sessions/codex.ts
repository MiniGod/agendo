import { open, readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { parseGithubRemote } from "../github.ts";
import { codexUserText } from "../transcript.ts";
import type { AgentSession } from "../types.ts";
import { TranscriptCache } from "./cache.ts";
import type { SessionProvider } from "./provider.ts";

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

/** Read at most `max` bytes from the head of a file (utf-8, may split a line). */
async function readHead(path: string, max: number): Promise<string | null> {
  let fh;
  try {
    fh = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.alloc(max);
    const { bytesRead } = await fh.read(buf, 0, max, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

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

function headLines(head: string): HeadLine[] {
  return head.split("\n").map(parseHeadLine).filter((l): l is HeadLine => l !== null);
}

export function parseCodexHead(head: string): CodexMeta | null {
  let meta: CodexMeta | null = null;
  for (const line of headLines(head)) {
    if (line.e.type === "session_meta") {
      meta = sessionMetaOf(line.p);
      if (meta.skip) return meta; // nothing else to learn about a thread we won't list
      continue;
    }
    // The meta line always precedes the first message, so that is everything.
    if (meta && !meta.title && takeTitle(meta, line)) return meta;
  }
  return meta;
}

const CODEX_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const codexParseCache = new TranscriptCache();

export const codexProvider: SessionProvider = {
  source: "codex",
  async index() {
    // sessions/<YYYY>/<MM>/<DD>/*.jsonl — walk the date tree rather than glob,
    // so an unexpected extra level can't blow the scan up.
    const dayDirs = await codexDayDirs();
    const sessions: AgentSession[] = [];
    const seen = new Set<string>();
    await Promise.all(
      dayDirs.map(async (dir) => {
        let files: string[];
        try {
          files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
        } catch {
          return;
        }
        await Promise.all(
          files.map(async (file) => {
            const filePath = join(dir, file);
            const st = await stat(filePath).catch(() => null);
            if (!st) return;
            seen.add(filePath);
            const cached = codexParseCache.hit(filePath, st);
            if (cached !== undefined) {
              if (cached) sessions.push(cached);
              return;
            }
            const head = await readHead(filePath, CODEX_HEAD_BYTES);
            if (!head) return;
            const meta = parseCodexHead(head);
            // Sub-agent threads and malformed rollouts are cached as "not a
            // session" — codex writes one sub-agent rollout per real one, so
            // re-reading their heads every rebuild would dominate the scan.
            if (!meta || meta.skip || !meta.cwd) {
              codexParseCache.store(filePath, st, null);
              return;
            }
            // Fall back to the trailing uuid in the filename when the record has
            // no id — it's the same value, and it's what `codex resume` matches
            // on. (The name is `rollout-<timestamp>-<uuid>.jsonl`, and the
            // timestamp is dash-separated too, so anchor on the uuid shape.)
            const id = meta.id ?? file.match(CODEX_FILE_ID)?.[1];
            if (!id) {
              codexParseCache.store(filePath, st, null);
              return;
            }
            const session: AgentSession = {
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
            codexParseCache.store(filePath, st, session);
            sessions.push(session);
          }),
        );
      }),
    );
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
