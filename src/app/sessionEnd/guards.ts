// The guards that stand between a request to end a session and the kill: each
// one a function that answers with a `Refusal` or null, never by exiting. The
// CLI turns a refusal into stderr and an exit code (src/cli/commands/close.ts);
// the TUI turns it into a notice or a force-confirmation (src/ui/actions/sessionEnd.ts).
// Same verdicts, so `agendo close` and the list's `x` can never disagree about
// what is safe to end.
import { normalizeCwd } from "../context.ts";
import { idBearingName } from "../../runtime/restore/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import {
  liveManagedPaths, managedKind, paneBackgroundAgents, shortId, stripAnsi,
  type PaneSnapshot, type Readiness,
} from "../../runtime/tmux/index.ts";

/** What the caller asked for: end the session for good, or leave its tab paused. */
export type EndAction = "close" | "pause";

/**
 * Why the session was not ended. `code` is the CLI's exit code and doubles as
 * the TUI's "may force" bit: 2 is a refusal ("I could, but I won't" — `--force`
 * or `X` overrides it), 1 an error that no force can talk its way past.
 * `message` is the full CLI text; `reason` the short clause a one-line notice
 * can carry; `screen` the pane tail that explains a work-in-flight refusal.
 * `halfway` marks a pause that ended the agent but could not leave its tab — a
 * failure, but not one where nothing happened.
 */
export interface Refusal {
  kind: "refused";
  code: 1 | 2;
  message: string;
  reason: string;
  screen?: string[];
  halfway?: true;
}

/** The verb as each message spells it. */
export function verbOf(action: EndAction): { base: string; ing: string } {
  return action === "pause" ? { base: "pause", ing: "pausing" } : { base: "close", ing: "closing" };
}

export function refused(code: 1 | 2, message: string, reason: string, screen?: string[]): Refusal {
  return screen ? { kind: "refused", code, message, reason, screen } : { kind: "refused", code, message, reason };
}

/**
 * Readiness states where ending a session would destroy work in flight, so it is
 * refused without force (mirroring how `send` refuses to type into a non-ready
 * pane): a turn being generated ("busy"), a conversation being rewritten
 * ("compacting"), text typed but not yet submitted ("queued"), or an open
 * question waiting on an answer ("dialog").
 *
 * The states NOT listed are deliberately closeable: "ready" (idle, the finished
 * session this exists for), "limited" (stuck at its usage cap — a prime close
 * candidate) and "unknown". "unknown" is what a pane whose agent already exited
 * looks like — a bare shell prompt with no input box — which is the most obvious
 * thing of all to want closed; refusing it would push callers straight back to
 * hand-rolled `tmux kill-window`, the failure `close` replaces.
 *
 * Kept apart from wait.ts' own BUSY_STATES: the two overlap today but answer
 * different questions ("is it still working?" vs "would ending it lose
 * something?"), and this refuses two settled-but-unsaved states that `wait`
 * considers done.
 */
const UNSAFE_CLOSE_STATES = new Set<Readiness>(["busy", "compacting", "queued", "dialog"]);

/**
 * Why ending this pane would destroy work in flight, phrased for the refusal
 * message — or null when ending it is safe.
 *
 * TWO independent reasons, because readiness answers only half the question.
 * Since #44 it describes the MAIN agent alone, so a session whose subagent is
 * still writing reads "ready" here; ending it is exactly the destructive misread
 * this guard exists to prevent. The count is read off the SAME capture as the
 * readiness, so the two can never describe different frames.
 *
 * Deliberately NOT routed through `sessionFinished`, which pairs the same two
 * facts for `wait` and the stall verdict: those treat "queued" and "dialog" as
 * done, and this must refuse both. Same inputs, different question.
 */
export function unsafeCloseReason(readiness: Readiness, agents: number): string | null {
  if (UNSAFE_CLOSE_STATES.has(readiness)) return `session looks "${readiness}"`;
  if (agents > 0) return `session is idle but ${agents} background agent${agents === 1 ? " is" : "s are"} still running`;
  return null;
}

/**
 * Refuse, with the pane's own last lines as evidence, when the session still has
 * work in flight. Everything it needs is already read — no extra tmux call.
 */
export function inFlightRefusal(pane: PaneSnapshot | null, readiness: Readiness | null, action: EndAction): Refusal | null {
  if (!pane || !readiness) return null;
  const reason = unsafeCloseReason(readiness, paneBackgroundAgents(pane.raw));
  if (!reason) return null;
  const v = verbOf(action);
  const screen = stripAnsi(pane.raw).split("\n").filter((x) => x.trim()).slice(-12);
  return refused(2, `Not ${v.ing}: ${reason} — work is in flight. Pass --force to ${v.base} it anyway.`, reason, screen);
}

