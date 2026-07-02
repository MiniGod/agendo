// Path-scoped launcher "contexts". A launcher can be scoped to a path so its
// TUI (and `agendo list`) only surface sessions under that path, and its agent
// windows live in their own tmux host session — letting several launchers run
// in parallel without stepping on each other. A bare `agendo` (no path) is the
// global launcher, byte-identical to the pre-context behavior.
//
// These are pure functions (no tmux / fs), so the path→(filterRoot, hostSession)
// resolution and the segment-aware prefix match are unit-testable in isolation.
import { basename, resolve } from "path";
import { LAUNCHER_SESSION } from "./tmux.ts";

export interface LauncherContext {
  /**
   * Absolute path the launcher is scoped to; `null` for the global launcher
   * (bare `agendo`). Drives which sessions the TUI / `agendo list` show.
   */
  filterRoot: string | null;
  /**
   * tmux session the menu runs in — so any agent window it opens (an inside-tmux
   * `new-window`) lands there, and parallel launchers stay isolated. Defaults to
   * the canonical `agendo` session for the global launcher.
   */
  hostSession: string;
}

/**
 * Make a string safe to use as a tmux session name: tmux forbids `.` and `:` in
 * session names, and whitespace is awkward, so collapse those to `-` and trim
 * stray leading/trailing dashes. Returns "" if nothing usable remains (callers
 * fall back to the default session name).
 */
export function tmuxSafeName(s: string): string {
  return s.replace(/[.:\s]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Namespace prefix for path-context host sessions. Agendo-managed launcher
 * sessions are named `agendo-<context>` (e.g. `~/work` → `agendo-work`) so they
 * are clearly ours and don't collide with the user's own tmux sessions. Derived
 * from `LAUNCHER_SESSION` so the two stay in sync. The global launcher keeps the
 * bare `agendo` name, and an explicit `-s` override is honored verbatim.
 */
export const HOST_SESSION_PREFIX = `${LAUNCHER_SESSION}-`;

/**
 * Resolve a launcher context from the optional `[path]` positional, the process
 * cwd, and an optional `-s/--session` override.
 *
 *  - No path → the global launcher (`filterRoot: null`). A bare `-s <name>`
 *    still names the host session (a named global launcher).
 *  - A path → `filterRoot` is the absolute resolved path; the host session is
 *    the `-s` override (verbatim), else `agendo-<sanitized basename>`, else
 *    `agendo` (e.g. root `/`, whose basename sanitizes to nothing).
 */
export function resolveContext(
  pathArg: string | undefined,
  cwd: string,
  sessionOverride?: string,
): LauncherContext {
  const override = sessionOverride ? tmuxSafeName(sessionOverride) : "";
  if (pathArg === undefined || pathArg === "") {
    return { filterRoot: null, hostSession: override || LAUNCHER_SESSION };
  }
  const filterRoot = resolve(cwd, pathArg);
  const base = tmuxSafeName(basename(filterRoot));
  const hostSession = override || (base ? `${HOST_SESSION_PREFIX}${base}` : LAUNCHER_SESSION);
  return { filterRoot, hostSession };
}

/**
 * Whether `cwd` is `root` itself or nested under it. Segment-aware after
 * trailing-slash normalization, so `~/work` does NOT match `~/workshop` (a plain
 * `startsWith` would). `root === "/"` matches every absolute path.
 */
export function isUnderRoot(cwd: string, root: string): boolean {
  const a = cwd.replace(/\/+$/, "") || "/";
  const b = root.replace(/\/+$/, "") || "/";
  if (a === b) return true;
  if (b === "/") return a.startsWith("/");
  return a.startsWith(b + "/");
}
