// Which rows the cleanup view shows, and where each row's files live. Pure path
// arithmetic over the model's sessions and a directory listing of the managed
// worktrees; unit tested in test/cleanupRows.test.ts.
import { basename, dirname, join } from "path";
import { sessionName } from "../runtime/tmux/names.ts";
import type { AgentSession } from "../shared/types.ts";
import type { CleanupRow, RunState } from "./types.ts";

// `<repoRoot>/.claude/worktrees/<name>`, optionally followed by a path inside it.
// Greedy, so a worktree nested inside another (`x/.claude/worktrees/y`) is
// attributed to the innermost one — the checkout the path is really in.
const MANAGED_RE = /^(.+)\/\.claude\/worktrees\/([^/]+)(?:\/.*)?$/;

/** The agendo-managed worktree a path is in, with its repo root, or null when it is in none. */
export function managedWorktreeOf(path: string): { repoRoot: string; worktree: string } | null {
  const m = path.replace(/\/+$/, "").match(MANAGED_RE);
  if (!m || m[2] === "." || m[2] === "..") return null;
  return { repoRoot: m[1], worktree: `${m[1]}/.claude/worktrees/${m[2]}` };
}

/** The main checkout a session belongs to: its managed worktree's repo, else whatever `repoRootOf` walks up to. */
export function sessionRepoRoot(cwd: string, repoRootOf: (cwd: string) => string): string {
  return managedWorktreeOf(cwd)?.repoRoot ?? repoRootOf(cwd);
}

export function runStateOf(s: AgentSession, live: ReadonlySet<string>, placeholders: ReadonlySet<string>): RunState {
  const name = sessionName(s);
  if (live.has(name)) return "running";
  if (placeholders.has(name)) return "paused";
  return "idle";
}

/** A managed worktree directory found on disk. */
export interface WorktreeDir {
  path: string;
  repoRoot: string;
  mtime: Date;
  birthtime: Date;
}

export interface RowInput {
  sessions: readonly AgentSession[];
  live: ReadonlySet<string>;
  placeholders: ReadonlySet<string>;
  worktrees: readonly WorktreeDir[];
  /** The main checkout of a session that is NOT in a managed worktree. */
  repoRootOf: (cwd: string) => string;
  /** The clock `active` is judged against; rows are never active without it. */
  now?: number;
  /**
   * A path's canonical spelling (its realpath), so a session whose cwd and a
   * scanned worktree differ only by a symlink are recognised as the same place.
   */
  canon?: (path: string) => string;
  /** When a session was last written to, if the disk knows better than `lastUsed` (see `activityPathsOf`). */
  lastWrite?: (s: AgentSession) => Date;
  /**
   * Sessions left out of `sessions` by the launch scope. A worktree one of them
   * lives in is theirs, not an orphan to offer for deletion with no session's
   * activity looked at.
   */
  claimers?: readonly AgentSession[];
}

const same = (p: string) => p;

/** Written to within `ACTIVE_MS` of `now`; never, without a clock. */
const recent = (at: Date, now: number | undefined) => now !== undefined && now - at.getTime() < ACTIVE_MS;

/**
 * How recently a session with no agendo window must have been written to for
 * the view to suspect it is running elsewhere (a plain terminal, an IDE).
 */
export const ACTIVE_MS = 5 * 60_000;

function sessionRow(s: AgentSession, input: RowInput): CleanupRow {
  const cwd = (input.canon ?? same)(s.cwd);
  const managed = managedWorktreeOf(cwd);
  const run = runStateOf(s, input.live, input.placeholders);
  return {
    key: `session:${s.source}:${s.id}`,
    title: s.title || s.id,
    session: s,
    repoRoot: sessionRepoRoot(cwd, input.repoRootOf),
    worktree: managed?.worktree ?? null,
    path: managed?.worktree ?? cwd,
    branchHint: s.branch ?? null,
    updated: s.lastUsed,
    created: s.createdAt ?? s.lastUsed,
    run,
    // Paused too: its agent wrote on the way out, and the run-time check sees that write.
    active: run !== "running" && recent(input.lastWrite?.(s) ?? s.lastUsed, input.now),
  };
}

/**
 * A worktree no known session lives in. It is `active` when its directory
 * changed moments ago: an agent just launched there has no transcript for the
 * model to find yet, and must not lose its checkout unasked.
 */
