// Discovers resumable agent sessions on disk and indexes them by branch so the
// UI can answer "what sessions exist for this work item's PR branch?".
//
// Three providers today (Claude Code, Copilot CLI, Codex CLI) behind a small
// interface so more agent types can be added later. Each indexes its own
// on-disk sessions and each resumes natively (Claude via `claude --resume`,
// Copilot via `copilot --resume=<id>`, Codex via `codex resume <id>`); see
// launch.ts:resumeArgv.
import { existsSync } from "fs";
import { open, readdir, readFile, realpath, stat } from "fs/promises";
import { spawnSync } from "child_process";
import { basename, join } from "path";
import { homedir } from "os";
import { repoRootForCwd } from "./repos.ts";
import { parseJsonLine } from "./errors.ts";
import { parseGithubRemote } from "./github.ts";
import type { ActionLine, AgentSession, AgentSource, SessionActivity, TaskItem, TaskStatus, WorkflowRef } from "./types.ts";
import { rebaseWorkflowPaths, WorkflowScan } from "./workflows.ts";
import { dedupeProfiles, discoverProfiles } from "./profiles.ts";

const COPILOT_STATE = join(homedir(), ".copilot", "session-state");

// Claude config dirs to scan. The user may run multiple subscriptions/profiles,
// each with its own ~/.claude* dir (e.g. ~/.claude and ~/.claude-work); we
// remember which config dir each session came from (needed to set
// CLAUDE_CONFIG_DIR on resume). Discovery — and the realpath dedupe that stops a
// store symlinked between two profiles from being walked twice — lives in
// profiles.ts, which also owns moving a session between them.
function claudeBaseDirs(): Promise<{ projects: string; configDir: string }[]> {
  return discoverProfiles().then(dedupeProfiles);
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
): Promise<{ cwd?: string; branch?: string; title?: string; createdAt?: Date; workflows?: WorkflowRef[] } | null> {
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
  // Workflow runs ride the same line walk (and thus the same parse cache) —
  // launches and completion notifications are both transcript records.
  const workflows = new WorkflowScan();
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    // Skips are recorded as `<path>:<line>` warnings, except on the final line —
    // a live agent's half-written trailing record is normal, not corruption.
    const e: Record<string, any> | null = parseJsonLine(t, filePath, i + 1, { isLast: i === lines.length - 1 });
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
    workflows.record(e);
  }
  const branch = lastNonBase ?? lastAnyBranch;
  return { cwd, branch, title: customTitle ?? aiTitle ?? agentName, createdAt, workflows: workflows.finish() };
}

// Per-transcript parse cache, keyed by absolute .jsonl path. Parsing a
// transcript means reading + JSON-parsing a possibly huge file; with the index
// rebuilt on a short timer that dominated a CPU core across hundreds of MB of
// transcripts. Since a transcript only gains records by being appended to
// (mtime AND size move together on any change), reusing the built AgentSession
// while both match is pure memoization — build() output stays byte-for-byte
// identical for a given on-disk state. The one actively-appending transcript
// (the foreground session's own log) still re-parses every build because its
// mtime/size change each tick; that's one file, not the whole corpus.
// Incremental tail-by-offset reading of that growing file is a possible future
// follow-up, not done here.
//
// Files that turn out NOT to be sessions are cached too, as null: codex writes a
// sub-agent rollout beside every real one, and without a negative entry each
// rebuild would re-read all of them forever.
//
// One instance per provider, so a provider's prune (which deletes every key not
// seen this scan) can only ever touch its own transcripts.
class TranscriptCache {
  private map = new Map<string, { mtimeMs: number; size: number; session: AgentSession | null }>();

  /**
   * The cached result for this file, if it hasn't changed since we parsed it:
   * the built session, `null` for a file we've already judged not to be one, or
   * `undefined` for a genuine miss the caller must parse.
   */
  hit(path: string, st: { mtimeMs: number; size: number }): AgentSession | null | undefined {
    const c = this.map.get(path);
    return c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c.session : undefined;
  }

