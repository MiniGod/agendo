// The launcher host session's menu window: (re)creating it, checking it's still
// alive, and making sure it always ends up at tmux window index 0 — whether the
// session was just created from scratch or already existed with its menu gone.
// Split out of windows.ts to keep both files under the shared max-lines budget;
// this module composes windows.ts's `pinName` rather than duplicating it.
import { spawnSync } from "child_process";
import { tmuxLines, tmuxQuiet } from "./exec.ts";
import { LAUNCHER_SESSION, PANE_TARGET_OPTION, insideTmux } from "./names.ts";
import { exactTarget, hasSession, setSessionRoot, windowTarget } from "./server.ts";
import { pinName } from "./windows.ts";

/**
 * The menu window of a launcher host session, as an exact-pinned tmux target.
 *
 * Exported so the split path (`src/launch/global.ts`) addresses the same window
 * this module kills and rebuilds, rather than spelling the target a second time.
 * BOTH halves are pinned: an unpinned window name is a PREFIX match, so a window
 * the user happened to call "launcher-notes" could be split in place of the menu.
 */
export function launcherWindowTarget(session: string): string {
  return windowTarget(session, "launcher");
}

/**
 * Move the (just-created) window `target` to index 0 of `session`, so the menu
 * always leads regardless of `base-index` — a user setting `tmux new-session`
 * has no flag to override, and which otherwise puts a fresh session's first
 * window at index 1.
 *
 * `target` is name-addressed (see `launcherWindowTarget`) rather than by the
 * index tmux just assigned, so the caller never has to read that index back.
 * Best-effort and silent: nothing else in this launcher addresses a window by
 * INDEX (lookups go by name), so a menu left at a non-zero index is cosmetic,
 * not broken — worth less than a launcher that refuses to start because index 0
 * was somehow taken.
 */
function moveWindowToFront(target: string, session: string): void {
  tmuxQuiet(["move-window", "-s", target, "-t", `${exactTarget(session)}:0`]);
}

/**
 * The panes of the menu window, each tagged with whether it is dead and whether
 * it hosts a managed session of its own.
 *
 * Read per PANE rather than per window because the window can outlive the menu:
 * a global orchestrator is parked in a pane beside it, and tmux only destroys a
 * window once its LAST pane exits. A `#{pane_dead}` read off `list-windows`
 * answers for whichever pane is active, which after the menu quits is the
 * orchestrator — so the window would keep reporting itself as a running menu.
 */
function launcherPanes(session: string): { dead: boolean; managed: boolean }[] {
  return tmuxLines([
    "list-panes", "-t", launcherWindowTarget(session), "-F", `#{pane_dead}\t#{?${PANE_TARGET_OPTION},1,0}`,
  ]).map((line) => {
    const [dead, managed] = line.split("\t");
    return { dead: dead === "1", managed: managed === "1" };
  });
}

/**
 * Whether a launcher host session currently has a live window running the menu.
 * The menu window is pinned to the name "launcher"; tmux destroys a window when
 * its program exits (default `remain-on-exit off`), so a missing — or dead, if a
 * config kept it around — "launcher" window means the menu isn't running.
 *
 * A pane hosting a managed session never counts as the menu, however alive it is
 * (see `launcherPanes`): `--tmux` promises to be a way BACK INTO the launcher, and
 * an orchestrator holding the window open must not make it answer "already there".
 */
export function launcherWindowLive(session: string = LAUNCHER_SESSION): boolean {
  return launcherPanes(session).some((p) => !p.dead && !p.managed);
}

/**
 * (Re)create the menu window inside a launcher host session, then move it to
 * index 0 so it sits at the front the way the original first window did (see
 * `moveWindowToFront`). Any leftover (dead) "launcher" window is cleared first
 * so we never end up with two. Detached — the caller selects/attaches after.
 */
