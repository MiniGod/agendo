// Reading the tmux server: which sessions, windows and managed targets are live,
// and the session-scoped options the launcher stores on them. Queries only —
// everything that CHANGES the server lives in `windows.ts`.
import { spawnSync } from "child_process";
import { tmuxLines, tmuxQuiet } from "./exec.ts";
import { ID_BEARING_NAME, PLACEHOLDER_OPTION, ROOT_OPTION, insideTmux, type LiveTarget, type ManagedTarget } from "./names.ts";

/**
 * A live managed target whose name embeds this session short id under any
 * id-bearing kind prefix (`cl-claude-`, `cl-copilot-`, `cl-codex-`, `cl-bg-`,
 * `cl-new-`) — so attach can navigate to the *actual* window a session runs in,
 * whatever name it was launched under, instead of creating a duplicate.
 * Work-item / PR targets embed an item id rather than a session id, and tagged
 * id-less fresh names carry no session id at all, so both are excluded.
 */
export function liveTargetForShortId(sid: string): LiveTarget | null {
  for (const [name, target] of liveTargets()) {
    const m = name.match(ID_BEARING_NAME);
    if (m && m[1] === sid) return { name, target };
  }
  return null;
}


/** Names of all currently live tmux sessions (empty if no server running). */
export function liveSessions(): Set<string> {
  return new Set(tmuxLines(["list-sessions", "-F", "#{session_name}"]));
}

/**
 * Every live window across all sessions, bare name → addressable target (#39).
 *
 * tmux allows duplicate window names and this launcher creates them BY DESIGN: a
 * restored-but-unopened placeholder tab carries the canonical `cl-…` name in one
 * host while the real agent window runs under it in another. So a name can have
 * several locations, and they are not interchangeable — a placeholder is an idle
 * bash waiting on a keypress (see restore.ts), not the session's pane.
 *
 * A REAL window therefore always wins over a placeholder, whichever order tmux
 * lists them in. Getting this wrong is worse than the bug this function exists to
 * fix: `liveTargetForShortId` feeds `send` and `unblock`, which WRITE to the pane
 * they resolve — pasting a prompt into a placeholder wakes it into a second agent
 * on the same transcript, and `unblock`'s leading Escape closes the tab outright.
 * `reconcileLive` skips placeholders for the same reason; these two must agree.
 *
 * Among several REAL windows of one name the first sighting wins, which is a
 * genuine ambiguity this cannot resolve — `close` is the caller that must not
 * guess, and it enumerates `windowLocations` and refuses instead.
 */
export function liveWindows(): Map<string, string> {
  const out = new Map<string, string>();
  const provisional = new Set<string>(); // names whose target came from a placeholder
  for (const line of tmuxLines([
    "list-windows",
    "-a",
    "-F",
    `#{session_name}\t#{window_name}\t#{?${PLACEHOLDER_OPTION},1,0}`,
  ])) {
    const [session, window, placeholder] = line.split("\t");
    if (!window) continue;
    const isPlaceholder = placeholder === "1";
    // Keep what we have unless this is a real window displacing a placeholder.
    if (out.has(window) && (isPlaceholder || !provisional.has(window))) continue;
    // No session reported is not a case tmux produces, but the fallback is the
    // pre-#39 bare name: still correct for a single host, and never worse.
    out.set(window, session ? windowTarget(session, window) : exactTarget(window));
    if (isPlaceholder) provisional.add(window);
    else provisional.delete(window);
  }
  return out;
}

/**
 * Every live session and window name → the target that addresses it. A session
 * addresses itself; a window needs its host session as qualifier. A session name
 * wins over a window of the same name, as it did when this returned a set.
 */
export function liveTargets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of liveSessions()) out.set(s, exactTarget(s));
  for (const [name, target] of liveWindows()) if (!out.has(name)) out.set(name, target);
  return out;
}