  store(path: string, st: { mtimeMs: number; size: number }, session: AgentSession | null): void {
    this.map.set(path, { mtimeMs: st.mtimeMs, size: st.size, session });
  }

  /** Drop entries for transcripts that no longer exist (`seen` = this scan's files). */
  prune(seen: Set<string>): void {
    for (const path of this.map.keys()) if (!seen.has(path)) this.map.delete(path);
  }

  get size(): number {
    return this.map.size;
  }
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

const claudeProvider: SessionProvider = {
  source: "claude",
  async index() {
    const bases = await claudeBaseDirs();
    const sessions: AgentSession[] = [];
    // Absolute paths of transcripts that still exist this scan; cache entries
    // for anything else (deleted or vanished mid-scan) are pruned afterwards.
    const seen = new Set<string>();
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
                // stat first (cheap): the cache hit path must not touch file
                // contents. A file that vanished mid-scan is skipped (and, by
                // not being marked seen, pruned from the cache below).
                const st = await stat(filePath).catch(() => null);
                if (!st) return;
                seen.add(filePath);
                const cached = claudeParseCache.hit(filePath, st);
                if (cached !== undefined) {
                  if (cached) sessions.push(cached);
                  return;
                }
                claudeParseCount++; // cache miss: this file is actually read+parsed
                const meta = await parseClaudeMeta(filePath);
                if (!meta?.cwd) {
                  claudeParseCache.store(filePath, st, null); // not a session; don't re-read it
                  return;
                }
                const id = file.replace(/\.jsonl$/, "");
                const session: AgentSession = {
                  id,
                  source: "claude",
                  cwd: meta.cwd,
                  branch: meta.branch,
                  title: meta.title || id.slice(0, 8),
                  lastUsed: st.mtime,
                  createdAt: meta.createdAt,
                  configDir,
                  logPath: filePath,
                  // A workflow run records its dirs as ABSOLUTE paths inside the
                  // transcript, so anything that relocates the session (a profile
                  // move, a renamed config dir) would leave them dangling. Re-anchor
                  // them on the transcript we just read, which cannot go stale.
                  workflows: meta.workflows && rebaseWorkflowPaths(meta.workflows, join(dirPath, id), id),
                };
                claudeParseCache.store(filePath, st, session);
                sessions.push(session);
              }),
            );
          }),
        );
      }),
    );
    // Prune cache entries for transcripts that no longer exist. The seen-set is
    // exactly the Claude files enumerated this scan, so this only ever touches
    // Claude transcript keys, and it runs after every per-file task above has
    // finished recording its path.
    claudeParseCache.prune(seen);
    return sessions;
  },
};

// ── Copilot CLI ───────────────────────────────────────────────────────────────
// Sessions live under session-state/<id>/workspace.yaml (flat key: value).
// Deliberately NOT cached like the Claude scan: workspace.yaml is tiny and
// lastUsed derives from a directory stat, so caching would cost more than it saves.
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
 * The VS Code extension wraps the typed prompt in a context preamble (active
 * file, open tabs, …) and puts the real request under this header. We keep what
 * follows it and drop the machine-generated part above.
 */
const CODEX_IDE_REQUEST = /^# Context from my IDE setup:[\s\S]*?## My request for Codex:\s*/;

/**
 * Reduce a "user" turn to what the user actually typed, or "" when the whole
 * turn was injected by codex.
 *
 * Codex opens a thread with several such turns — `<environment_context>`,
 * `<user_instructions>`, `<recommended_plugins>`, the AGENTS.md dump — and more
 * keep appearing across versions, so we drop them by the two SHAPES they take
 * (an XML-ish block, or a markdown-header preamble) rather than enumerating
 * each one. The IDE preamble is the exception: it *contains* the real prompt.
 */
function stripCodexPreamble(msg: string): string {
  const ide = msg.replace(CODEX_IDE_REQUEST, "");
  if (ide !== msg) return ide.trim();
  return msg.startsWith("<") || /^# AGENTS\.md instructions/.test(msg) ? "" : msg;
}

