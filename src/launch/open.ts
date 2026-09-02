// Opening a managed target: deciding whether it already exists, creating it if
// not, and describing how the caller hands the terminal over to it.
//
// The bottom of src/launch/ — every other module here builds a target and then
// asks this one to open it, so nothing in this file may import a sibling.
import type { AgentSession } from "../types.ts";
import {
  sessionName,
  shortId,
  type LiveTarget,
  liveTargetForShortId,
  paneLocation,
  hasSession,
  newDetached,
  newWindow,
  windowLocation,
  insideTmux,
  tmuxQuiet,
} from "../tmux.ts";
import { resumeArgv } from "../launchArgv.ts";

export interface OpenPlan {
  /** Whether a live tmux target already existed (we just navigate to it). */
  alreadyRunning: boolean;
  tmuxName: string;
  /**
   * "inline" (inside tmux): the agent runs as a window in the current session;
   * the caller runs `handover` *without* unmounting, so the menu stays alive in
   * its own window. "handover" (outside tmux): the agent is its own session; the
   * caller unmounts Ink first, then runs `handover` to attach.
   */
  mode: "inline" | "handover";
  /** argv to run to hand over to / navigate to the target. */
  handover: string[];
}

/**
 * How to bring the user to an existing PANE.
 *
 * Inside tmux the pane's window must be selected AND the pane focused within it,
 * which is two tmux commands — sent as one invocation via tmux's own `;`
 * separator, since a plan carries a single argv. Outside tmux there is no client
 * to move, so we attach to the pane's session (tmux resolves a pane id to the
 * session containing it).
 */
function paneHandover(pane: string): string[] {
  return insideTmux()
    ? ["tmux", "select-window", "-t", pane, ";", "select-pane", "-t", pane]
    : ["tmux", "attach-session", "-t", pane];
}

/**
 * A pane plan for an already-running pane-hosted session. Inside tmux it
 * navigates in place (the menu stays mounted); outside it has to hand the
 * terminal over, exactly as a window would.
 */
function panePlan(name: string, pane: string): OpenPlan {
  return {
    alreadyRunning: true,
    tmuxName: name,
    mode: insideTmux() ? "inline" : "handover",
    handover: paneHandover(pane),
  };
}

/**
 * Prepare to open a managed target `name` running `argv` in `cwd`, creating it
 * if needed.
 *
 * - Inside tmux: the agent is a window in the current session. If one already
 *   exists (here or in another session) we switch to it; otherwise we create a
 *   new window and select it — i.e. a new tab next to you. The menu keeps
 *   running in its own window (see `runInline`).
 * - Outside tmux: the agent is its own detached session that we attach to
 *   (attach blocks until you detach, then control returns to the menu).
 *
 * Either way, a session the launcher parked in a PANE of somebody else's window
 * (the global orchestrator, beside the menu) carries no window or session of its
 * own, so the name lookups above cannot see it — `paneLocation` is what stops us
 * starting a second copy of a session that is running perfectly well.
 */
export function openTarget(name: string, cwd: string, argv: string[]): OpenPlan {
  if (insideTmux()) {
    const loc = windowLocation(name);
    if (loc) return { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", loc] };
    const pane = paneLocation(name);
    if (pane) return panePlan(name, pane);
    // A session by this name may exist from an earlier outside-tmux launch.
    if (hasSession(name)) return { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", name] };
    newWindow(name, cwd, argv);
    return { alreadyRunning: false, tmuxName: name, mode: "inline", handover: ["tmux", "select-window", "-t", name] };
  }
  const pane = paneLocation(name);
  if (pane) return panePlan(name, pane);
  const alreadyRunning = hasSession(name);
  if (!alreadyRunning) newDetached(name, cwd, argv);
  return { alreadyRunning, tmuxName: name, mode: "handover", handover: ["tmux", "attach-session", "-t", name] };
}

/**
 * An `OpenPlan` that navigates to a pane the caller has just created. Exposed
 * for the global-orchestrator launch, which splits the launcher's window itself
 * rather than going through `openTarget` — the pane doesn't exist yet at the
 * point `openTarget` would look for it.
 */
export function freshPanePlan(name: string, pane: string): OpenPlan {
  return { ...panePlan(name, pane), alreadyRunning: false };
}

/**
 * Execute an "inline" plan's handover (switch/select the target window) without
 * disturbing the still-mounted menu. The agent window already exists; this just
 * moves the client's focus to it. `handover[0]` is always the literal "tmux".
 */
export function runInline(plan: OpenPlan): void {
  tmuxQuiet(plan.handover.slice(1));
}

/**
 * Resume/attach an existing agent session. If the session is already running
 * under some launcher window — possibly a kind-prefixed one (`cl-bg-`/`cl-new-`)
 * whose name differs from the canonical `cl-claude-<id>` — navigate to that
 * exact window so we never spawn a duplicate. Otherwise (cold resume) open the
 * canonical target, which `claude --resume` fills in.
 *
 * `liveWindow` is the actual window the model attributed this session to
 * (`LoadedModel.liveWindows`). Prefer it: it's the SAME reconciliation that
 * decided the session is running, so it also covers windows `liveTargetForShortId`
 * can't — legacy non-id-bearing names (`cl-pr-…`/`cl-wi-…`/`cl-free-…`) matched by
 * cwd. Without it, a session shown as running under such a window would resume a
 * duplicate instead of attaching.
 */
export function openSession(s: AgentSession, liveWindow?: LiveTarget): OpenPlan {
  // The NAME half: `openTarget` re-resolves the location itself (via
  // `windowLocation`, then `paneLocation`), so it is already host-agnostic and
  // wants the name.
  const target = liveWindow?.name ?? liveTargetForShortId(shortId(s.id))?.name ?? sessionName(s);
  return openTarget(target, s.cwd, resumeArgv(s));
}
