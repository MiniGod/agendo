// Reading the tmux server: which sessions, windows and managed targets are live,
// and the session-scoped options the launcher stores on them. Queries only —
// everything that CHANGES the server lives in `windows.ts`.
import { spawnSync } from "child_process";
import { tmuxLines } from "./exec.ts";
import {
  ID_BEARING_NAME, PANE_TARGET_OPTION, PLACEHOLDER_OPTION, ROOT_OPTION,
  insideTmux, isPaneHosted, type LiveTarget, type ManagedTarget,
} from "./names.ts";

/**
 * A live managed target whose name embeds this session short id under any
 * id-bearing kind prefix (`cl-claude-`, `cl-copilot-`, `cl-codex-`, `cl-bg-`,
 * `cl-new-`) — so attach can navigate to the *actual* window a session runs in,
 * whatever name it was launched under, instead of creating a duplicate.
 * Work-item / PR targets embed an item id rather than a session id, and tagged
 * id-less fresh names carry no session id at all, so both are excluded.
 *
 * Window/session names are checked first — the overwhelmingly common case, and
 * two cheap tmux reads. Only then do we look for a PANE-hosted session, whose
 * managed name lives in a pane option rather than on any window (see
 * `PANE_TARGET_OPTION`); that costs a third read, so it stays the fallback.
 */
export function liveTargetForShortId(sid: string): LiveTarget | null {
  for (const [name, target] of liveTargets()) {
    const m = name.match(ID_BEARING_NAME);
    if (m && m[1] === sid) return { name, target };
  }
  for (const p of liveManagedPaths()) {
    if (!isPaneHosted(p)) continue;
    const m = p.name.match(ID_BEARING_NAME);
    if (m && m[1] === sid) return { name: p.name, target: p.target };
  }
  return null;
}

/** The pane id hosting managed target `name`, or null if no pane does. */
export function paneLocation(name: string): string | null {
  for (const p of liveManagedPaths()) if (isPaneHosted(p) && p.name === name) return p.target;
  return null;
}

/**
 * Width in columns of the pane a `split-window -t <target>` would actually cut in
 * two, or null if it can't be read. Used to decide whether the halves would be
 * usable.
 *
 * `#{pane_width}`, not `#{window_width}`: tmux splits a window's ACTIVE PANE, not
 * the window, so a menu window the user has already split by hand is 200 columns
 * wide while the pane about to be halved is 100. Measuring the window there would
 * pass the check and hand the new agent 50 columns.
 */
export function splitTargetWidth(target: string): number | null {
  const r = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{pane_width}"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const n = Number((r.stdout ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
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
 * managed target — plus, for a session the launcher parked in someone else's
 * window, the name stamped on the pane itself (see `PANE_TARGET_OPTION`). Used to
 * attribute fresh-launch targets — named after a work item / PR (`cl-wi-…`,
 * `cl-pr-…`) rather than a session id — back to the session actually running in
 * them, so they register as running.
 */
export function liveManagedPaths(): ManagedTarget[] {
  const out: ManagedTarget[] = [];
  for (const line of tmuxLines([
    "list-panes",
    "-a",
    "-F",
    `#{session_name}\t#{window_name}\t#{pane_current_path}\t#{?${PLACEHOLDER_OPTION},1,0}\t#{pane_id}\t#{${PANE_TARGET_OPTION}}`,
  ])) {
    const [session, window, cwd, placeholder, paneId, paneTarget] = line.split("\t");
    if (!cwd) continue;
    // A pane-hosted session: its managed name is on the PANE, and the pane id is
    // how everything downstream (capture, send-keys, navigate) reaches it — no
    // `exactTarget` pin needed, since `%N` cannot be a prefix of another target.
    // Never a placeholder: restore recreates windows, never panes.
    if (paneTarget?.startsWith("cl-") && paneId) {
      out.push({ name: paneTarget, target: paneId, cwd, placeholder: false });
    }
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

/**
 * Exact-pinned target for the SESSION OPTION commands — `=<name>:`, with a
 * trailing colon.
 *
 * `show-options`/`set-option` take a target-PANE, not a target-session, and a
 * bare `=name` is not valid target-pane syntax: tmux rejects it outright with
 * `no such session: =name` and exit 1. `has-session` takes a target-session and
 * accepts the same string happily, which is why this went unnoticed — the guard
 * in src/index.tsx could confirm a host session existed and then never manage to
 * read or write its `@cl_root`.
 *
 * The colon is what makes it parse: `=name:` is a pane target naming the current
 * pane of exactly-session `name`, so resolution stays pinned to the literal
 * name. That matters as much here as anywhere else — host names are prefixes of
 * each other (`agendo` ⊂ `agendo-work`), and dropping the pin would let
 * `sessionRoot("agendo")` answer with `agendo-work`'s root when only the longer
 * one is live, reporting a collision between a session and itself.
 *
 * Verified against tmux 3.4:
 *
 *     set-option  -t 'work'    @cl_root /a   → exit 0
 *     set-option  -t '=work'   @cl_root /a   → exit 1, "no such session: =work"
 *     set-option  -t '=work:'  @cl_root /a   → exit 0
 *     show-options -t '=work:' -v @cl_root   → "/a", and never a sibling's value
 */
export function sessionOptionTarget(session: string): string {
  return `${exactTarget(session)}:`;
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

/**
 * The absolute root a launcher host session is scoped to (`@cl_root`), or null.
 *
 * Null covers three different things on purpose, because the caller treats them
 * alike: no such session, a session that never recorded a root (a bare `agendo`
 * doesn't), and an unset option — tmux answers that last one with exit 1 and
 * `invalid option: @cl_root` rather than an empty string.
 */
export function sessionRoot(session: string): string | null {
  const r = spawnSync("tmux", ["show-options", "-t", sessionOptionTarget(session), "-v", ROOT_OPTION], {
    encoding: "utf-8",
  });
  const v = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return v || null;
}

/**
 * Record the absolute root a launcher host session is scoped to (`@cl_root`).
 * Returns whether tmux accepted it.
 *
 * Deliberately NOT routed through `tmuxQuiet`. This call exists only for its
 * side effect, and its side effect is the entire basis of the collision guard:
 * if the write is dropped, `sessionRoot` returns null forever after and the
 * guard silently never fires again for that session. `tmuxQuiet` discards the
 * exit status, which is exactly how the `=name` bug above survived unnoticed —
 * every write failed and nothing anywhere said so. A caller that depends on the
 * write landing should be able to find out that it didn't.
 */
export function setSessionRoot(session: string, root: string): boolean {
  const r = spawnSync("tmux", ["set-option", "-t", sessionOptionTarget(session), ROOT_OPTION, root], {
    stdio: "ignore",
  });
  return r.status === 0;
}