/** No session and no live window answers to the token: nothing is touched. */
export function noSessionRefusal(token: string, action: EndAction): Refusal {
  return refused(1, `No session found for "${token}" — refusing to ${verbOf(action).base} anything.`, "no such session");
}

/**
 * MANAGED-ONLY. That already holds by construction — `liveWindows` is built only
 * from managed windows — so this is defense in depth: if that ever stops holding,
 * a typo must abort rather than kill the user's own shell or the launcher window.
 */
export function unmanagedRefusal(target: string, action: EndAction): Refusal | null {
  if (managedKind(target)) return null;
  return refused(1, `Refusing to ${verbOf(action).base} "${target}": not a managed agendo window.`, "not a managed agendo window");
}

/**
 * UNAMBIGUOUS ATTRIBUTION. A `cl-wi-…`/`cl-pr-…` window embeds an ITEM id, not a
 * session id, so it is attributed to the most-recently-used session in its
 * working directory. Fine for reading a pane; for a kill it is not, because when
 * two sessions share a directory the newest wins the attribution while the OTHER
 * may be the agent actually running there.
 */
export function sharedDirRefusal(target: string, label: string, sessions: readonly AgentSession[], action: EndAction): Refusal | null {
  if (idBearingName(target)) return null;
  const cwd = liveManagedPaths().find((p) => p.name === target)?.cwd;
  const rivals = cwd ? sessions.filter((x) => normalizeCwd(x.cwd) === normalizeCwd(cwd)) : [];
  if (rivals.length <= 1) return null;
  const v = verbOf(action);
  return refused(
    2,
    `Not ${v.ing}: window ${target} carries no session id, and ${rivals.length} sessions share ` +
      `its directory (${cwd}) — the one running in it may not be ${label}. Candidates: ` +
      `${rivals.map((x) => shortId(x.id)).join(", ")}. Pass --force to ${v.base} that window anyway.`,
    `window ${target} carries no session id and ${rivals.length} sessions share its directory`,
  );
}

/** More than one live window carries the name: refused rather than guessed. */
export function manyWindowsRefusal(locations: readonly string[], target: string, label: string, action: EndAction): Refusal | null {
  if (locations.length <= 1) return null;
  const v = verbOf(action);
  const Base = v.base[0].toUpperCase() + v.base.slice(1);
  return refused(
    2,
    `Not ${v.ing}: ${locations.length} live windows are named ${target} (${locations.join(", ")}) — ` +
      `agendo can't tell which one is ${label}. ${Base} the one you mean from its launcher, or pass --force.`,
    `${locations.length} live windows are named ${target}`,
  );
}

/**
 * A read that FAILED is not evidence of an idle session. `paneReadiness` turns
 * an empty screen into "unknown", which the work-in-flight guard lets through —
 * so a tmux read that never landed (busy server, pane gone between the listing
 * and here) would silently disarm the only check standing between the kill and a
 * mid-turn agent. `wait` distrusts a single missed read for the same reason
 * (EXIT_CONFIRM_TICKS); ending is the destructive one, so it refuses outright.
 */
export function unreadRefusal(pane: PaneSnapshot | null, placeholder: boolean, target: string, readTarget: string, action: EndAction): Refusal | null {
  if (placeholder || pane) return null;
  const v = verbOf(action);
  return refused(
    2,
    `Not ${v.ing}: tmux could not read ${target}'s pane (${readTarget}), so agendo can't tell whether ` +
      `work is in flight. Re-run to try again, or pass --force to ${v.base} it unread.`,
    "tmux could not read its pane",
  );
}

/** How a kill came out (see `killManagedTarget`), plus the pane-hosted shape. */
export type KillHow = "window" | "session" | "moved" | "none" | "pane";

/**
 * Why the kill did not happen, or null when it did. `how === "none"` means tmux
 * listed the target a moment ago but can now place it in neither a window nor a
 * session — so nothing was killed, whatever the (vacuously true) `gone` check
 * says. Report the failure rather than the reassuring lie; the caller can look
 * and re-run.
 */
export function killFailure(how: KillHow, gone: boolean, target: string, location: string | null, action: EndAction = "close"): string | null {
  if (gone && how !== "none") return null;
  const v = verbOf(action);
  if (how === "moved") {
    return `Not ${v.ing} ${target}: the window at ${location} is no longer it (tmux renumbered while we looked). Nothing was killed — re-run to pick it up at its new index.`;
  }
  return `Could not ${v.base} ${target}: tmux ${how === "none" ? "can no longer place it in any session" : "still reports it live"}. Nothing else was changed.`;
}

/** The same failure as the short clause a one-line notice carries (`Refusal.reason`). */
export function killFailureReason(how: KillHow): string {
  if (how === "moved") return "tmux renumbered its window while it was checked — nothing was killed, try again";
  if (how === "none") return "tmux can no longer place it in any session — nothing was killed";
  return "tmux still reports it live";
}