/**
 * The user-typed text of a codex transcript record, or undefined if it isn't a
 * user turn (or is one codex injected).
 *
 * Reads only `response_item` records: those are the model-facing conversation
 * and are present in every codex version we've seen, whereas the parallel
 * `event_msg`/`user_message` stream is absent from newer top-level threads. It
 * also means a message can't be counted twice from the two streams.
 */
function codexUserText(e: Record<string, any>, p: Record<string, any>): string | undefined {
  if (e.type !== "response_item" || p.type !== "message" || p.role !== "user") return undefined;
  if (!Array.isArray(p.content)) return undefined;
  const raw = p.content
    .filter((c: any) => c?.type === "input_text" && typeof c.text === "string")
    .map((c: any) => c.text)
    .join(" ");
  return clean(stripCodexPreamble(raw)) || undefined;
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

interface CodexMeta {
  id?: string;
  cwd?: string;
  branch?: string;
  repository?: string;
  title?: string;
  createdAt?: Date;
  /** A sub-agent / non-interactive thread, which must not be listed as resumable. */
  skip?: boolean;
}

function parseCodexHead(head: string): CodexMeta | null {
  let meta: CodexMeta | null = null;
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: Record<string, any>;
    try {
      e = JSON.parse(t);
    } catch {
      // The last line of a bounded head read is usually truncated mid-JSON.
      continue;
    }
    if (!e || typeof e !== "object") continue;
    const p = e.payload;
    if (!p || typeof p !== "object") continue;
    if (e.type === "session_meta") {
      // Threads codex spawned for itself, and `codex exec` runs, are not
      // sessions the user can pick up interactively — `codex resume` hides them
      // behind --include-non-interactive — so they must not be listed. A
      // sub-agent is marked by `thread_source`, by a `{subagent: …}` source
      // object, or by having a parent thread. A user's own `codex fork` records
      // `forked_from_id` instead of `parent_thread_id`, so it stays listed.
      const subagent = p.thread_source === "subagent" || (typeof p.source === "object" && p.source?.subagent);
      const skip = !!subagent || p.source === "exec" || !!p.parent_thread_id;
      const created = p.timestamp ? new Date(p.timestamp) : undefined;
      meta = {
        id: typeof p.id === "string" ? p.id : undefined,
        cwd: typeof p.cwd === "string" ? p.cwd : undefined,
        branch: typeof p.git?.branch === "string" ? p.git.branch : undefined,
        repository: typeof p.git?.repository_url === "string" ? repoIdFromRemote(p.git.repository_url) : undefined,
        createdAt: created && !isNaN(created.getTime()) ? created : undefined,
        skip,
      };
      if (skip) return meta; // nothing else to learn about a thread we won't list
      continue;
    }
    // Title: codex records none, so the first genuine user message stands in.
    if (meta && !meta.title) {
      const msg = codexUserText(e, p);
      if (msg) {
        meta.title = msg.slice(0, 120);
        return meta; // the meta line always precedes this, so we have everything
      }
    }
  }
  return meta;
}

/** The thread uuid trailing a `rollout-<timestamp>-<uuid>.jsonl` filename. */
const CODEX_FILE_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const codexParseCache = new TranscriptCache();

