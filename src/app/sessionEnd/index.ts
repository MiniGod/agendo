// Ending a running session: CLOSE it (kill its window or pane, forget its restore
// tab) or PAUSE it (kill the same way, leave a restore placeholder in its place).
// One implementation behind `agendo close`, `agendo pause` and the list's `x`,
// `X` and `p` keys, so the guards cannot drift between them.
//
// WHAT IT DOES NOT TOUCH — a guarantee, not a hope. The only writes are the tmux
// kill, the placeholder a pause leaves, and one tab of one host's restore
// snapshot. Nothing under a worktree is read, moved or removed: the worktree,
// its branch and every commit in it survive, and the transcript stays on disk
// so `resume <id>` brings the session back.
//
// Two phases, because the TUI asks before it acts: `inspectEnd` resolves the
// session and runs every guard, `performEnd` kills. `endSession` is both, and
// re-inspects rather than trusting an earlier verdict — a session that was idle
// when the confirmation went up may be mid-turn by the time `y` lands.
import { refreshLiveTmux } from "../model/index.ts";
import { SessionIndex } from "../../sessions/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import {
  paneReadiness, readPaneState, shortId, type LiveTarget, type PaneSnapshot, type Readiness,
} from "../../runtime/tmux/index.ts";
import {
  inFlightRefusal, killFailure, killFailureReason, manyWindowsRefusal, noSessionRefusal, refused, sharedDirRefusal,
  unmanagedRefusal, unreadRefusal, type EndAction, type Refusal,
} from "./guards.ts";
import { closeAddress, closeTargetOf, liveHandle, tidyHost, type CloseAddress } from "./resolve.ts";
import { leavePausedTab, loneTabRefusal, unpausableReason } from "./pause.ts";

export * from "./guards.ts";
export { closeTargetOf, liveHandle } from "./resolve.ts";

/** What the token resolved to, and the label the messages call it by. */
export interface FoundSession {
  s: AgentSession | undefined;
  /** The short id the token names, whether or not a session answers to it. */
  sid: string;
  label: string;
}

/** Nothing is running under the session — the end state already holds. */
export interface NotRunning { kind: "notRunning"; found: FoundSession }
/** A pause of a session whose tab is already the paused placeholder. */
export interface AlreadyPaused { kind: "alreadyPaused"; found: FoundSession; target: string }

/** Every guard passed, or was forced past: what will be killed, and what the pane said. */
export interface EndPlan {
  kind: "plan";
  action: EndAction;
  found: FoundSession;
  target: string;
  canon: string;
  /** The target is a dormant restore placeholder — no agent behind it. */
  placeholder: boolean;
  addr: CloseAddress;
  readiness: Readiness | null;
  /** The reasons of every refusal `force` lifted — empty when nothing was forced past. */
  waived: string[];
}

export interface Ended {
  kind: "done";
  action: EndAction;
  found: FoundSession;
  target: string;
  placeholder: boolean;
  readiness: Readiness | null;
}

export type Inspection = Refusal | NotRunning | AlreadyPaused | EndPlan;
export type EndOutcome = Refusal | NotRunning | AlreadyPaused | Ended;

/** The token resolves exactly as it does for `status`/`send`/`resume`: full id, short id, or a `cl-…-<id>` tmux name. */
export function resolveToken(token: string, sessions: readonly AgentSession[]): FoundSession {
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const s = sessions.find((x) => x.id === token || shortId(x.id) === sid);
  return { s, sid, label: s ? shortId(s.id) : sid };
}

/**
 * Resolve the token and run every guard, killing nothing. `force` lifts the
 * refusals that guard work in flight or an ambiguous window (code 2), never the
 * errors (code 1) — and a forced plan still names every refusal it lifted
 * (`waived`), so a caller that asks first can say exactly what it is forcing.
 *
 * The guards, in order, because a mistargeted kill here can take out someone's
 * live agent — including the launcher itself:
 *  1. RESOLUTION. The session's live window comes from `refreshLiveTmux` — the
 *     same reconciliation the menu and `wait` use — so a session running under a
 *     `cl-wi-…`/`cl-pr-…` window is found rather than missed. A session too new
 *     to have a transcript falls back to its id-bearing window, since `agendo
 *     launch` prints an id well before the agent writes its log. An id that
 *     resolves to neither kills nothing.
 *  2. MANAGED-ONLY (`unmanagedRefusal`), and what a pause needs that a close
 *     does not (`unpausableReason`, `loneTabRefusal`) — the errors.
 *  3. UNAMBIGUOUS ATTRIBUTION (`sharedDirRefusal`, `manyWindowsRefusal`).
 *  4. WORK IN FLIGHT (`inFlightRefusal`), and a pane that could not be READ is
 *     refused too (`unreadRefusal`).
 * A dormant restore placeholder skips the readiness read: there's no agent in it
 * to lose. A pause treats a placeholder as already done.
 */