function spawnLauncherWindow(session: string, cwd: string, launcherArgv: string[]): void {
  // A LIVE managed pane in that window — a global orchestrator parked beside the
  // menu — outlives the menu itself. Killing the window to rebuild it would take
  // a running agent down with it, so re-split instead: `-b` puts the new menu
  // back on the LEFT, where it sat before the user quit it. A DEAD one (only
  // possible under `remain-on-exit on`) protects nothing and must not divert us
  // from the kill-and-rebuild below, or every quit-menu → `--tmux` cycle would
  // stack another corpse pane in the window.
  //
  // And NO `-d` here, unlike every other split this launcher makes. At launch
  // time `-d` is right: the menu keeps the keyboard while the agent boots. Here
  // the menu IS what is being rebuilt, and the only other pane in the window is a
  // running orchestrator's — leaving it active would attach the user straight
  // into that agent's input box, so the next thing they typed to get their menu
  // back would be pasted into it as a prompt.
  //
  // The status is checked rather than fire-and-forget: tmux refuses a split it
  // has no room for, and a silently missing menu is exactly the outcome the
  // paragraph above is trying to prevent. Falling through then costs the dead
  // orchestrator's window, which is the lesser harm — the user asked to get back
  // into their launcher.
  if (launcherPanes(session).some((p) => !p.dead && p.managed)) {
    const split = spawnSync(
      "tmux",
      ["split-window", "-h", "-b", "-t", launcherWindowTarget(session), "-c", cwd, "--", ...launcherArgv],
      { stdio: "ignore" },
    );
    if (split.status === 0) return;
    console.error(
      `warning: could not split the launcher window in tmux session "${session}" to rebuild the menu.\n` +
        `  Rebuilding the window instead — a session parked in a pane of it will be closed.`,
    );
  }
  tmuxQuiet(["kill-window", "-t", launcherWindowTarget(session)]); // no-op if none exists
  spawnSync(
    "tmux",
    ["new-window", "-d", "-t", exactTarget(session), "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
    { stdio: "ignore" },
  );
  pinName(`${exactTarget(session)}:launcher`);
  moveWindowToFront(launcherWindowTarget(session), session);
}

/**
 * Bring the user into a launcher host session, creating it (with its first
 * window running `launcherArgv`) if it doesn't exist yet. Backs the `--tmux`
 * flag. Outside tmux this attaches (blocks until you detach); inside tmux it
 * switches the current client to the host session. Defaults to the canonical
 * `agendo` session (bare `agendo`); a path-scoped launcher passes its own name.
 *
 * If the session exists but its menu window is gone (e.g. the user quit the
 * launcher while agent windows kept the session alive), the menu is recreated —
 * so `--tmux` is always a way *back into* the launcher, not just an attach to a
 * launcher-less session. The client always lands on the menu window itself.
 *
 * When the session is created fresh and `root` is non-null (a path-scoped
 * launcher), the absolute root is recorded as `@cl_root` so a later attach can
 * detect a basename collision.
 *
 * `onFreshCreate` runs once, only when the session is created from scratch — the
 * moment to lazily restore previously-open agent tabs (see restore.ts). It's
 * skipped when attaching to an existing session, whose windows are already live.
 * Kept as a callback so tmux.ts stays free of a restore.ts import (restore.ts
 * depends on tmux.ts).
 */
export function enterLauncherSession(
  session: string,
  root: string | null,
  cwd: string,
  launcherArgv: string[],
  onFreshCreate?: () => void,
): void {
  if (!hasSession(session)) {
    spawnSync(
      "tmux",
      ["new-session", "-d", "-s", session, "-n", "launcher", "-c", cwd, "--", ...launcherArgv],
      { stdio: "inherit" },
    );
    pinName(`${exactTarget(session)}:launcher`);
    // `base-index` (a common user tmux setting) puts a fresh session's first
    // window at index 1, not 0 — `new-session` has no flag to override that, so
    // the menu is moved to the front right after creation instead, and before
    // `onFreshCreate` below spawns any restored tabs, so those fill in above it.
    moveWindowToFront(launcherWindowTarget(session), session);
    // A dropped write here disarms the collision guard for the whole life of
    // this session — `sessionRoot` would answer null forever after and a second,
    // differently-rooted launcher would silently merge into these tabs. That is
    // precisely the failure this used to have, and it was invisible, so say so
    // rather than discard the status. Not fatal: the session is up and usable,
    // and refusing to launch over it would be a worse trade than losing one
    // guard.
    if (root && !setSessionRoot(session, root)) {
      console.error(
        `warning: could not record this launcher's root on tmux session "${session}".\n` +
          `  Another launcher for a different path with the same basename will share its tabs\n` +
          `  instead of being refused. Pass -s <name> to keep them apart.`,
      );
    }
    onFreshCreate?.();
  } else if (!launcherWindowLive(session)) {
    spawnLauncherWindow(session, cwd, launcherArgv);
  }
  // Land on the menu window specifically, not whatever window was last active.
  tmuxQuiet(["select-window", "-t", `${exactTarget(session)}:launcher`]);
  const verb = insideTmux() ? ["switch-client"] : ["attach-session"];
  spawnSync("tmux", [...verb, "-t", exactTarget(session)], { stdio: "inherit" });
}
