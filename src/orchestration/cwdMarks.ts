// Orchestrator marking for agents that assign their OWN session id (Codex today
// — see `preassignsSessionId`). `launchManaged` mints a uniquifier for the tmux
// window before the agent process exists, but Codex's real, resumable id is only
// discoverable afterward, from its rollout file — so there is nothing to hand
// `markOrchestratorSession` at the moment orchestrator mode is decided.
//
// The launcher already attributes an id-less Codex window back to its session by
// working directory rather than by id (`kindName`'s `tag` parameter, and see
// `ID_BEARING_NAME`'s comment) — so orchestrator mode rides the same route here.
// A repo orchestrator's cwd is the repo's own MAIN checkout, which no ordinary
// background session ever runs in (`resolveLaunchCwd`); a global orchestrator's
// is the vantage directory `globalOrchestratorCwd` picks. Neither collides with
// anything else the launcher starts, so the key is safe to reuse across restarts.
import { join } from "path";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "fs";
import { STATE_DIR } from "../app/config.ts";
import type { OrchestratorRole } from "./role.ts";

const CWD_MARKS_PATH = join(STATE_DIR, "orchestratorCwds.json");

/** Parse the marker file, tolerating a missing/hand-edited/truncated one. */
function loadCwdMarks(): Record<string, OrchestratorRole> {
  if (!existsSync(CWD_MARKS_PATH)) return {};
  try {
    const data = JSON.parse(readFileSync(CWD_MARKS_PATH, "utf-8"));
    const out: Record<string, OrchestratorRole> = {};
    if (!data?.cwds || typeof data.cwds !== "object") return out;
    for (const [cwd, role] of Object.entries(data.cwds as Record<string, unknown>)) {
      if (role === "repo" || role === "global") out[cwd] = role;
    }
    return out;
  } catch {
    return {};
  }
}

/** See `markOrchestratorSession`'s note on why a temp-file rename is used. */
function writeAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

/**
 * Remember that a session running in `cwd` is an orchestrator of `role`, so a
 * cold resume can re-inject the instructions once the real session id is known
 * (see `orchestratorRoleOfCwd`, consulted from `resumeArgv`'s Codex branch via an
 * `AgentSession`'s own `cwd`). Best-effort, like its id-keyed sibling: a failed
 * write costs the orchestrator framing on a later resume, never the launch.
 */
export function markOrchestratorCwd(cwd: string, role: OrchestratorRole): void {
  try {
    const marks = loadCwdMarks();
    marks[cwd] = role;
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeAtomic(CWD_MARKS_PATH, { cwds: marks });
  } catch {
    // Persisting the marker is best-effort; ignore write failures.
  }
}

/**
 * Forget that `cwd` hosts an orchestrator. Unlike the id-keyed marks — an id is
 * never reused, so a stale entry there is merely dead weight — a cwd IS reused:
 * a repo's main checkout hosts an orchestrator today and an ordinary
 * `--no-worktree` session tomorrow. Called from `launchManaged` on every
 * ORDINARY Codex launch (one with no `orchestrator` role) whose cwd has nothing
 * LIVE in it right now, so that session's cold resume can't inherit a previous,
 * no-longer-running orchestrator's instructions from the same directory. The
 * liveness check at the call site is what keeps this from also wiping a
 * CURRENTLY RUNNING orchestrator's own mark — its cwd is a directory a user can
 * `cd` into and launch an ordinary session in without stopping it first (see the
 * call site for why only the id-less Codex path needs this at all).
 */
export function clearOrchestratorCwd(cwd: string): void {
  try {
    const marks = loadCwdMarks();
    if (!(cwd in marks)) return;
    delete marks[cwd];
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeAtomic(CWD_MARKS_PATH, { cwds: marks });
  } catch {
    // Best-effort, like markOrchestratorCwd: a failed write leaves a stale mark
    // in place, same risk as never having called this at all.
  }
}

/** Which level the orchestrator running in `cwd` was launched at, or null. */
export function orchestratorRoleOfCwd(cwd: string): OrchestratorRole | null {
  return loadCwdMarks()[cwd] ?? null;
}

/** Every remembered cwd → its orchestrator level, in one read of the marker file. */
export function orchestratorCwdRoles(): Map<string, OrchestratorRole> {
  return new Map(Object.entries(loadCwdMarks()));
}
