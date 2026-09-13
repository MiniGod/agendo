// The I/O boundary: reading a pane's visible screen and writing keystrokes back
// into it. Everything that CLASSIFIES what was read lives in the parsing modules
// next door (readiness/inputBox/dialog/chrome/codex), all of which sit on top of
// this one and none of which this one knows about.
import { spawnSync } from "child_process";
import { sleepSync, tmuxQuiet } from "./exec.ts";

/**
 * Raw visible text of a target's active pane, or null when tmux could not read
 * it at all (unresolvable target, a pane that exited between the listing and
 * this call, a server too busy to answer). That is NOT the same as a pane that
 * is simply blank, and a caller about to do something destructive has to tell
 * the two apart — see `readPaneState`.
 */
function capturePaneRaw(target: string): string | null {
  const r = spawnSync("tmux", ["capture-pane", "-p", "-e", "-t", target], { encoding: "utf-8" });
  return r.status === 0 ? (r.stdout ?? "") : null;
}

/** Raw visible text of a target's active pane, including SGR escape codes. */
export function capturePane(target: string): string {
  return capturePaneRaw(target) ?? "";
}

/**
 * Where a pane's caret sits, in pane-relative cells: row 0 is the top visible
 * row — the same origin `capture-pane` uses for its first output line — so `y`
 * indexes straight into a capture's lines.
 */
export interface PaneCursor {
  x: number;
  y: number;
}

/**
 * Cursor position of a target's active pane, or null when tmux can't report it
 * (no such target, or a stub/older tmux that doesn't answer the format). Callers
 * treat null as "no cursor evidence" and fall back to the color-based read — see
 * `inputEmpty`.
 */
function paneCursor(target: string): PaneCursor | null {
  const r = spawnSync("tmux", ["display-message", "-p", "-t", target, "#{cursor_x} #{cursor_y}"], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const m = (r.stdout ?? "").trim().match(/^(\d+)\s+(\d+)$/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

/** A pane's visible text paired with the caret position captured alongside it. */
export interface PaneSnapshot {
  /** `capture-pane -p -e` output — SGR escapes intact. */
  raw: string;
  /** Caret position, or null when tmux couldn't report one. */
  cursor: PaneCursor | null;
}

/**
 * Snapshot a pane: its visible text plus its caret. Every call site that judges
 * readiness should use this rather than a bare `capturePane`, since the caret is
 * half the evidence (see `inputEmpty`).
 *
 * Two separate tmux reads, so the halves can be skewed by whatever the pane did
 * in between — including a paint in progress, which parks the grid cursor
 * wherever the TUI's output stream has reached rather than where it will rest.
 * That makes the caret a BEST-EFFORT signal, not a proof: `inputEmpty` accepts it
 * only at the exact resting column of an untouched prompt, which is the narrowest
 * test that still recognizes a suggestion, not an airtight one. tmux can serve
 * both reads in one invocation (`display-message … \; capture-pane …`); kept as
 * two calls because `display-message` is a cheap one-line read next to dumping
 * the whole screen, and the combined form's output shape is one more thing to get
 * wrong.
 */
export function capturePaneState(target: string): PaneSnapshot {
  return { raw: capturePane(target), cursor: paneCursor(target) };
}

/**
 * `capturePaneState`, but null when tmux could not read the pane AT ALL rather
 * than an empty snapshot.
 *
 * The distinction only matters where a missing read is dangerous. Readiness is
 * classified from the screen, and an empty screen classifies as `unknown` — fine
 * for a caller that only reports it, wrong for one that acts on it: `agendo
 * close` treats `unknown` as "nothing in flight", so a read that merely FAILED
 * would silently disarm the guard and kill a session mid-turn. Callers that just
 * display a state keep using `capturePaneState`.
 */
export function readPaneState(target: string): PaneSnapshot | null {
  const raw = capturePaneRaw(target);
  return raw === null ? null : { raw, cursor: paneCursor(target) };
}

/** Strip ANSI SGR escape sequences, for plain-text display / matching. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Type `text` into a target pane and submit it. Uses a bracketed paste so the
 * claude TUI receives multi-line text as one paste (newlines don't submit
 * early), then a single Enter to send.
 */
export function sendToPane(target: string, text: string): void {
  tmuxQuiet(["set-buffer", "-b", "cl-send", "--", text]);
  tmuxQuiet(["paste-buffer", "-p", "-d", "-b", "cl-send", "-t", target]);
  tmuxQuiet(["send-keys", "-t", target, "Enter"]);
}

/**
 * The tmux `send-keys` argv sequence that nudges a usage-limited session to
 * resume: press Escape, type `continue`, then Enter. `-l` forces "continue" to be
 * sent as literal characters, not looked up as a key name. Split from the runner
 * (`sendResume`) so it can be asserted directly in tests without touching a real
 * tmux server.
 *
 * VERIFIED against the live limited pane, one keystroke at a time: on the numbered
 * limit DIALOG a single Escape dismisses the menu and drops back to an empty input
 * box (revealing the "resets <time>" text as a ⎿ result above it); the literal
 * `continue` then lands in that box; Enter sends it. The leading Escape is thus
 * load-bearing for the dialog form (dismiss the modal before typing) and harmless
 * for the plain text form (clears any stray partial input).
 */
export function resumeKeystrokes(target: string): string[][] {
  return [
    ["send-keys", "-t", target, "Escape"],
    ["send-keys", "-t", target, "-l", "continue"],
    ["send-keys", "-t", target, "Enter"],
  ];
}

/**
 * Gap between the resume keystrokes. Sent back-to-back, the three `send-keys`
 * writes coalesce in the pane's pty and the TUI reads `ESC` + `c` in ONE chunk —
 * which every terminal input parser means Alt+c — so the `c` was eaten and the
 * pane received "ontinue" (observed live on the first real auto-resume fire).
 * Any real gap makes the reads distinct; 150ms is imperceptible next to the
 * seconds-scale poll cadence.
 */
export const RESUME_KEY_DELAY_MS = 150;


/**
 * Send the resume keystrokes (`<esc>continue<enter>`) to a target pane, with a
 * RESUME_KEY_DELAY_MS pause between them (see above — Escape must arrive in its
 * own read or it turns the following `c` into Alt+c).
 */
export function sendResume(target: string): void {
  resumeKeystrokes(target).forEach((argv, i) => {
    if (i > 0) sleepSync(RESUME_KEY_DELAY_MS);
    tmuxQuiet(argv);
  });
}

/**
 * The `send-keys` argv for the dialog-reveal nudge: a SINGLE Escape. On the
 * numbered limit dialog this dismisses the menu and reveals the "resets <time>"
 * notice (verified live) — the timestamp the dialog itself hides — so the next
 * poll can parse and freeze a reset instant and the normal auto-resume machinery
 * can fire. Deliberately just Escape: no `continue` is sent on the reveal tick.
 * Split from the runner so it can be asserted directly in tests.
 */
export function dialogRevealKeystrokes(target: string): string[][] {
  return [["send-keys", "-t", target, "Escape"]];
}

/** Send the dialog-reveal nudge (a single `<esc>`) to a target pane. */
export function sendDialogReveal(target: string): void {
  for (const argv of dialogRevealKeystrokes(target)) tmuxQuiet(argv);
}

