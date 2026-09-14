// Changing the tmux server: killing windows and sessions, and creating them.
// The one module here with side effects beyond a keystroke, which is why every
// kill in it is exact-targeted. Bootstrapping the launcher host session itself
// (and keeping its menu window at index 0) is `launcherSession.ts`, which
// composes this module's primitives.
import { spawnSync } from "child_process";
import { tmuxLines, tmuxQuiet } from "./exec.ts";
import { LAUNCHER_SESSION, PANE_TARGET_OPTION, PLACEHOLDER_OPTION, isPaneTarget } from "./names.ts";
import { exactTarget, hasSession, liveSessions, liveTargets, paneLocation } from "./server.ts";

/**
 * Kill the window/target `name` (no-op if it doesn't exist). Used to clear a
 * dormant restore placeholder before a headless resume recreates it for real,
 * and by `agendo close` to end a managed session's window.
 *
 * EXACT-targeted (see `exactTarget`): a bare `-t <name>` resolves by exact →
 * unique-prefix → fnmatch, so killing `cl-pr-5` while `cl-pr-50` is the only
 * live match would destroy the WRONG session's window. Every kill in this file
 * pins its target with the leading `=` for that reason.
 *
 * A managed agent runs as either a window in a host session or a session of its
 * own (see the file header); `kill-window` covers both, since tmux resolves a
 * bare session name to that session's current window — and a managed session has
 * exactly the one. Nothing outside tmux is touched: the agent's git worktree,
 * branch and commits are left on disk.
 */
export function killWindow(target: string): void {
  tmuxQuiet(["kill-window", "-t", exactKillTarget(target)]);
}

/**
 * Pin a kill target to an exact match on BOTH halves of a `session:window` ref
 * (or on a bare name).
 *
 * The `=` prefix is PER-COMPONENT: `=host:name` pins only the session, and
 * blindly prefixing the whole string instead yields `==host:name` — a session
 * literally named `=host`, which matches nothing. Under `tmuxQuiet` that
 * mismatch is silent, so callers passing an already-pinned session (see
 * `refreshPlaceholder`) would kill nothing and never hear about it. Both halves
 * are therefore normalized before being re-pinned.
 *
 * A numeric window half is left bare on purpose: `man tmux` looks a window up as
 * an INDEX before a name, so `=3` would ask for a window whose name is "3"
 * rather than window 3 — and `session:index` is exactly what `killManagedTarget`
 * resolves its target to.
 */
function exactKillTarget(target: string): string {
  const colon = target.indexOf(":");
  const unpin = (s: string) => (s.startsWith("=") ? s.slice(1) : s);
  if (colon === -1) return exactTarget(unpin(target));
  const session = unpin(target.slice(0, colon));
  const window = unpin(target.slice(colon + 1));
  return `${exactTarget(session)}:${/^\d+$/.test(window) ? window : exactTarget(window)}`;
}

/** Kill the tmux SESSION `name` outright (exact-targeted; no-op if absent). */
export function killSession(name: string): void {
  tmuxQuiet(["kill-session", "-t", exactTarget(name)]);
}

/**
 * End a session that lives in a PANE of somebody else's window (see
 * `PANE_TARGET_OPTION`) and report whether it is actually gone.
 *
 * `kill-window` is wrong here and would be destructive: the window belongs to
 * the launcher's menu, and the pane is only a lodger in it. A pane id needs no
 * `=` pin — `%12` cannot be a prefix of another target — but the post-check
 * still matters for the same reason every kill in this file has one: `tmuxQuiet`
 * throws the exit status away, so "we asked" is not "it's gone".
 */
export function killPane(pane: string, name: string): boolean {
  tmuxQuiet(["kill-pane", "-t", pane]);
  return paneLocation(name) === null;
}

/**
 * End a live managed target — the window it names, or the whole session when the
 * name IS a session of its own (how an agent launched outside tmux runs). Backs
 * `agendo close`. Reports how it addressed the target and whether tmux still
 * lists the name afterwards.
 *
 * ADDRESSING is the subtle part. `man tmux`: a target-window is `session:window`
 * and "if a session is omitted, the current session is used if available; if no
 * current session is available, the most recently used is chosen". So a bare
 * window name is looked up inside ONE session — whichever the caller happens to
 * be in, or an arbitrary one when the CLI runs outside tmux — and a launcher tab
 * addressed from anywhere else simply isn't found. `tmuxQuiet` throws the exit
 * status away, so that failure would be invisible. We therefore resolve the
 * window to its unambiguous `session:index` location first (`windowLocation`)
 * and target that; a target with no such window is a session and is killed as
 * one. Both forms are `=`-pinned (see `exactTarget`), which drops tmux's
 * prefix/fnmatch fallback — the one that would bind `cl-pr-5` to `cl-pr-50` if
 * the exact target died between the listing and this call.
 *
 * `location` defaults to the lookup and is accepted explicitly so a caller that
 * already resolved it (to READ the same pane, which needs the identical
 * unambiguous target) can prove both operations addressed one window.
 *
 * The post-check is deliberate: every write here goes through `tmuxQuiet`, so
 * "we asked" is not "it's gone" — callers report what actually happened rather
 * than assuming success. Nothing outside tmux is touched either way: the agent's
 * git worktree, branch and commits stay on disk.
 */