export async function inspectEnd(token: string, action: EndAction, force: boolean): Promise<Inspection> {
  const index = await SessionIndex.build();
  const found = resolveToken(token, index.all);
  const { liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const { live, canon } = liveHandle(found.s, found.sid, liveWindows);
  if (!canon) return noSessionRefusal(token, action);
  const { placeholder, target } = closeTargetOf(live, canon, livePlaceholders);
  if (!target) return { kind: "notRunning", found };
  if (placeholder && action === "pause") return { kind: "alreadyPaused", found, target };
  return guard({ action, found, target, canon, placeholder, live, sessions: index.all }, force);
}

/** A session resolved to something live, before any guard has run. */
interface Located {
  action: EndAction;
  found: FoundSession;
  target: string;
  canon: string;
  placeholder: boolean;
  live: LiveTarget | null | undefined;
  sessions: readonly AgentSession[];
}

/** Guards 2–4. The errors stop it outright; the refusals stop it unless forced. */
function guard(c: Located, force: boolean): Inspection {
  const addr = closeAddress(c.target, c.live);
  const fatal = unmanagedRefusal(c.target, c.action) ?? pauseRefusal(c, addr);
  if (fatal) return fatal;
  // One pane read serves both the verdict and, if we refuse, the screen tail that
  // explains it — the same shape `send` uses when it declines.
  const pane = c.placeholder ? null : readPaneState(addr.readTarget);
  const readiness = pane ? paneReadiness(pane.raw, pane.cursor) : null;
  const forceable = forceableRefusals(c, addr, pane, readiness);
  if (forceable[0] && !force) return forceable[0];
  const { action, found, target, canon, placeholder } = c;
  return { kind: "plan", action, found, target, canon, placeholder, addr, readiness, waived: forceable.map((r) => r.reason) };
}

/** What a pause needs that a close does not. */
function pauseRefusal(c: Located, addr: CloseAddress): Refusal | null {
  if (c.action !== "pause") return null;
  return unpausableReason(c.found.s, c.found.label, c.target, c.live, addr.location) ?? loneTabRefusal(c.found.label, c.target, addr.location);
}

/** Every refusal `force` lifts, in the order they are reported — the first is the one an unforced end names. */
function forceableRefusals(c: Located, addr: CloseAddress, pane: PaneSnapshot | null, readiness: Readiness | null): Refusal[] {
  return [
    sharedDirRefusal(c.target, c.found.label, c.sessions, c.action),
    manyWindowsRefusal(addr.locations, c.target, c.found.label, c.action),
    unreadRefusal(pane, c.placeholder, c.target, addr.readTarget, c.action),
    inFlightRefusal(pane, readiness, c.action),
  ].filter((r): r is Refusal => r !== null);
}

/**
 * Carry out a plan `inspectEnd` produced. Every tmux write is fire-and-forget,
 * so the target is confirmed gone before success is reported; a pause also
 * confirms its placeholder landed.
 */
export function performEnd(plan: EndPlan): Ended | Refusal {
  const { how, gone } = plan.addr.kill();
  const failure = killFailure(how, gone, plan.target, plan.addr.location, plan.action);
  if (failure) return refused(1, failure, killFailureReason(how));
  const host = plan.addr.location?.split(":")[0];
  if (plan.action === "pause") return finishPause(plan, host);
  tidyHost(host, plan.canon, plan.placeholder);
  return ended(plan);
}

function finishPause(plan: EndPlan, host: string | undefined): Ended | Refusal {
  // `unpausableReason` already refused a plan with no host or no transcript.
  if (host && plan.found.s && leavePausedTab(host, plan.found.s)) return ended(plan);
  const why = `ended ${plan.target}, but tmux did not take the paused tab in its place`;
  return { ...refused(1, `Paused only halfway: ${why}. Bring the session back with \`resume ${plan.found.label}\`.`, why), halfway: true };
}

function ended(plan: EndPlan): Ended {
  return { kind: "done", action: plan.action, found: plan.found, target: plan.target, placeholder: plan.placeholder, readiness: plan.readiness };
}

/** Inspect, then — only when every guard passed — perform. */
export async function endSession(token: string, action: EndAction, force: boolean): Promise<EndOutcome> {
  const inspection = await inspectEnd(token, action, force);
  return inspection.kind === "plan" ? performEnd(inspection) : inspection;
}
