// Typing a message into a codex pane and PROVING it went in.
//
// `sendToPane` is fire-and-forget: paste, Enter, done. Against codex that lost
// messages two ways. The text could land in the box and sit there unsubmitted,
// because the Enter was spent before codex had taken the paste in, or on a
// completion popup the message's own last word had opened. Or it never showed
// at all. Either way `send` reported success.
//
// So delivery here is a sequence of observations, each read back off the pane:
//
//   1. the box's contents BEFORE anything is typed;
//   2. one paste — never two — then the box until it holds the message, read
//      the same on two polls running (`pasteLanded`);
//   3. Enter, then the box until it EMPTIES, which is codex taking the message —
//      or until codex says it is HOLDING it for its startup, when the message
//      stays in the box as real text and runs once startup finishes. A box that
//      still holds exactly the paste after a while gets another Enter, on a
//      growing wait, a bounded number of times. A box that holds anything else
//      stops everything: codex rewrote the draft (a completion), and another
//      Enter would submit text the caller never wrote;
//   4. the pane leaving `Ready`, so the turn has visibly begun. Codex 0.163
//      echoes the message and empties the box while its bar still says `Ready`
//      for a few hundred milliseconds, and an `agendo wait` started in that gap
//      returned at once.
//
// Every failure is reported as what it is, and nothing is retyped.
import { codexComparable, codexComposerText, codexStartupHeld } from "./codex.ts";
import { capturePane, pasteToPane, pressEnter } from "./pane.ts";
import { paneReadiness } from "./paneReadiness.ts";
import type { Readiness } from "./readiness.ts";

/** Why a codex delivery did not go through. */
export type CodexDeliveryFailure =
  /** The box couldn't be read before typing, so nothing was typed. */
  | "unreadable"
  /** The paste was never seen to arrive in the box. No Enter was sent. */
  | "not-ingested"
  /** The box still held the message after every Enter. */
  | "not-submitted"
  /** Codex replaced the message with something else (a completion popup). */
  | "draft-rewritten"
  /** After an Enter the box could no longer be read, so nothing further was pressed. */
  | "lost-sight";

/** How one codex delivery went. */
export interface CodexDelivery {
  ok: boolean;
  reason?: CodexDeliveryFailure;
  /** Enter presses sent; 0 when the paste never landed. */
  enters: number;
  /**
   * Whether the pane left `Ready` once codex took the message. Null for a held
   * message (it runs once codex's startup finishes, so no turn has started) and
   * for a slash command that didn't, since those can run without starting one.
   */
  turnStarted: boolean | null;
  /** Codex is holding the message until its startup finishes; it runs then. */
  held: boolean;
  /** What the box held when we stopped, for the failure message. */
  composer: string | null;
}