export function killManagedTarget(
  name: string,
  location: string | null = windowLocation(name),
): { how: "window" | "session" | "moved" | "none"; gone: boolean } {
  if (location) {
    // Re-read the name at that location first. A window index is not a stable
    // handle: with `renumber-windows on` (a common setting) every index above a
    // closing window shifts down, and an agent tab exiting on its own is routine
    // here — so between the lookup and this call `agendo:3` can come to mean a
    // different window, up to and including the launcher's own menu. Cheap
    // re-check, and it closes the only gap where this command could hit a window
    // nobody asked it to.
    if (windowNameAt(location) !== name) return { how: "moved", gone: false };
    // Confirm by COUNT, not by whether the location string still appears. The
    // same renumbering the check above guards against can move a surviving window
    // off `agendo:3` — so "the location no longer holds it" is satisfied by a
    // kill that failed while some other window happened to close alongside it,
    // and we would print "closed" over a live agent. One fewer window carrying
    // the name is the only evidence that stays true under renumbering.
    const before = windowLocations(name).length;
    killWindow(location);
    return { how: "window", gone: windowLocations(name).length < before };
  }
  if (liveSessions().has(name)) {
    killSession(name);
    return { how: "session", gone: !liveSessions().has(name) };
  }
  return { how: "none", gone: !liveTargets().has(name) };
}

/** The window name currently at a `session:index` location, or null. */
function windowNameAt(location: string): string | null {
  const r = spawnSync("tmux", ["display-message", "-p", "-t", exactTarget(location), "#{window_name}"], {
    encoding: "utf-8",
  });
  const name = r.status === 0 ? (r.stdout ?? "").trim() : "";
  return name || null;
}

/**
 * Live windows of a launcher host session, each paired with the working
 * directory of its active pane. Dead windows (a `remain-on-exit` corpse) are
 * skipped. Empty if the session isn't running. Used to snapshot the open agent
 * tabs for browser-style restore (see restore.ts).
 */
export function launcherWindowPaths(session: string = LAUNCHER_SESSION): { name: string; cwd: string }[] {
  const out: { name: string; cwd: string }[] = [];
  for (const line of tmuxLines([
    "list-windows",
    "-t",
    exactTarget(session),
    "-F",
    "#{window_name}\t#{pane_current_path}\t#{pane_dead}",
  ])) {
    const [name, cwd, dead] = line.split("\t");
    if (dead === "1" || !cwd) continue;
    out.push({ name, cwd });
  }
  return out;
}

/**
 * Whether `name` is a live, still-unopened restore PLACEHOLDER window in
 * `session` — an idle bash awaiting a keypress, not a running agent.
 *
 * Existence and the `@cl_placeholder` flag come from ONE query scoped to that
 * host session, deliberately: the same canonical window name can exist in two
 * host sessions (one session tabbed in two path-scoped launchers), so reading the
 * flag from a global window list could authorize an action against a window whose
 * own flag has since been cleared — i.e. one the user is now working in. A dead
 * window (a `remain-on-exit` corpse) is never a placeholder.
 */
export function isPlaceholderWindow(session: string, name: string): boolean {
  for (const line of tmuxLines([
    "list-windows",
    "-t",
    exactTarget(session),
    "-F",
    `#{window_name}\t#{?${PLACEHOLDER_OPTION},1,0}\t#{pane_dead}`,
  ])) {
    const [wname, placeholder, dead] = line.split("\t");
    if (wname === name) return placeholder === "1" && dead !== "1";
  }
  return false;
}

/**
 * `session:window_index` of EVERY live window named `name`, across all sessions.
 * tmux allows duplicate window names, and this launcher creates them — two host
 * sessions (the global `agendo` and a path-scoped one) can each hold a tab for
 * the same session, the same collision `isPlaceholderWindow` above scopes around.
 * So a caller that is about to do something destructive has to see all of them,
 * not just the first (see `windowLocation`).
 */