/**
 * Every live managed (`cl-…`) target paired with the working directory of its
 * pane. A pane contributes its session name and/or window name, whichever is a
 * managed target. Used to attribute fresh-launch targets — named after a work
 * item / PR (`cl-wi-…`, `cl-pr-…`) rather than a session id — back to the
 * session actually running in them, so they register as running.
 */
export function liveManagedPaths(): ManagedTarget[] {
  const out: ManagedTarget[] = [];
  for (const line of tmuxLines([
    "list-panes",
    "-a",
    "-F",
    `#{session_name}\t#{window_name}\t#{pane_current_path}\t#{?${PLACEHOLDER_OPTION},1,0}`,
  ])) {
    const [session, window, cwd, placeholder] = line.split("\t");
    if (!cwd) continue;
    // The marker is a *window* option, so it only attributes to the window name
    // (a restored placeholder is always a window); a managed session name is
    // never a placeholder.
    //
    // Each name carries the target that ADDRESSES it alongside it (see
    // `LiveTarget`): a session addresses itself, a window needs its host session
    // as qualifier or it is unreadable from anywhere else (#39).
    for (const [name, isWindow, isPlaceholder] of [
      [session, false, false],
      [window, true, placeholder === "1"],
    ] as const) {
      // Built only for a name we keep: `exactTarget("")` is `=`, which tmux reads
      // as the `{mouse}` target — it would silently address wherever the pointer
      // last was rather than fail.
      if (!name?.startsWith("cl-")) continue;
      const target = isWindow && session ? windowTarget(session, name) : exactTarget(name);
      out.push({ name, target, cwd, placeholder: isPlaceholder });
    }
  }
  return out;
}

/**
 * Force tmux to resolve `-t <name>` by EXACT match only. Without the leading `=`,
 * tmux resolves a target by exact → unique-prefix → fnmatch, so a bare name that
 * is a *prefix* of a longer live name silently binds to the wrong target — our
 * managed names are prefixes of each other (`agendo`⊂`agendo-work`, `cl-pr-5`⊂
 * `cl-pr-50`, `cl-wi-512`⊂`cl-wi-5120`). The `=` prefix (documented tmux target
 * syntax) pins resolution to the literal name, and for a compound `session:window`
 * target it applies to the session portion (the only ambiguous part here).
 */
export function exactTarget(name: string): string {
  return `=${name}`;
}

/**
 * Exact-pinned `session:window` target — the form that addresses a window from
 * any host session, and the one this file hands to `capture-pane`.
 *
 * BOTH halves are pinned: host names are prefixes of each other (`agendo` ⊂
 * `agendo-agendo` ⊂ `agendo-mc-applications`) and so are managed window names
 * (`cl-pr-5` ⊂ `cl-pr-50`), so an unpinned half lets tmux's prefix/fnmatch
 * fallback bind it to the wrong thing — the `exactTarget` hazard, twice over.
 */
export function windowTarget(session: string, window: string): string {
  return `${exactTarget(session)}:${exactTarget(window)}`;
}

export function hasSession(name: string): boolean {
  return spawnSync("tmux", ["has-session", "-t", exactTarget(name)]).status === 0;
}

/** The tmux session the caller is currently inside, or null (outside tmux). */
export function currentSessionName(): string | null {
  if (!insideTmux()) return null;
  const r = spawnSync("tmux", ["display-message", "-p", "#{session_name}"], { encoding: "utf-8" });
  const name = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return name || null;
}

/** The absolute root a launcher host session is scoped to (`@cl_root`), or null. */
export function sessionRoot(session: string): string | null {
  const r = spawnSync("tmux", ["show-options", "-t", exactTarget(session), "-v", ROOT_OPTION], { encoding: "utf-8" });
  const v = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return v || null;
}

/** Record the absolute root a launcher host session is scoped to (`@cl_root`). */
export function setSessionRoot(session: string, root: string): void {
  tmuxQuiet(["set-option", "-t", exactTarget(session), ROOT_OPTION, root]);
}