function worktreeRow(w: WorktreeDir, input: RowInput): CleanupRow {
  const canon = input.canon ?? same;
  const path = canon(w.path);
  return {
    key: `worktree:${path}`,
    title: basename(path),
    session: null,
    repoRoot: canon(w.repoRoot),
    worktree: path,
    path,
    branchHint: null,
    updated: w.mtime,
    created: w.birthtime.getTime() > 0 ? w.birthtime : w.mtime,
    run: "idle",
    active: recent(w.mtime, input.now),
  };
}

/**
 * One row per session, plus one per managed worktree that no session lives in.
 * Activity is shared through the checkout: an agent just started in a plain
 * terminal makes every other session in its worktree `active` too, since
 * cleaning up either takes the same checkout.
 */
export function buildCleanupRows(input: RowInput): CleanupRow[] {
  const rows = input.sessions.map((s) => sessionRow(s, input));
  const canon = input.canon ?? same;
  const outside = (input.claimers ?? []).map((s) => managedWorktreeOf(canon(s.cwd))?.worktree);
  const claimed = new Set([...rows.map((r) => r.worktree), ...outside].filter((w): w is string => !!w));
  for (const w of input.worktrees) {
    const row = worktreeRow(w, input);
    if (claimed.has(row.path)) continue; // a session's, or the same checkout listed under a second spelling
    claimed.add(row.path);
    rows.push(row);
  }
  const busy = new Set(rows.filter((r) => r.active && r.worktree).map((r) => r.worktree));
  return rows.map((r) => (!r.active && r.run !== "running" && busy.has(r.worktree) ? { ...r, active: true } : r));
}

/** The files of every OTHER session in the row's worktree, for the run-time activity check. */
export function sharedActivityPaths(row: CleanupRow, rows: readonly CleanupRow[]): string[] {
  if (!row.worktree) return [];
  return rows.filter((r) => r.key !== row.key && r.worktree === row.worktree && r.session).flatMap((r) => activityPathsOf(r.session as AgentSession));
}

/**
 * Whether something else is running in the row's worktree: another row's
 * running session, or a live agendo pane whose cwd is inside it — which covers
 * an agent just launched there that the model has no session for yet.
 * `paneCwds` must be spelled the way the row's paths are (realpaths).
 */
export function othersRunningIn(row: CleanupRow, rows: readonly CleanupRow[], paneCwds: readonly string[] = []): boolean {
  const wt = row.worktree;
  if (!wt) return false;
  if (paneCwds.some((c) => c === wt || c.startsWith(`${wt}/`))) return true;
  return rows.some((r) => r.key !== row.key && r.worktree === wt && r.run === "running");
}

/**
 * The files whose mtime says when a session was last written to. Copilot's
 * `logPath` is its session DIRECTORY, whose mtime an append to `events.jsonl`
 * never moves, so that file is read too.
 */
export function activityPathsOf(s: AgentSession): string[] {
  if (!s.logPath) return [];
  return s.source === "copilot" ? [s.logPath, join(s.logPath, "events.jsonl")] : [s.logPath];
}

// ── where a session's files live ────────────────────────────────────────────

// Session ids are UUIDs, codex thread ids and copilot dir names; anything with a
// separator or a dot in it is not one, and never reaches a path below.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Claude Code's per-project directory name for a cwd: every non-alphanumeric becomes `-`. */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * The session's transcript files: the log itself, and for Claude the sibling
 * `<id>/` directory holding its subagent transcripts and tool results. Empty
 * unless the log's own name carries the session id — a guard against deleting
 * a path that was attributed to the session but is not its own.
 */
export function transcriptPathsOf(s: AgentSession): string[] {
  if (!s.logPath || !SAFE_ID.test(s.id) || !basename(s.logPath).includes(s.id)) return [];
  if (s.source !== "claude") return [s.logPath];
  return [s.logPath, join(dirname(s.logPath), s.id)];
}

/**
 * Claude Code's scratch directory for the session:
 * `<tmp>/claude-<uid>/<project slug>/<session id>`. Null for the other agents,
 * which keep none, and for an id that is not a plain identifier.
 */
export function tmpDirOf(s: AgentSession, tmpRoot: string, uid: number): string | null {
  if (s.source !== "claude" || !SAFE_ID.test(s.id)) return null;
  return join(tmpRoot, `claude-${uid}`, claudeProjectSlug(s.cwd), s.id);
}
