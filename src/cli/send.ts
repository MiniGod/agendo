import { PEER_SOCKET_ENV, peerSocketEnabled, resumeDialogChoice } from "../config.ts";
import { SELF_CMD, notRunningHint } from "../launch.ts";
import { printJson } from "../output.ts";
import { findPeer, sendPeerMessage } from "../peer.ts";
import { locateEverywhere } from "../remoteSessions.ts";
import { knownHost } from "../remote.ts";
import { parseRemoteFlag } from "./args.ts";
import { parseDuration } from "../wait.ts";
import {
  answerResumeDialog, capturePane, capturePaneState, paneAcceptsPaste, paneReadiness,
  paneResumeDialogActive, paneResumeMenuSuspect, resumeDialogOption, sendToPane, shortId, stripAnsi,
  RESUME_DIALOG_POLL_MS, RESUME_DIALOG_WAIT_MS, type LiveTarget, type PaneSnapshot, type Readiness,
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
async function waitForInputBox(target: string, timeoutMs: number, host: string | null): Promise<PaneSnapshot | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + timeoutMs;
  let settled = false;
  while (true) {
    const snap = capturePaneState(target, host);
    const ok = paneAcceptsPaste(snap.raw, snap.cursor);
    if (ok && settled) return snap;
    settled = ok;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(RESUME_DIALOG_POLL_MS, Math.max(0, deadline - Date.now())));
  }
}

/**
 * Say why `send` found nothing to send to, and how to fix it.
 *
 * Two different failures wear the same shape here and need OPPOSITE advice, so
 * they must not share a message.
 *
 * With the socket ON, no window and no peer means the session is genuinely not
 * running — and #38's hint exists precisely because the bare refusal read as a
 * death notice, so `resume` has to be named.
 *
 * With the socket OFF we never looked, and a session that is alive but merely
 * unreachable must NOT be told to `resume`: that would put a second claude on
 * one transcript, which `resume` itself refuses. So look now, diagnostically.
 * That is consistent with the switch's scope rather than a hole in it — it stops
 * us SPEAKING an undocumented protocol, not reading a registry file, which is
 * the same reason `status` keeps its peer lines.
 */
async function diagnoseNotRunning(
  token: string,
  sid: string,
  socket: { enabled: boolean; source: string },
  unreachableMachines: string[],
): Promise<{ reason: string; extra?: Record<string, unknown>; code: number }> {
  // A machine we could not REACH is not a session that is not running, and the
  // two need opposite advice. "Not running" sends the caller to `resume`, which
  // here would be wrong twice over: the session is probably alive on the far
  // machine, and resuming would do it on THIS one, against a transcript that is
  // not here. This is the transport-vs-tmux distinction the exit statuses were
  // designed around (docs/remote-machines.md §11.1), arriving where it counts.
  if (unreachableMachines.length > 0) {
    // "Could not determine", not "could not be reached": the sweep folds three
    // different failures into one warning list (unreachable host, no beam here,
    // no tmux there), and only the first is a network problem. What they share
    // is the only thing this message needs to say — agendo does not know.
    console.error(
      `Not sending: ${token} was not found here, and agendo could not determine whether it is running on ` +
        `${unreachableMachines.length === 1 ? "the machine it could not read" : `the ${unreachableMachines.length} machines it could not read`}. ` +
        `Do NOT resume it — that would start a second session, here, against a transcript that may not be here. Retry once the machine answers.`,
    );
    return { reason: "machine-unreachable", extra: { unreachable: unreachableMachines }, code: 1 };
  }
  const unreachable = socket.enabled ? null : await findPeer((id) => shortId(id) === sid);
  if (unreachable) {
    const by = socket.source === "env" ? PEER_SOCKET_ENV : `"peerSocket": false in config.json`;
    console.error(`Session ${token} IS running (pid ${unreachable.pid}), but unreachable: it has no tmux window, and the messaging socket is disabled (${by}).`);
    console.error(
      `  Re-enable it for one command with \`${PEER_SOCKET_ENV}=1 ${SELF_CMD} send ${token} "…"\`, or attach to it\n` +
        `  yourself. Do NOT resume it — it is already running, and a second session on one transcript is\n` +
        `  exactly what \`${SELF_CMD} resume\` refuses.`,
    );
    return { reason: "socket-disabled", extra: { pid: unreachable.pid, sessionId: unreachable.sessionId }, code: 1 };
  }
  // Genuinely gone — by either route, whatever the switch says. Describing this
  // one as "switched off" would send the caller to unset a variable that would
  // change nothing, instead of to the command that actually brings it back.
  console.error(`Session ${token} is not running (no live tmux window and no messaging socket).`);
  console.error(notRunningHint(token, "then send again"));
  return { reason: "not-running", code: 1 };
}

