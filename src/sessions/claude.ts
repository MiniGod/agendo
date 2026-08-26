import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { parseJsonLine } from "../errors.ts";
import { rebaseWorkflowPaths, WorkflowScan } from "../workflows.ts";
import type { AgentSession, WorkflowRef } from "../types.ts";
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

export const claudeProvider: SessionProvider = {
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
