// Path-scoped launcher "contexts". A launcher can be scoped to a path so its
// TUI (and `clops list`) only surface sessions under that path, and its agent
// windows live in their own tmux host session — letting several launchers run
// in parallel without stepping on each other. A bare `clops` (no path) is the
// global launcher, byte-identical to the pre-context behavior.
//
// These are pure functions (no tmux / fs), so the path→(filterRoot, hostSession)
// resolution and the segment-aware prefix match are unit-testable in isolation.
import { basename, resolve } from "path";
import { LAUNCHER_SESSION } from "./tmux.ts";

export interface LauncherContext {
  /**
   * Absolute path the launcher is scoped to; `null` for the global launcher
   * (bare `clops`). Drives which sessions the TUI / `clops list` show.
   */
  filterRoot: string | null;
  /**
   * tmux session the menu runs in — so any agent window it opens (an inside-tmux
   * `new-window`) lands there, and parallel launchers stay isolated. Defaults to
   * the canonical `clops` session for the global launcher.
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
 * Resolve a launcher context from the optional `[path]` positional, the process
 * cwd, and an optional `-s/--session` override.
 *
 *  - No path → the global launcher (`filterRoot: null`). A bare `-s <name>`
 *    still names the host session (a named global launcher).
 *  - A path → `filterRoot` is the absolute resolved path; the host session is
 *    the `-s` override, else the sanitized basename, else `clops`.
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
  const hostSession = override || tmuxSafeName(basename(filterRoot)) || LAUNCHER_SESSION;
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
