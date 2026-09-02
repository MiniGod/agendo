import { PEER_SOCKET_ENV, peerSocketEnabled, resumeDialogChoice } from "../config.ts";
import { SELF_CMD, notRunningHint } from "../launch.ts";
import { printJson } from "../output.ts";
import { findPeer, type PeerSession, sendPeerMessage } from "../peer.ts";
import {
  answerResumeDialog, capturePane, capturePaneState, liveTargetForShortId, paneAcceptsPaste, paneReadiness,
  paneResumeDialogActive, paneResumeMenuSuspect, resumeDialogOption, sendToPane, shortId, stripAnsi,
  RESUME_DIALOG_POLL_MS, type LiveTarget, type PaneSnapshot, type Readiness,
} from "../tmux.ts";
import { flushWarnings } from "./warnings.ts";

/**
 * Poll `target` until it's genuinely at an empty input box (see
 * `paneAcceptsPaste` — a fresh capture each time, never an assumption), or null
 * on timeout. Used after answering the CLI's resume dialog, where the session
 * needs a moment to reload before its box comes back.
 *
 * TWO consecutive good reads are required, a poll apart. A reloading TUI paints
 * its box before it has finished restoring the conversation, and a paste into
 * that half-drawn screen can be discarded by the next full repaint — so the box
 * has to still be there a moment later to count.
 */