/**
 * Resolve `sid` to exactly one live window, across machines when asked.
 *
 * Without `--remote` this is the local lookup `send` always did, and no beam is
 * spawned.
 *
 * MORE THAN ONE MATCH IS A REFUSAL, not a preference. The same session resumed
 * on two machines carries the same `cl-<source>-<shortid>` window name on both,
 * so "prefer local" would type into a session other than the one the caller
 * named — silently, and into a live agent. `close` sets the precedent for the
 * same reason: enumerate and refuse. `--remote=<machine>` narrows it.
 *
 * No match is NOT decided here: `send` can still reach a session over its peer
 * socket with no window at all, and the diagnosis for "genuinely gone" belongs
 * with that.
 */
function locateOne(
  token: string,
  sid: string,
  remote: string[] | null,
): { target: LiveTarget | null; host: string | null; unreachable: string[] } {
  // A NAMED machine is exclusive here, unlike in a listing: `--remote=vm` is the
  // answer to "which one did you mean", so folding this machine back in would
  // make the disambiguation it performs impossible. A bare `--remote` stays
  // additive, and is the spelling that can be ambiguous.
  const includeLocal = remote === null || remote.length === 0;
  const { found, warnings } = locateEverywhere(sid, remote, includeLocal);
  for (const w of warnings) console.error(`warning: ${w}`);
  if (found.length > 1) {
    const where = found.map((f) => f.host ?? "local").join(", ");
    console.error(
      `Not sending: ${token} matches a live session on ${found.length} machines (${where}) — agendo can't tell ` +
        `which one you mean. Narrow it with \`--remote=<machine>\`, or drop --remote to mean this machine.`,
    );
    process.exit(2);
  }
  const one = found[0];
  return { target: one?.target ?? null, host: one?.host ?? null, unreachable: warnings };
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
export async function runSend(token: string | undefined, prompt: string, force: boolean, dialogWaitMs: number, json: boolean, remote: string[] | null = null): Promise<void> {
  if (!token || !prompt) {
    console.error(`usage: ${SELF_CMD} send <id> "<prompt>" [--force] [--json] [--timeout <dur>]`);
    process.exit(1);
  }
  // Human progress lines go to stdout, which under --json is the payload's alone —
  // so they're suppressed there and carried in the payload's own fields instead.
  // Errors already go to stderr and are left there: a machine reader gets `ok`
  // and `reason`, a human tailing stderr still sees what went wrong.
  const say = (line: string) => { if (!json) console.log(line); };
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const { target, host, unreachable } = locateOne(token, sid, remote);
  // The kill switch. Deliberately gating DISCOVERY and not just the write: with
  // it off, `send` must behave exactly as it did before the socket existed, and
  // a resolved-but-unused peer would still change the outcome — a windowless
  // session would be "reachable" right up to the point of refusing to deliver.
  // The peer socket is a unix socket in THIS machine's $XDG_RUNTIME_DIR. It does
  // not cross a machine boundary, and a local peer answering for a remote id
  // would be a different session entirely — so a resolved remote target skips
  // discovery altogether rather than risking that match.
  const socket = host === null ? peerSocketEnabled() : { enabled: false, note: null, source: "remote" as const };
  if (socket.note) console.error(`▸ ${socket.note}.`);
  const peer = socket.enabled ? await findPeer((id) => shortId(id) === sid) : null;
  const routeInfo = { enabled: socket.enabled, disabledBy: socket.enabled ? null : socket.source };
  /** Emit the machine payload (if asked) and exit. Every exit below goes through this. */
  const finish = async (o: { ok: boolean; route: "socket" | "pane" | null; reason?: string; extra?: Record<string, unknown> }, code: number): Promise<never> => {
    if (json) {
      await printJson({
        ok: o.ok,
        // The whole point of the field: "socket" means queued into a session that
        // may be mid-turn, "pane" means typed into one that had to be idle.
        route: o.route,
        queued: o.route === "socket",
        id: sid,
        sessionId: peer?.sessionId ?? null,
        target: target ? target.name : null,
        pid: peer?.pid ?? null,
        socket: routeInfo,
        ...(o.reason ? { reason: o.reason } : {}),
        ...o.extra,
      });
    }
    process.exit(code);
  };
  // A session reachable over its socket needs no window: it may be running
  // outside agendo entirely (a plain terminal, an editor). Requiring a tmux
  // target first would make `send` the one thing you cannot do to a session
  // that `status` reports as running.
  if (!target && !peer) {
    const gone = await diagnoseNotRunning(token, sid, socket, unreachable);
    return finish({ ok: false, route: null, reason: gone.reason, extra: gone.extra }, gone.code);
  }
  /** Whether step 1 actually had a dialog to answer — reported, since it means a turn started. */
  let dialogAnswered = false;
  /** Whether a peer was found and its socket then failed, so the pane route is a fallback. */
  let socketFellBack = false;
  // Pane state only exists when there IS a pane. Where it exists it is what the
  // dialog step below reads — that step is not advisory, and only a pane can
  // satisfy it.
  let { raw, cursor }: PaneSnapshot = target ? capturePaneState(target.target, host) : { raw: "", cursor: null };
  let readiness: Readiness | null = target ? paneReadiness(raw, cursor) : null;
  // ── Step 1: answer claude's resume dialog. Keystrokes only, and BEFORE any
  // delivery — a queued frame can't answer it, and a session parked here hasn't
  // started, so delivering past it would strand the message.
  if (target && paneResumeDialogActive(raw)) {
    const choice = resumeDialogChoice();
    // Reading the config can report-and-ignore a malformed config.json, and this
    // is the one command that ACTS on that file's value. Silently falling back to
    // the default while pressing a key into a live session is exactly the case
    // that warning exists for, so drain it here as `list` does for its own loads.
    flushWarnings("send");
    const option = resumeDialogOption(raw, choice);
    if (!option) {
      console.error(`Not sending: claude's resume dialog is open but no "${choice}" option was found — answer it yourself, then retry.`);
      return finish({ ok: false, route: null, reason: "resume-dialog-unanswerable", extra: { resumeDialog: true } }, 2);
    }
    say(`▸ answering claude's resume dialog (${choice}): ${option.number}. ${option.label}`);
    dialogAnswered = true;
    // Nothing was confirmed and the menu is still up — the cursor wouldn't move,
    // or we couldn't read it. Stop here rather than wait out the whole timeout;
    // either way not one character of the message has been sent.
    if (!answerResumeDialog(target.target, option, host) && paneResumeDialogActive(capturePane(target.target, host))) {
      console.error(
        `Not sending: couldn't select "${option.label}" on claude's resume dialog (the pane isn't responding to the ` +
          `selection keys). Nothing was pasted — answer it yourself, then retry.`,
      );
      return finish({ ok: false, route: null, reason: "resume-dialog-unanswered", extra: { resumeDialog: true } }, 2);
    }
    const settled = await waitForInputBox(target.target, dialogWaitMs, host);
    if (!settled) {
      console.error(
        `Not sending: answered claude's resume dialog but no input box appeared within ${Math.round(dialogWaitMs / 1000)}s — ` +
          `nothing was delivered by EITHER route (a message typed into that menu would pick an option, and queueing ` +
          `one past an unanswered dialog would strand it — the socket does not shorten this wait). This is ordinary ` +
          `right after a resume, where the session may compact before its input exists: WAIT AND RETRY (or raise ` +
          `--timeout). --force cannot help — it never pastes into that menu. Re-check with \`${SELF_CMD} status ${token}\`.`,
      );
      return finish({ ok: false, route: null, reason: "no-input-box", extra: { resumeDialog: true } }, 2);
    }
    ({ raw, cursor } = settled);
    readiness = paneReadiness(raw, cursor);
  }
  // ── Step 2: deliver. Checked only now: the previous run's usage-limit notice is
  // replayed above the resume dialog, so reading this before step 1 could refuse on
  // a cap that belonged to the run that already ended.
  if (readiness === "limited" && !force) {
    console.error(`Not sending: session is at its usage limit. Wait for the reset, \`${SELF_CMD} unblock ${token}\`, or pass --force.`);
    return finish({ ok: false, route: null, reason: "limited", extra: { state: readiness, resumeDialog: dialogAnswered } }, 2);
  }
  if (peer) {
    const where = target ? target.name : `pid ${peer.pid}`;
    // Each path names the state in its own vocabulary — the pane classifier's
    // ("ready", "compacting") when there is a pane, the receiver's own
    // ("idle", "busy", "waiting") when there is not. Both spell idle-ness
    // differently, so both spellings count as "no need to warn".
    const state = readiness ?? peer.status ?? "running";
    const idle = state === "ready" || state === "idle";
    try {
      await sendPeerMessage(peer, prompt);
      say(`▸ queued via socket to ${where}${idle ? "" : ` (session is "${state}"; it will be delivered when it next reads input)`}`);
      // A menu the detector wouldn't fully match was left standing (step 1 only
      // acts on an exact match). Queueing past it is safe where a paste is not —
      // a frame cannot pick an option — but nothing reads the queue until someone
      // answers it, so don't let "queued" read as "the session acted on it".
      const suspect = paneResumeMenuSuspect(raw);
      if (suspect) {
        console.error(
          `  note: the pane looks like a resume menu agendo won't answer, so the message waits until you do.`,
        );
      }
      return finish({ ok: true, route: "socket", extra: { state, resumeDialog: dialogAnswered, unreadUntilAnswered: suspect } }, 0);
    } catch (e) {
      // The socket was advertised but unusable — the session died between
      // discovery and send, or something else holds the path.
      if (!target) {
        console.error(`Failed to reach the session socket (${(e as Error).message}), and it has no tmux window to type into.`);
        return finish({ ok: false, route: null, reason: "socket-unusable" }, 1);
      }
      console.error(`▸ session socket unusable (${(e as Error).message}); falling back to the tmux pane.`);
      socketFellBack = true;
    }
  }
  if (readiness !== "ready" && !force) {
    console.error(`Not sending: session looks "${readiness}", not ready. Re-check with \`${SELF_CMD} status ${token}\`, or pass --force.`);
    console.error(`\n  current screen (tail):`);
    for (const l of stripAnsi(raw).split("\n").filter((x) => x.trim()).slice(-12)) console.error(`    ${l}`);
    return finish({ ok: false, route: null, reason: "pane-not-ready", extra: { state: readiness, resumeDialog: dialogAnswered } }, 2);
  }
  // The one thing --force may not do. If the pane is showing something that
  // looks like the resume menu but the detector didn't fully match it (a wrapped
  // label, reworded footer, changed option set), the branch above never ran —
  // and a forced paste would type the message INTO that menu, where its digits
  // pick options and the trailing Enter confirms one. (The socket path returned
  // long before this: queueing a frame can't pick an option, so this gate is
  // about pasting specifically, not about reaching a parked session at all.)
  if (paneResumeMenuSuspect(raw)) {
    console.error(
      `Not sending: the pane looks like claude's resume menu but doesn't match it exactly, so agendo won't answer it ` +
        `and --force won't paste into it (the message would pick an option). Answer it yourself, then retry.`,
    );
    return finish({ ok: false, route: null, reason: "resume-menu-suspect", extra: { state: readiness, resumeDialog: dialogAnswered } }, 2);
  }
  sendToPane(target!.target, prompt, host); // non-null: reaching here means the peer path didn't return
  // Name the route, and — where it isn't obvious — why this one. A caller that
  // expected the socket needs to know it got keystroke semantics instead: this
  // message is in the pane NOW, and it was only allowed there because the pane
  // was idle (or --force said to anyway).
  // Name the reason the socket wasn't used, and name it correctly: a remote
  // target skipped it because a unix socket does not cross a machine boundary,
  // which is not the same fact as "you turned it off" and would send a reader to
  // change a setting that would not have helped.
  const noSocket = socket.source === "remote"
    ? ` (over ${host})`
    : ` (socket disabled by ${socket.source === "env" ? PEER_SOCKET_ENV : "config"})`;
  const why = socketFellBack ? " (socket fallback)" : !socket.enabled ? noSocket : "";
  say(`▸ pasted into pane ${target!.name}${why}${readiness !== "ready" ? ` (forced; was "${readiness}")` : ""}`);
  return finish({ ok: true, route: "pane", extra: { state: readiness, resumeDialog: dialogAnswered, socketFellBack } }, 0);
}

/**
 * `agendo send` argv → one delivered (or refused) message.
 *
 * Parsed beside the command for the same reason `list`'s is: `--remote` is the
 * flag that pushed index.tsx back over its `max-lines` cap, and a command's
 * flags belong with the command.
 */
export async function runSendCli(argv: string[]): Promise<void> {

let id: string | undefined;
let force = false;
// How long to wait for the input box to come back after answering claude's
// resume dialog (only used on that path).
let dialogWaitMs = RESUME_DIALOG_WAIT_MS;
let json = false;
let remote: string[] | null = null;
const parts: string[] = [];
const rest = argv;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--force" || a === "-f") force = true;
  // Recognized anywhere in argv, as --force already is: both are valueless, so
  // neither can swallow a word of the prompt, and `--` still passes either
  // spelling through literally.
  else if (a === "--json") json = true;
  // Valueless in both spellings (`--remote`, `--remote=<machine>`), so like
  // --force it cannot swallow a word of the prompt and is recognized anywhere.
  // The "did you mean --remote=x" hint is deliberately NOT armed here: the
  // token after a bare --remote is ordinarily the id or the prompt, and only
  // `list`/the launcher have a positional it could be confused with.
  else if (a === "--remote" || a.startsWith("--remote=")) {
    remote = parseRemoteFlag("send", a, undefined, remote, knownHost);
  }
  // Only before the prompt begins: unlike --force, this flag consumes the NEXT
  // token, so recognizing it mid-prompt would eat a word of the message. Shares
  // `wait`'s duration grammar (and its parser, which lives in wait.ts) so the
  // two commands can't drift into accepting different spellings of "2s".
  else if (a === "--timeout" && parts.length === 0) {
    const ms = parseDuration(rest[++i]);
    if (ms === null) {
      console.error(`send: --timeout needs a duration like 500ms, 2s, 5m, 1h (got "${rest[i] ?? ""}")`);
      process.exit(1);
    }
    dialogWaitMs = ms;
  }
  else if (a === "--") { parts.push(...rest.slice(i + 1)); break; }
  else if (id === undefined) id = a;
  else parts.push(a);
}
await runSend(id, parts.join(" ").trim(), force, dialogWaitMs, json, remote);
process.exit(0);
}