export function windowLocations(name: string): string[] {
  const out: string[] = [];
  for (const line of tmuxLines(["list-windows", "-a", "-F", "#{session_name}:#{window_index}\t#{window_name}"])) {
    const [loc, wname] = line.split("\t");
    if (wname === name) out.push(loc);
  }
  return out;
}

/** `session:window_index` of the first window named `name`, or null. */
export function windowLocation(name: string): string | null {
  return windowLocations(name)[0] ?? null;
}

/**
 * Create a detached tmux session named `name` running `argv` in `cwd`.
 * No-op if it already exists. Used when the launcher runs outside tmux.
 */
export function newDetached(name: string, cwd: string, argv: string[]): void {
  if (hasSession(name)) return;
  spawnSync("tmux", ["new-session", "-d", "-s", name, "-c", cwd, "--", ...argv], { stdio: "inherit" });
}

/**
 * Flag a window as an unloaded restore placeholder via the `@cl_placeholder`
 * window option (see PLACEHOLDER_OPTION). `target` is a `session:window` ref.
 */
export function markPlaceholder(target: string): void {
  tmuxQuiet(["set-option", "-w", "-t", target, PLACEHOLDER_OPTION, "1"]);
}

/**
 * Pin a window's name so neither tmux nor the program inside can rename it.
 * Exported for `launcherSession.ts`, which composes it rather than duplicating
 * it (see that file's header for why the two are split).
 */
export function pinName(target: string): void {
  tmuxQuiet(["set-window-option", "-t", target, "automatic-rename", "off"]);
  tmuxQuiet(["set-window-option", "-t", target, "allow-rename", "off"]);
}

/**
 * Create a detached window named `name` in the current session running `argv`
 * in `cwd`, and pin its name (disable tmux's automatic/program renaming) so the
 * launcher can still recognize it later. Used when running inside tmux.
 */
export function newWindow(name: string, cwd: string, argv: string[]): void {
  tmuxQuiet(["new-window", "-d", "-n", name, "-c", cwd, "--", ...argv]);
  pinName(name);
}

/**
 * Split window `target` and run `argv` in the new pane, stamping it with the
 * managed name `name` so the launcher can find the session again (see
 * `PANE_TARGET_OPTION`). Returns the new pane id, or null if tmux refused —
 * typically "no space for new pane", which callers treat as "open a window
 * instead" rather than as an error.
 *
 * `-h` splits left|right (side by side, the whole point of the exercise) and `-d`
 * leaves the focus where it is, so the menu keeps the keyboard while the agent
 * boots next to it. `-P -F #{pane_id}` prints the pane id we then address it by.
 *
 * Not routed through `tmuxQuiet`, unlike its `newWindow` neighbour: the pane id
 * IS the result here, so both the exit status and stdout are load-bearing.
 */
export function splitPaneIn(target: string, name: string, cwd: string, argv: string[]): string | null {
  const r = spawnSync(
    "tmux",
    ["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "-t", target, "-c", cwd, "--", ...argv],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return null;
  const pane = (r.stdout ?? "").trim();
  // A pane we can't address is worse than no pane: the agent would be running
  // where nothing can find it. Report failure and let the caller open a window.
  if (!isPaneTarget(pane)) return null;
  // The stamp is what makes the pane DISCOVERABLE: without it the agent runs in a
  // pane no listing attributes to it, so `list`, `send`, `status`, `close` and
  // even the duplicate guard in `openTarget` all miss it — and the next launch
  // starts a rival beside it. A pane we cannot name is worse than no pane, so the
  // status is checked (not thrown away by `tmuxQuiet`) and a failed stamp takes
  // the pane back down, leaving the caller to open a window instead.
  const stamped = spawnSync("tmux", ["set-option", "-p", "-t", pane, PANE_TARGET_OPTION, name], { stdio: "ignore" });
  if (stamped.status !== 0) {
    tmuxQuiet(["kill-pane", "-t", pane]);
    return null;
  }
  return pane;
}

/**
 * Like `newWindow`, but targets a specific (named) session rather than the
 * current one — needed when restoring tabs into the canonical session from the
 * `--tmux` bootstrap process, which isn't itself inside that session.
 */
export function newWindowIn(session: string, name: string, cwd: string, argv: string[]): void {
  tmuxQuiet(["new-window", "-d", "-t", exactTarget(session), "-n", name, "-c", cwd, "--", ...argv]);
  pinName(`${exactTarget(session)}:${name}`);
}
