// Discovers resumable agent sessions on disk and indexes them by branch so the
// UI can answer "what sessions exist for this work item's PR branch?".
//
// Two providers today (Claude Code, Copilot CLI) behind a small interface so
// more agent types can be added later. Both index their on-disk sessions and
// both resume natively (Claude via `claude --resume`, Copilot via
// `copilot --resume=<id>`); see launch.ts:resumeArgv.
import { existsSync } from "fs";
import { readdir, readFile, realpath, stat } from "fs/promises";
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

// Per-transcript parse cache, keyed by absolute .jsonl path. Parsing a Claude
// transcript means reading + JSON-parsing every line of a possibly huge file;
// with the index rebuilt on a short timer that dominated a CPU core across
// hundreds of MB of transcripts. Since a transcript only gains records by being
// appended to (mtime AND size move together on any change), reusing the built
// AgentSession while both match is pure memoization — build() output stays
// byte-for-byte identical for a given on-disk state. The one actively-appending
// transcript (the foreground session's own log) still re-parses every build
// because its mtime/size change each tick; that's one file, not the whole
// corpus. Incremental tail-by-offset reading of that growing file is a possible
// future follow-up, not done here.
const claudeParseCache = new Map<string, { mtimeMs: number; size: number; session: AgentSession }>();

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
/** Test-only: current number of cached transcript entries (to prove pruning). */
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
                const cached = claudeParseCache.get(filePath);
                if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
                  sessions.push(cached.session);
                  return;
                }
                claudeParseCount++; // cache miss: this file is actually read+parsed
                const meta = await parseClaudeMeta(filePath);
                if (!meta?.cwd) return;
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
                claudeParseCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, session });
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
    for (const path of claudeParseCache.keys()) {
      if (!seen.has(path)) claudeParseCache.delete(path);
    }
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

const PROVIDERS = [claudeProvider, copilotProvider];

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

// One candidate identity (the session's checkout, or Copilot's recorded
// `repository`) against the wanted scope: full slugs when BOTH sides have one,
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
  // Copilot records the remote repo it was launched against, which is already in
  // the remote domain — no git call needed, and it's the only signal for a
  // Copilot session whose cwd no longer exists.
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
