// Opening a managed target: deciding whether it already exists, creating it if
// not, and describing how the caller hands the terminal over to it.
//
// The bottom of src/launch/ — every other module here builds a target and then
// asks this one to open it, so nothing in this file may import a sibling.
import type { AgentSession } from "../shared/types.ts";
import {
  sessionName,
  shortId,
  type LiveTarget,
  liveTargetForShortId,
  paneLocation,
  hasSession,
  newDetached,
  newWindow,
  newWindowIn,
  windowTarget,
  exactTarget,
  windowLocation,
  insideTmux,
  tmuxQuiet,
  stampManagedWindow,
  windowIdentity,
  type WindowTags,
} from "../runtime/tmux/index.ts";
import { resumeArgv } from "./argv.ts";

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
  /** The exact tmux target of the window just created, from the openers that know it without a scan. */
  target?: string;
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
 * Whether it already exists is asked the same three ways on BOTH sides (see
 * `livePlan`), because where a live agent sits says nothing about where this
 * process runs: a window inside the launcher's host session is just as live to
 * an `agendo resume` typed in a bare terminal as to the menu beside it.
 *
 * `known` is the exact target of `name` the caller has just confirmed is live
 * (see `openSession`). It wins outright, because a lookup by name can land on
 * the wrong window of that name.
 */
export function openTarget(name: string, cwd: string, argv: string[], tags?: WindowTags, known?: string): OpenPlan {
  const live = livePlan(name, known);
  if (live) return live;
  if (insideTmux()) {
    newWindow(name, cwd, argv);
    stampNewTarget(name, tags);
    return { alreadyRunning: false, tmuxName: name, mode: "inline", handover: ["tmux", "select-window", "-t", name] };
  }
  newDetached(name, cwd, argv);
  stampNewTarget(name, tags);
  return { alreadyRunning: false, tmuxName: name, mode: "handover", handover: ["tmux", "attach-session", "-t", name] };
}

/**
 * How to reach a target `name` that is already live, or null if nothing is.
 *
 * A `known` target wins outright. tmux allows duplicate window names and
 * agendo creates them (see `windowLocations`), so the FIRST window called
 * `name` can be a restore placeholder in another host session while the agent
 * runs in this one. Navigating there and pressing a key would wake the
 * placeholder into a second agent on the same transcript.
 *
 * Otherwise three places, in this order: a WINDOW of that name in any
 * session; a PANE the launcher parked in somebody else's window (the global
 * orchestrator, beside the menu), which carries no window or session of its
 * own; a SESSION of that name, from an earlier outside-tmux launch. Missing any
 * one of them starts a second agent on a transcript one is already writing —
 * `has-session` resolves session names only, so outside tmux the window lookup
 * is the only thing that sees a tab in the launcher's host session.
 *
 * Inside tmux the client is moved (the menu stays mounted); outside, the
 * terminal is handed over by attaching, which for a `session:index` or a pane
 * id lands on that window or pane.
 */
function livePlan(name: string, known?: string): OpenPlan | null {
  if (known) return known.startsWith("%") ? panePlan(name, known) : navigatePlan(name, known);
  const loc = windowLocation(name);
  if (loc) return navigatePlan(name, loc);
  const pane = paneLocation(name);
  if (pane) return panePlan(name, pane);
  return hasSession(name) ? navigatePlan(name, name) : null;
}

/**
 * A plan that navigates to live window or session `target` and creates
 * nothing: switch the client inside tmux, attach outside. Exposed for callers
 * that must never start what they navigate to (see existingOrchestrator.ts).
 */
export function navigatePlan(name: string, target: string): OpenPlan {
  return insideTmux()
    ? { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", target] }
    : { alreadyRunning: true, tmuxName: name, mode: "handover", handover: ["tmux", "attach-session", "-t", target] };
}

/**
 * Tag a target this call has just CREATED (see `stampManagedWindow`).
 *
 * Only on creation, never on a target `livePlan` found. Re-stamping a
 * live window would overwrite whatever its tag says now with what this caller
 * happens to believe — and the field that matters is `acquired`: a window agendo
 * later adopts is stamped `adopted`, and navigating to it must not quietly
 * demote it back to `launched`. Completing a partially-known tag is a deliberate
 * second call to `stampManagedWindow`, not a side effect of opening something.
 *
 * Best-effort by design. A tag that fails to land costs this window the exact
 * attribution and leaves it on the cwd heuristic it would have had anyway, which
 * is not worth failing a launch the user asked for.
 */
function stampNewTarget(name: string, tags?: WindowTags): void {
  if (tags) stampManagedWindow(name, tags);
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
  // The exact target to navigate to, if one is live: the scan's, while tmux
  // still resolves it, else a fresh lookup by id. `liveWindow` comes from the
  // menu's model, up to a poll old, and its window may have closed since while
  // the session went on under its canonical name — which only the id lookup
  // finds. With neither, `openTarget` looks the name up itself.
  const fresh = liveWindow && windowIdentity(liveWindow.target) ? liveWindow : null;
  const hit = fresh ?? liveTargetForShortId(shortId(s.id));
  const name = hit?.name ?? liveWindow?.name ?? sessionName(s);
  return openTarget(name, s.cwd, resumeArgv(s), sessionTags(s), hit?.target);
}

/**
 * Cold-resume a session as a window of tmux session `host`, wherever this
 * process runs. `openSession` cannot do this from outside tmux — there it makes
 * the agent its own detached session — which is right for a CLI `resume`, but
 * wrong for `agendo focus` waking a paused tab: the tab should come back in the
 * launcher session that held it, next to its siblings, not move out of it.
 * The caller has already established that nothing is running for `s`.
 */
export function openSessionIn(s: AgentSession, host: string): OpenPlan {
  const name = sessionName(s);
  newWindowIn(host, name, s.cwd, resumeArgv(s));
  stampNewTarget(name, sessionTags(s));
  const target = windowTarget(host, name);
  return { alreadyRunning: false, tmuxName: name, mode: "inline", handover: ["tmux", "select-window", "-t", target], target };
}

/**
 * Cold-resume a session as a detached tmux session of its own — even from inside
 * tmux, where `openSession` would add it as a window of the CURRENT session,
 * which for `agendo focus` may be a session of the user's own. The caller has
 * already established that nothing is running for `s`.
 */
export function openSessionDetached(s: AgentSession): OpenPlan {
  const name = sessionName(s);
  newDetached(name, s.cwd, resumeArgv(s));
  stampNewTarget(name, sessionTags(s));
  return { alreadyRunning: false, tmuxName: name, mode: "handover", handover: ["tmux", "attach-session", "-t", name], target: exactTarget(name) };
}

/**
 * The window tag for a session we are resuming. This is the one launch path that
 * knows the session's FULL id up front — it is resuming a session that already
 * exists — so the tag it writes is complete, and the window it opens attributes
 * exactly from its first live scan rather than through its name's 12-character
 * short id.
 */
export function sessionTags(s: AgentSession): WindowTags {
  return { sessionId: s.id, source: s.source, branch: s.branch, acquired: "launched" };
}