async function waitForInputBox(target: string, timeoutMs: number): Promise<PaneSnapshot | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  let settled = false;
  while (true) {
    const snap = capturePaneState(target);
    const ok = paneAcceptsPaste(snap.raw, snap.cursor);
    if (ok && settled) return snap;
    settled = ok;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(RESUME_DIALOG_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Send a prompt into a running session, resolved by id or tmux name.
 *
 * This is TWO jobs, and conflating them is the bug this shape exists to prevent:
 *
 *   1. ANSWERING claude's own resume dialog, when the pane is parked on one. Always
 *      tmux keystrokes. A socket frame arrives as a *peer* message — the receiver
 *      wraps it in "Another Claude session sent a message" and will NOT accept it as
 *      the answer to a pending prompt — so the socket cannot do this job at all.
 *   2. DELIVERING the message. Here the session's messaging socket (peer.ts) is
 *      preferred, and typing into the pane is the fallback for anything that exposes
 *      no socket: Copilot, and claude builds older than the peer protocol.
 *
 * The socket is an alternative for step 2 only, and never lets step 1 be skipped. A
 * session sitting on the resume dialog has not started yet, so a frame queued past it
 * would sit unread until a human answered the dialog — `send` would report success
 * and leave the session parked. So the dialog is answered first, on the pane,
 * whichever way the message then travels.
 *
 * One state reads "ready" without an input box behind it: that same resume dialog
 * (see paneResumeDialogActive). Because the pane path is keystroke injection — paste,
 * then Enter — a message delivered into that numbered menu would *pick an option*, so
 * we answer the dialog first and re-verify a real box appeared before pasting
 * anything. `--force` does NOT skip that: forcing a paste into a menu is precisely
 * the footgun, so a dialog that never clears is an error either way — and a menu that
 * only *looks* like it (a wrapped label, say, which the detector deliberately misses
 * rather than over-matches) refuses the forced paste too (paneResumeMenuSuspect).
 *
 * Past the dialog, most of the readiness gate applies to the pane path only, and that
 * asymmetry is the point: a paste lands in whatever is on screen, so it must first
 * prove the TUI is idle (`--force` overrides) or it clobbers a half-typed line. A
 * socket frame is queued by the receiver and read when it next reads input, so "busy"
 * and "queued" are not hazards over the socket — there is nothing to refuse. The pane
 * state is still captured and reported, so the caller sees what it walked into.
 *
 * `limited` is the exception that still refuses even though the socket would accept
 * the frame: a session at its usage cap will not read it until the cap resets, so
 * reporting success would be a lie, and orchestrators key on the exit-2 signal to
 * know to wait or call `unblock`. It is checked AFTER the dialog step on purpose —
 * the previous run's usage-limit notice is replayed above the resume dialog, so a
 * pane read before answering it can report "limited" about a run that already ended.
 * That gate reads the PANE, so it only fires for a session that has one: the registry
 * reports idle/busy/waiting/shell and has no way to say "at the cap", so a windowless
 * peer at its limit is queued to rather than refused. It will read the message on
 * reset; the exit code just can't warn about the delay.
 *
 * Whichever way it goes, the ROUTE is always named — `queued via socket` vs `pasted
 * into pane`, and `route` on `--json`. The two are not interchangeable and the caller
 * cannot infer which it got: the socket queues into a session that may be mid-turn,
 * the pane types into one that had to be idle first. A caller that assumed the wrong
 * one would either wait for a delivery that already happened or treat a refusal as
 * transient. Nothing about the session tells it apart afterwards, so `send` says.
 */
export async function runSend(token: string | undefined, prompt: string, force: boolean, dialogWaitMs: number, json: boolean): Promise<void> {
  if (!token || !prompt) usageExit();
  const ctx = await resolveSend(token, json);
  await ensureReachable(ctx);
  const pane = await answerDialogIfOpen(ctx, readPane(ctx.target), dialogWaitMs);
  await refuseLimited(ctx, pane, force);
  const socketFellBack = ctx.peer ? await deliverViaSocket(ctx, ctx.peer, prompt, pane) : false;
  await refusePaneNotReady(ctx, pane, force);
  await refuseMenuSuspect(ctx, pane);
  return pasteIntoPane(ctx, prompt, pane, socketFellBack);
}

/** How one run of `send` ended, for the `--json` payload. */
export interface SendOutcome {
  ok: boolean;
  /** "socket" means queued into a session that may be mid-turn, "pane" typed into one that had to be idle. */
  route: "socket" | "pane" | null;
  reason?: string;
  extra?: Record<string, unknown>;
}

/** What the token resolved to, and the two voices every step below speaks in. */
export interface SendContext {
  token: string;
  sid: string;
  target: LiveTarget | null;
  socket: ReturnType<typeof peerSocketEnabled>;
  peer: PeerSession | null;
  json: boolean;
  /**
   * A human progress line. Goes to stdout, which under --json is the payload's
   * alone — so suppressed there and carried in the payload's own fields instead.
   * Errors already go to stderr and are left there: a machine reader gets `ok`
   * and `reason`, a human tailing stderr still sees what went wrong.
   */
  say: (line: string) => void;
  /** Emit the machine payload (if asked) and exit. Every exit goes through this. */
  finish: (o: SendOutcome, code: number) => Promise<never>;
}

/** The pane as read (empty when there is none), its verdict, and what step 1 did to it. */
export interface PaneRead extends PaneSnapshot {
  readiness: Readiness | null;
  /** Whether step 1 actually had a dialog to answer — reported, since it means a turn started. */
  dialogAnswered: boolean;
}

export function usageExit(): never {
  console.error(`usage: ${SELF_CMD} send <id> "<prompt>" [--force] [--json] [--timeout <dur>]`);
  process.exit(1);
}

async function resolveSend(token: string, json: boolean): Promise<SendContext> {
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const target = liveTargetForShortId(sid);
  // The kill switch. Deliberately gating DISCOVERY and not just the write: with
  // it off, `send` must behave exactly as it did before the socket existed, and
  // a resolved-but-unused peer would still change the outcome — a windowless
  // session would be "reachable" right up to the point of refusing to deliver.
  const socket = peerSocketEnabled();
  if (socket.note) console.error(`▸ ${socket.note}.`);
  const peer = socket.enabled ? await findPeer((id) => shortId(id) === sid) : null;
  return sendContext({ token, sid, target, socket, peer, json });
}

/** Attach the two voices to a resolved session. */
export function sendContext(base: Omit<SendContext, "say" | "finish">): SendContext {
  function say(line: string): void {
    if (!base.json) console.log(line);
  }
  async function finish(o: SendOutcome, code: number): Promise<never> {
    if (base.json) await printJson(sendPayload(base, o));
    process.exit(code);
  }
  return { ...base, say, finish };
}

/** The `--json` payload: the outcome, the route, and where the session was found. */
export function sendPayload(base: Pick<SendContext, "sid" | "peer" | "target" | "socket">, o: SendOutcome): Record<string, unknown> {
  const { sid, target, socket } = base;
  const peer = base.peer ?? { sessionId: null, pid: null };
  return {
    ok: o.ok,
    // The whole point of the field: "socket" means queued into a session that
    // may be mid-turn, "pane" means typed into one that had to be idle.
    route: o.route,
    queued: o.route === "socket",
    id: sid,
    sessionId: peer.sessionId,
    target: target ? target.name : null,
    pid: peer.pid,
    socket: { enabled: socket.enabled, disabledBy: socket.enabled ? null : socket.source },
    ...(o.reason ? { reason: o.reason } : {}),
    ...o.extra,
  };
}

/**
 * A session reachable over its socket needs no window: it may be running
 * outside agendo entirely (a plain terminal, an editor). Requiring a tmux
 * target first would make `send` the one thing you cannot do to a session
 * that `status` reports as running.
 *
 * Two different failures wear the same shape here, and they need OPPOSITE
 * advice, so they must not share a message.
 *
 * With the socket on, no window and no peer means the session is genuinely
 * not running — and #38's hint exists precisely because the bare refusal
 * read as a death notice, so `resume` has to be named.
 *
 * With the socket OFF we never looked, and a session that is alive but
 * merely unreachable must NOT be told to `resume`: that would put a second
 * claude on one transcript, which `resume` itself refuses. So look now,
 * diagnostically. That is consistent with the switch's scope rather than a
 * hole in it — it stops us SPEAKING an undocumented protocol, not reading a
 * registry file, which is the same reason `status` keeps its peer lines.
 */
export async function ensureReachable(ctx: SendContext): Promise<void> {
  const { target, peer, socket, token, sid } = ctx;
  if (target || peer) return;
  const unreachable = socket.enabled ? null : await findPeer((id) => shortId(id) === sid);
  if (unreachable) return refuseUnreachable(ctx, unreachable);
  // Genuinely gone — by either route, whatever the switch says. Describing this
  // one as "switched off" would send the caller to unset a variable that would
  // change nothing, instead of to the command that actually brings it back.
  console.error(`Session ${token} is not running (no live tmux window and no messaging socket).`);
  console.error(notRunningHint(token, "then send again"));
  return ctx.finish({ ok: false, route: null, reason: "not-running" }, 1);
}

export function refuseUnreachable(ctx: SendContext, peer: PeerSession): Promise<never> {
  const by = ctx.socket.source === "env" ? PEER_SOCKET_ENV : `"peerSocket": false in config.json`;
  console.error(`Session ${ctx.token} IS running (pid ${peer.pid}), but unreachable: it has no tmux window, and the messaging socket is disabled (${by}).`);
  console.error(
    `  Re-enable it for one command with \`${PEER_SOCKET_ENV}=1 ${SELF_CMD} send ${ctx.token} "…"\`, or attach to it\n` +
      `  yourself. Do NOT resume it — it is already running, and a second session on one transcript is\n` +
      `  exactly what \`${SELF_CMD} resume\` refuses.`,
  );
  return ctx.finish({ ok: false, route: null, reason: "socket-disabled", extra: { pid: peer.pid, sessionId: peer.sessionId } }, 1);
}

/**
 * Pane state only exists when there IS a pane. Where it exists it is what the
 * dialog step reads — that step is not advisory, and only a pane can satisfy it.
 */
function readPane(target: LiveTarget | null): PaneRead {
  if (!target) return { raw: "", cursor: null, readiness: null, dialogAnswered: false };
  const snap = capturePaneState(target.target);
  return { ...snap, readiness: paneReadiness(snap.raw, snap.cursor), dialogAnswered: false };
}

/**
 * Step 1: answer claude's resume dialog. Keystrokes only, and BEFORE any
 * delivery — a queued frame can't answer it, and a session parked here hasn't
 * started, so delivering past it would strand the message. Returns the pane as
 * it settled afterwards, or the read untouched when there was no dialog.
 */
async function answerDialogIfOpen(ctx: SendContext, pane: PaneRead, dialogWaitMs: number): Promise<PaneRead> {
  const { target } = ctx;
  if (!target || !paneResumeDialogActive(pane.raw)) return pane;
  const choice = resumeDialogChoice();
  // Reading the config can report-and-ignore a malformed config.json, and this
  // is the one command that ACTS on that file's value. Silently falling back to
  // the default while pressing a key into a live session is exactly the case
  // that warning exists for, so drain it here as `list` does for its own loads.
  flushWarnings("send");
  const option = resumeDialogOption(pane.raw, choice);
  if (!option) {
    return refuseDialog(ctx, "resume-dialog-unanswerable", `Not sending: claude's resume dialog is open but no "${choice}" option was found — answer it yourself, then retry.`);
  }
  ctx.say(`▸ answering claude's resume dialog (${choice}): ${option.number}. ${option.label}`);
  if (!selectOption(target.target, option)) {
    return refuseDialog(
      ctx,
      "resume-dialog-unanswered",
      `Not sending: couldn't select "${option.label}" on claude's resume dialog (the pane isn't responding to the ` +
        `selection keys). Nothing was pasted — answer it yourself, then retry.`,
    );
  }
  const settled = await waitForInputBox(target.target, dialogWaitMs);
  if (!settled) return refuseDialog(ctx, "no-input-box", noInputBoxMessage(ctx.token, dialogWaitMs));
  return { ...settled, readiness: paneReadiness(settled.raw, settled.cursor), dialogAnswered: true };
}

/**
 * Press the option's keys; false when nothing was confirmed and the menu is
 * still up — the cursor wouldn't move, or we couldn't read it. The caller stops
 * there rather than wait out the whole timeout; either way not one character of
 * the message has been sent.
 */
function selectOption(target: string, option: NonNullable<ReturnType<typeof resumeDialogOption>>): boolean {
  return answerResumeDialog(target, option) || !paneResumeDialogActive(capturePane(target));
}

export function noInputBoxMessage(token: string, dialogWaitMs: number): string {
  return (
    `Not sending: answered claude's resume dialog but no input box appeared within ${Math.round(dialogWaitMs / 1000)}s — ` +
    `nothing was delivered by EITHER route (a message typed into that menu would pick an option, and queueing ` +
    `one past an unanswered dialog would strand it — the socket does not shorten this wait). This is ordinary ` +
    `right after a resume, where the session may compact before its input exists: WAIT AND RETRY (or raise ` +
    `--timeout). --force cannot help — it never pastes into that menu. Re-check with \`${SELF_CMD} status ${token}\`.`
  );
}

/** A step-1 refusal: nothing was delivered, and the payload says a dialog was in the way. */
export function refuseDialog(ctx: SendContext, reason: string, message: string): Promise<never> {
  console.error(message);
  return ctx.finish({ ok: false, route: null, reason, extra: { resumeDialog: true } }, 2);
}

/**
 * Step 2 begins here. Checked only now: the previous run's usage-limit notice is
 * replayed above the resume dialog, so reading this before step 1 could refuse on
 * a cap that belonged to the run that already ended.
 */
export async function refuseLimited(ctx: SendContext, pane: PaneRead, force: boolean): Promise<void> {
  if (pane.readiness !== "limited" || force) return;
  console.error(`Not sending: session is at its usage limit. Wait for the reset, \`${SELF_CMD} unblock ${ctx.token}\`, or pass --force.`);
  return ctx.finish({ ok: false, route: null, reason: "limited", extra: { state: pane.readiness, resumeDialog: pane.dialogAnswered } }, 2);
}

/**
 * The session's state in whichever vocabulary applies — the pane classifier's
 * ("ready", "compacting") when there is a pane, the receiver's own ("idle",
 * "busy", "waiting") when there is not.
 */
export function socketState(pane: Pick<PaneRead, "readiness">, peer: Pick<PeerSession, "status">): string {
  return pane.readiness ?? peer.status ?? "running";
}

/** The progress line for a frame that went out. Both spellings of idle count as "no need to warn". */
export function queuedLine(target: LiveTarget | null, peer: Pick<PeerSession, "pid">, state: string): string {
  const where = target ? target.name : `pid ${peer.pid}`;
  const idle = state === "ready" || state === "idle";
  return `▸ queued via socket to ${where}${idle ? "" : ` (session is "${state}"; it will be delivered when it next reads input)`}`;
}

/**
 * Deliver over the socket. Exits on success; returns true when the socket was
 * advertised but unusable and there is a pane to fall back to — the session
 * died between discovery and send, or something else holds the path.
 */
async function deliverViaSocket(ctx: SendContext, peer: PeerSession, prompt: string, pane: PaneRead): Promise<boolean> {
  try {
    await sendPeerMessage(peer, prompt);
  } catch (e) {
    return socketFailed(ctx, e as Error);
  }
  const state = socketState(pane, peer);
  ctx.say(queuedLine(ctx.target, peer, state));
  // A menu the detector wouldn't fully match was left standing (step 1 only
  // acts on an exact match). Queueing past it is safe where a paste is not —
  // a frame cannot pick an option — but nothing reads the queue until someone
  // answers it, so don't let "queued" read as "the session acted on it".
  const suspect = paneResumeMenuSuspect(pane.raw);
  if (suspect) console.error(`  note: the pane looks like a resume menu agendo won't answer, so the message waits until you do.`);
  return ctx.finish({ ok: true, route: "socket", extra: { state, resumeDialog: pane.dialogAnswered, unreadUntilAnswered: suspect } }, 0);
}

export async function socketFailed(ctx: SendContext, e: Error): Promise<boolean> {
  if (!ctx.target) {
    console.error(`Failed to reach the session socket (${e.message}), and it has no tmux window to type into.`);
    return ctx.finish({ ok: false, route: null, reason: "socket-unusable" }, 1);
  }
  console.error(`▸ session socket unusable (${e.message}); falling back to the tmux pane.`);
  return true;
}

/** The pane gate: a paste lands in whatever is on screen, so the TUI must be idle first (`--force` overrides). */
export async function refusePaneNotReady(ctx: SendContext, pane: PaneRead, force: boolean): Promise<void> {
  if (pane.readiness === "ready" || force) return;
  console.error(`Not sending: session looks "${pane.readiness}", not ready. Re-check with \`${SELF_CMD} status ${ctx.token}\`, or pass --force.`);
  console.error(`\n  current screen (tail):`);
  for (const l of stripAnsi(pane.raw).split("\n").filter((x) => x.trim()).slice(-12)) console.error(`    ${l}`);
  return ctx.finish({ ok: false, route: null, reason: "pane-not-ready", extra: { state: pane.readiness, resumeDialog: pane.dialogAnswered } }, 2);
}

/**
 * The one thing --force may not do. If the pane is showing something that
 * looks like the resume menu but the detector didn't fully match it (a wrapped
 * label, reworded footer, changed option set), step 1 never ran — and a forced
 * paste would type the message INTO that menu, where its digits pick options
 * and the trailing Enter confirms one. (The socket path returned long before
 * this: queueing a frame can't pick an option, so this gate is about pasting
 * specifically, not about reaching a parked session at all.)
 */
export async function refuseMenuSuspect(ctx: SendContext, pane: PaneRead): Promise<void> {
  if (!paneResumeMenuSuspect(pane.raw)) return;
  console.error(
    `Not sending: the pane looks like claude's resume menu but doesn't match it exactly, so agendo won't answer it ` +
      `and --force won't paste into it (the message would pick an option). Answer it yourself, then retry.`,
  );
  return ctx.finish({ ok: false, route: null, reason: "resume-menu-suspect", extra: { state: pane.readiness, resumeDialog: pane.dialogAnswered } }, 2);
}

/**
 * Why the pane route, where it isn't obvious. A caller that expected the socket
 * needs to know it got keystroke semantics instead: the message is in the pane
 * NOW, and it was only allowed there because the pane was idle (or --force said
 * to anyway).
 */
export function pasteWhy(socketFellBack: boolean, socket: Pick<SendContext["socket"], "enabled" | "source">): string {
  if (socketFellBack) return " (socket fallback)";
  if (socket.enabled) return "";
  return ` (socket disabled by ${socket.source === "env" ? PEER_SOCKET_ENV : "config"})`;
}

function pasteIntoPane(ctx: SendContext, prompt: string, pane: PaneRead, socketFellBack: boolean): Promise<never> {
  const target = ctx.target!; // non-null: reaching here means the peer path didn't return
  sendToPane(target.target, prompt);
  ctx.say(`▸ pasted into pane ${target.name}${pasteWhy(socketFellBack, ctx.socket)}${pane.readiness !== "ready" ? ` (forced; was "${pane.readiness}")` : ""}`);
  return ctx.finish({ ok: true, route: "pane", extra: { state: pane.readiness, resumeDialog: pane.dialogAnswered, socketFellBack } }, 0);
}