const codexProvider: SessionProvider = {
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

const PROVIDERS = [claudeProvider, copilotProvider, codexProvider];

/** An index of all discovered sessions, queryable by branch. */
export class SessionIndex {
  private byBranch = new Map<string, AgentSession[]>();
  readonly all: AgentSession[] = [];

  static async build(): Promise<SessionIndex> {
    const idx = new SessionIndex();
    const lists = await Promise.all(PROVIDERS.map((p) => p.index()));
    // Dedupe by source:id — the same session can be discovered more than once
    // when a user has symlinked pieces of one profile's store into another (a
    // single `<id>.jsonl`, an `<enc-cwd>/` dir; a symlinked `projects/` or
    // `~/.claude` is already collapsed upstream by dedupeProfiles). A duplicate's
    // filename — hence its id — is necessarily the same, so the id key catches
    // every alias. Which copy survives is decided in preferredDuplicate.
    const byId = new Map<string, AgentSession>();
    for (const list of lists) {
      for (const s of list) {
        const key = `${s.source}:${s.id}`;
        const prev = byId.get(key);
        byId.set(key, prev ? await preferredDuplicate(prev, s) : s);
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
   *
   * `repo` (optional) scopes the match to the item's own repository. It's needed
   * for backends whose item ids are small and collide across repos: a GitHub
   * issue #2 would otherwise match a branch/cwd like `app2` or `v2-fixes`, and a
   * repoA #7 would match an unrelated repoB #7. Pass the item's `owner/repo` slug
   * (or bare repo name) to require the session to live in that repo. ADO ids are
   * globally unique, so it passes null and the match stays unscoped (unchanged).
   *
   * Passing a slug makes this resolve each candidate session's checkout to its
   * own `owner/repo` via `git remote get-url origin` (see sessionInScope) —
   * memoized per repo root, but still a process spawn on the first sighting of
   * a root. Keep it off hot polling paths; the unscoped call never shells out.
   */
  forWorkItem(id: number, repo?: string | null): AgentSession[] {
    const re = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    const scope = repo ? repoScope(repo) : null;
    return this.all.filter((s) => {
      if (scope && !sessionInScope(s, scope)) return false;
      return (s.branch && re.test(s.branch)) || re.test(s.cwd);
    });
  }
}

/**
 * Which of two entries for the SAME session id to keep.
 *
 * Prefer the REALPATH OWNER — the one whose transcript path needs no symlink
 * traversal — so a session symlinked from profile B into profile A is attributed
 * to the profile that actually holds the bytes, and `CLAUDE_CONFIG_DIR` on resume
 * points there. When ownership can't decide it (neither owns the path because the
 * profile dir itself is a symlink, or both do because they're genuinely separate
 * files that happen to share an id) fall back to the most-recently-used, which is
 * the pre-existing tie-break.
 *
 * Only reached on an actual collision, so the realpath syscalls cost nothing on
 * the overwhelmingly common no-duplicates path.
 */
async function preferredDuplicate(a: AgentSession, b: AgentSession): Promise<AgentSession> {
  const [aOwns, bOwns] = await Promise.all([ownsLogPath(a), ownsLogPath(b)]);
  if (aOwns !== bOwns) return aOwns ? a : b;
  return b.lastUsed.getTime() > a.lastUsed.getTime() ? b : a;
}

/** Whether a session's transcript path reaches the file without a symlink hop. */
async function ownsLogPath(s: AgentSession): Promise<boolean> {
  if (!s.logPath) return false;
  return (await realpath(s.logPath).catch(() => null)) === s.logPath;
}

// ── Repo scoping for forWorkItem ─────────────────────────────────────────────
// The scope comparison must happen in ONE identity domain. The obvious-looking
// shortcut — compare the wanted repo's bare name against the basename of the
// session's checkout directory — silently mixes two domains: a REMOTE repo name
// and a LOCAL directory name. Those agree only when the clone happens to be
// named after the remote (`owner/web-app` cloned into `~/projects/frontend`, a
// second checkout `~/git/agendo-copy`, or a worktree outside
// `<root>/.claude/worktrees/` that repos.ts resolves to its own dir all break
// it), and even when they do agree the owner is thrown away, so a fork
// (`alice/tool` vs `bob/tool`) still cross-matches. So we resolve BOTH sides to
// `owner/repo` slugs via the `origin` remote whenever we can, and only fall back
// to bare-name comparison when a side has no resolvable GitHub slug.

/** A repo identifier reduced to both comparison forms: the full lowercased
 *  `owner/repo` slug (null when the caller passed a bare name) and the bare
 *  lowercased repo name (always present, used as the fallback domain). */
interface RepoScope {
  slug: string | null;
  bare: string;
}

function repoScope(repo: string): RepoScope {
  const r = repo.trim().toLowerCase();
  return { slug: r.includes("/") ? r : null, bare: bareRepoName(r) };
}

/** Reduce a repo identifier (an `owner/repo` slug or a bare name) to its bare,
 *  lowercased repo name, for repo-scoped matching. */
function bareRepoName(repo: string): string {
  return (repo.includes("/") ? repo.split("/").pop()! : repo).toLowerCase();
}

// Repo root → lowercased `owner/repo` slug (or null when the root has no
// resolvable github.com origin). Mirrors repoRef()'s cache in github.ts and
// exists for the same reason, only more acutely: forWorkItem runs once per work
// item inside loadModel and walks EVERY indexed session, so without memoization
// a single refresh would re-spawn `git` hundreds of times. A repo root's origin
// doesn't move under us during a process lifetime, so a plain unbounded Map
// keyed by root (not by cwd — worktrees of one repo share a root) is enough.
// NOTE: nothing on the fast paths (SessionIndex.build, loadLocalSessions) may
// reach this. The two entry points are the repo-scoped forWorkItem call and
// `repoScopeFilter` (the CLI's `--repo` selector) — and both only get here when
// the WANTED repo is a full `owner/repo` slug, so the common bare-name case
// still costs no process spawn at all.
const rootSlugCache = new Map<string, string | null>();

function repoSlugForRoot(root: string): string | null {
  const cached = rootSlugCache.get(root);
  if (cached !== undefined) return cached;
  let slug: string | null = null;
  // existsSync first: we routinely index sessions whose cwd is long gone
  // (deleted worktrees, moved checkouts), and `git -C <missing>` would cost a
  // doomed process spawn each. A missing root simply has no slug → fallback.
  if (existsSync(root)) {
    const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
    if (r.status === 0) {
      const parsed = parseGithubRemote(r.stdout);
      if (parsed) slug = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    }
  }
  rootSlugCache.set(root, slug);
  return slug;
}

// One candidate identity (the session's checkout, or the recorded `repository`
// of a Copilot/Codex session) against the wanted scope: full slugs when BOTH sides have one,
// bare names otherwise. Comparing slugs is what rejects same-named forks;
// falling back to bare names is what keeps non-GitHub, remote-less, and
// no-longer-on-disk checkouts matching at all.
function identityMatches(scope: RepoScope, slug: string | null, bare: string): boolean {
  return scope.slug && slug ? slug === scope.slug : bare === scope.bare;
}

/**
 * The reusable form of the match below, for the CLI's `--repo` selector
 * (`agendo list/status/wait --repo <name>`): parse the wanted repo ONCE and hand
 * back a predicate. Sharing it with `forWorkItem` is the point — a `--repo` that
 * disagreed with the work-item↔session join about which sessions live in a repo
 * would be its own bug class.
 *
 * `repo` is a bare name or an `owner/repo` slug; the slug form makes this shell
 * out to `git remote get-url origin` once per repo root (memoized), so prefer
 * the bare name on hot paths.
 */
export function repoScopeFilter(repo: string): (s: AgentSession) => boolean {
  const scope = repoScope(repo);
  return (s) => sessionInScope(s, scope);
}

/** Whether a session belongs to the wanted repo, for the repo-scoped
 *  work-item↔session join. */
function sessionInScope(s: AgentSession, scope: RepoScope): boolean {
  const root = repoRootForCwd(s.cwd);
  // Only shell out when the wanted repo is a full slug: against a bare wanted
  // name there is no owner to compare, so the resolution could not change the
  // answer and the git call would be pure waste.
  const rootSlug = scope.slug ? repoSlugForRoot(root) : null;
  if (identityMatches(scope, rootSlug, basename(root).toLowerCase())) return true;
  // Copilot and Codex record the remote repo they were launched against, already
  // reduced to the remote domain — no git call needed, and it's the only signal
  // for such a session whose cwd no longer exists.
  if (s.repository) {
    const recorded = s.repository.trim().toLowerCase();
    const slug = recorded.includes("/") ? recorded : null;
    if (identityMatches(scope, slug, bareRepoName(recorded))) return true;
  }
  return false;
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