/** The pane operations a delivery needs; injected so the sequence can be driven without tmux. */
export interface CodexIo {
  /** The pane's raw capture, SGR escapes intact. */
  read(): string;
  paste(text: string): void;
  enter(): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** The real thing: tmux against `target`. */
export function codexPaneIo(target: string): CodexIo {
  return {
    read: () => capturePane(target),
    paste: (text) => pasteToPane(target, text),
    enter: () => pressEnter(target),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/** Gap between reads of the pane. */
const POLL_MS = 100;

/**
 * How long the paste may take to show in the box. Codex took a 3,000-character
 * paste into an idle box in well under a poll; the slack is for a TUI busy
 * redrawing a long transcript when the paste arrives.
 */
export const CODEX_INGEST_MS = 5_000;

/**
 * How long to watch the box after each Enter before deciding that Enter was lost
 * and pressing another. Doubling, and the length of the list is the bound on
 * Enters. A taken Enter empties the box within a poll or two, so the first
 * window is already generous. A second Enter that lands after a slow first one
 * finds an empty box, where codex ignores it.
 */
export const CODEX_ENTER_WAITS_MS = [500, 1_000, 2_000, 4_000];

/**
 * How long to wait for the pane to leave `Ready` once the box has emptied. The
 * gap was about 360ms when captured.
 */
export const CODEX_TURN_START_MS = 5_000;

/** Verdicts that mean codex reacted to the message: a turn, or a prompt the turn raised. */
const TURN_STATES: ReadonlySet<Readiness> = new Set(["busy", "compacting", "dialog", "limited"]);

/** `[Pasted Content 3023 chars]`, codex's stand-in for a paste over about a thousand characters. */
const PASTED_PLACEHOLDER = /\[Pasted Content \d+ chars\]/g;

/**
 * The text to paste for `message`. Codex opens a completion popup while the caret
 * sits at the end of an `@file` or `$skill` token, and Enter then accepts the
 * highlighted completion instead of submitting — so a message ending in one gets
 * a trailing space, which closes the popup and changes nothing codex sends.
 */
export function codexPasteText(message: string): string {
  return /(^|\s)[@$]\S*$/.test(message) ? `${message} ` : message;
}

/**
 * Whether the box now holds the pasted `message` on top of what it held `before`.
 * Compared with whitespace removed (see codexComparable). Three shapes count:
 * the message at the end of the box, the END of the message when the box has
 * scrolled its start out of view, and one more `[Pasted Content N chars]`
 * stand-in than before. A paste lands in order, so a box showing only the
 * start of the message has not finished — though a start that happens to also
 * END the message (`ab` of `abcab`) passes here. awaitPaste's second, matching
 * read is what covers that: a paste still arriving changes between polls.
 */
export function pasteLanded(before: string, now: string, message: string): boolean {
  const was = codexComparable(before);
  const is = codexComparable(now);
  const msg = codexComparable(message);
  if (is === was || is === "") return false;
  if (is.endsWith(msg) || msg.endsWith(is)) return true;
  return placeholders(now) > placeholders(before);
}

function placeholders(text: string): number {
  return text.match(PASTED_PLACEHOLDER)?.length ?? 0;
}

/** What one read after an Enter says about it. */
export type SubmitView = "submitted" | "held" | "pending" | "rewritten" | "unreadable";

/**
 * Classify the box after an Enter against what it held when the paste landed:
 * held for startup is taken, and so is empty; unchanged is not yet; anything
 * else is a rewrite. `held` is the startup hold appearing after the Enter (see
 * deliverToCodex) — while it shows, the paste is MEANT to stay in the box, and
 * pressing Enter again for it would be pressing into a queue.
 */
export function submitView(pasted: string, now: string | null, held = false): SubmitView {
  if (held) return "held";
  if (now === null) return "unreadable";
  const is = codexComparable(now);
  if (is === "") return "submitted";
  return is === codexComparable(pasted) ? "pending" : "rewritten";
}

/** Type `message` into the codex pane behind `io` and confirm it was taken; see the top of this file. */
export async function deliverToCodex(io: CodexIo, message: string): Promise<CodexDelivery> {
  const screen = io.read();
  const before = codexComposerText(screen);
  if (before === null) return failed("unreadable", 0, null);
  io.paste(codexPasteText(message));
  const pasted = await awaitPaste(io, before, message);
  if (pasted.text === null) return failed("not-ingested", 0, pasted.last);
  // A hold already showing is someone else's message, and proves nothing about ours.
  const sub = await submit(io, pasted.text, !codexStartupHeld(screen));
  if (sub.view !== "submitted" && sub.view !== "held") return failed(SUBMIT_FAILURE[sub.view], sub.enters, sub.last);
  // Held is taken, but not started: it runs when codex's startup finishes. The
  // pane already reads busy, so a `wait` started now can't return early anyway.
  if (sub.view === "held") return { ok: true, enters: sub.enters, turnStarted: null, held: true, composer: sub.last };
  const started = await awaitTurn(io);
  // A slash command can run locally and leave the pane `Ready`, so not seeing a
  // turn after one says nothing either way.
  const turnStarted = started || !message.trimStart().startsWith("/") ? started : null;
  return { ok: true, enters: sub.enters, turnStarted, held: false, composer: "" };
}

const SUBMIT_FAILURE: Record<Exclude<SubmitView, "submitted" | "held">, CodexDeliveryFailure> = {
  pending: "not-submitted",
  rewritten: "draft-rewritten",
  unreadable: "lost-sight",
};

function failed(reason: CodexDeliveryFailure, enters: number, composer: string | null): CodexDelivery {
  return { ok: false, reason, enters, turnStarted: null, held: false, composer };
}

/** Poll until the paste has landed and held still for one poll; `text` is null on timeout. */
async function awaitPaste(io: CodexIo, before: string, message: string): Promise<{ text: string | null; last: string | null }> {
  const deadline = io.now() + CODEX_INGEST_MS;
  let landed: string | null = null;
  let last: string | null = before;
  do {
    await io.sleep(POLL_MS);
    last = codexComposerText(io.read());
    if (last !== null && pasteLanded(before, last, message)) {
      if (last === landed) return { text: last, last };
      landed = last;
    } else landed = null;
  } while (io.now() < deadline);
  return { text: null, last };
}

/**
 * Enter, then watch; again on a growing wait while the box still holds exactly
 * the paste. `holdCounts` is whether a startup hold may stand for "taken".
 */
async function submit(io: CodexIo, pasted: string, holdCounts: boolean): Promise<{ view: SubmitView; enters: number; last: string | null }> {
  let enters = 0;
  let seen: { view: SubmitView; last: string | null } = { view: "pending", last: pasted };
  for (const wait of CODEX_ENTER_WAITS_MS) {
    io.enter();
    enters++;
    seen = await watchSubmit(io, pasted, wait, holdCounts);
    if (seen.view !== "pending") break;
  }
  return { ...seen, enters };
}

/**
 * Watch the box for `wait` ms after one Enter. Taken returns at once. A rewrite
 * returns early only once it reads the same twice running, so a frame caught
 * mid-repaint can't end the delivery on its own. But whatever the LAST read says
 * stands: a rewrite there must not get another Enter (that would submit it), and
 * neither must a box we can no longer read (that could confirm whatever the
 * screen is showing instead).
 */
async function watchSubmit(io: CodexIo, pasted: string, wait: number, holdCounts: boolean): Promise<{ view: SubmitView; last: string | null }> {
  const deadline = io.now() + wait;
  let view: SubmitView = "pending";
  let last: string | null = pasted;
  let rewrite: string | null = null;
  do {
    await io.sleep(POLL_MS);
    const screen = io.read();
    last = codexComposerText(screen);
    view = submitView(pasted, last, holdCounts && codexStartupHeld(screen));
    if (view === "submitted" || view === "held" || (view === "rewritten" && last === rewrite)) break;
    rewrite = view === "rewritten" ? last : null;
  } while (io.now() < deadline);
  return { view, last };
}

/** Poll until the pane reads as a running turn (TURN_STATES), or give up. */
async function awaitTurn(io: CodexIo): Promise<boolean> {
  const deadline = io.now() + CODEX_TURN_START_MS;
  do {
    if (TURN_STATES.has(paneReadiness(io.read()))) return true;
    await io.sleep(POLL_MS);
  } while (io.now() < deadline);
  return false;
}
