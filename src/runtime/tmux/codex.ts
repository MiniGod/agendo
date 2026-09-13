import { stripAnsi, type PaneCursor } from "./pane.ts";
import { CODEX_PROMPT, type Readiness } from "./readiness.ts";
import { inputEmpty, type InputBox } from "./inputBox.ts";
import { isDialog } from "./dialog.ts";
import { blockAbove } from "./lines.ts";

// ── Codex CLI panes ──────────────────────────────────────────────────────────
// Codex's TUI shares no structure with claude's, so it gets its own classifier
// (`codexReadiness`) that `paneReadiness` dispatches to. Calibrated against real
// captures of a 67-second turn (see e2e/fixtures/codex-*.ansi). The differences
// that matter:
//   • The input box has NO border rules — it's a background-colour band — so
//     claude's "between the last two `─{20,}` rules" anchor finds nothing.
//   • Its prompt glyph is `›`, not `❯`.
//   • The caret NEVER moves: it sat at the prompt column for all 289 samples of
//     a busy turn, so it says nothing about busy-ness (it still says plenty
//     about whether the box holds a draft).
//   • The box keeps showing its dim example placeholder while the model works,
//     and codex accepts typing mid-turn (it queues), so an empty-looking box is
//     NOT permission to send.
// What's left is the status bar, and one status line above the input — both read
// POSITIVELY and POSITIONALLY, from codex's own live status region
// (`codexLiveStatus`) rather than from anywhere in the pane, for exactly the
// reason the claude side moved that way in #33.
//
// Known limitation, deliberate: codex compaction is not a state of its own here.
// `codexReadiness` never returns "compacting", so a compacting codex pane reads
// "busy" off its run-state field — blocked, which is the answer that matters, but
// without the progress `paneCompactionPercent` gives a claude pane (#34). Both of
// that function's callers gate on `readiness === "compacting"`, so it is never
// reached with a codex capture and never measures codex's bar with claude's
// rule-anchored region. Closing this needs a real capture of codex mid-compaction
// to calibrate against; guessing at the marker would be the fail-dangerous
// direction, since a wrong "compacting" is still un-sendable but a wrong percent
// would be a claim the screen never made.
//
// Why scrape at all, when claude gets read over its control socket: codex has no
// per-process socket to connect to. It does have a local control plane — an
// [experimental] `codex app-server daemon`, WebSocket JSON-RPC over
// `$CODEX_HOME/app-server-control/app-server-control.sock`, whose `thread/read`
// reports a richer status than anything here (idle vs active vs
// waitingOnApproval vs waitingOnUserInput). But a thread is only reachable
// there if its TUI was started as `codex --remote unix://`, i.e. as a client of
// that daemon; a plain `codex`/`codex resume` is invisible to it (it shows up in
// `thread/list` from the on-disk rollouts, but always `notLoaded`, never
// controllable). So it can never cover sessions the user launched themselves,
// and adopting it means changing how agendo launches codex — worth revisiting
// once the protocol settles, not a drop-in for this.

/**
 * Codex's run-state word, read from its footer status bar. The bar is a ` · `
 * separated list whose fields are user-configurable (`/statusline`), so the
 * word is matched as a WHOLE field at any position rather than by offset — and
 * matching a whole field is also what stops the word "Working" in transcript
 * prose from counting. `Thinking` is documented by the `/statusline` dialog
 * ("Compact session run-state text (Ready, Working, Thinking)") alongside the
 * two we captured live.
 */
const CODEX_RUN_STATES = { Ready: "ready", Working: "busy", Thinking: "busy" } as const;

/**
 * Codex's mid-turn status line, rendered directly above the input box:
 * `• Working (25s • esc to interrupt)`. Independent of the footer, so it still
 * works when `/statusline` has the run-state field switched off; across a
 * captured 67-second turn it was present in every one of the 154 busy frames.
 *
 * The VERB varies and must not be matched on — `--approve-for-me` swaps it for
 * `• Reviewing approval request (6s • esc to interrupt)` while its automatic
 * review runs, and other sub-steps may use others again. What's invariant is
 * the shape: a `•` bullet, a parenthesised elapsed counter, and the interrupt
 * hint. Requiring the counter is what keeps finished-turn prose out — the
 * completion marker is `─ Worked for 1m 06s ───…`, which carries no hint.
 *
 * The counter restarts at each sub-step (it ran 0→33s, reset, ran again), so it
 * is not a turn timer and nothing should read it as one.
 */
const CODEX_BUSY_LINE = /^[ \t]*•[^\n]*\(\s*\d+s\b[^\n]*\besc to interrupt\b/im;

/** What a codex pane's footer says, when we can find and read one. */
interface CodexFooter {
  /** Index of the status-bar line in the capture. */
  row: number;
  /** The run-state field, or null when `/statusline` has it switched off. */
  state: Readiness | null;
}

/**
 * Locate codex's footer status bar — the last non-empty line — and read its
 * run-state field. Returns null when the line doesn't look like a status bar at
 * all (too few ` · ` fields), which is how a non-codex pane is rejected.
 */
function codexFooter(lines: string[]): CodexFooter | null {
  let row = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (stripAnsi(lines[i]).trim()) {
      row = i;
      break;
    }
  }
  if (row === -1) return null;
  const fields = stripAnsi(lines[row]).split(" · ").map((f) => f.trim());
  // A single field is any old line of prose; the bar always carries at least
  // the model and the cwd, so two is the floor for calling this a status bar.
  if (fields.length < 2) return null;
  for (const [word, state] of Object.entries(CODEX_RUN_STATES)) {
    if (fields.includes(word)) return { row, state };
  }
  return { row, state: null };
}

/**
 * Codex's input box: the `›` prompt line just above the footer, plus the blank
 * padding row between them. There are no rules to anchor on, so we scan a short
 * way up from the footer — which also keeps a `›` appearing in transcript prose
 * out of reach, and (more importantly) the `›` codex uses as the SELECTION
 * CURSOR inside its dialogs, which is the same glyph.
 *
 * A draft long enough to wrap past the search window yields null. That costs
 * more than it used to: the prompt row is also what anchors the live status
 * region (see codexLiveStatus), so without it the pane is read from its footer
 * alone. Both consequences point the safe way — "unknown", so `agendo send`
 * refuses rather than overwriting the draft it couldn't measure.
 */
const CODEX_BOX_SEARCH_ROWS = 4;

function codexInputBox(lines: string[], footerRow: number): InputBox | null {
  for (let i = footerRow - 1; i >= 0 && i >= footerRow - CODEX_BOX_SEARCH_ROWS; i--) {
    if (!lines[i].includes(CODEX_PROMPT)) continue;
    return {
      text: lines.slice(i, footerRow).join("\n"),
      promptRow: i,
      promptOffset: 0,
      // `› ` — the marker plus the single space separating it from the input.
      inputCol: stripAnsi(lines[i]).indexOf(CODEX_PROMPT) + 2,
    };
  }
  return null;
}

/**
 * How many contiguous non-blank rows above codex's input box count as its live
 * status region. Two is the observed maximum: the busy line alone
 * (`• Working (25s • esc to interrupt)`), or that line plus the `└ /bin/bash -lc
 * "…"` detail row that `--approve-for-me` draws under it while its reviewer runs.
 * Three leaves a row of slack, matching STATUS_ABOVE_MAX_LINES on the claude side.
 */
const CODEX_STATUS_ABOVE_MAX_LINES = 3;

/**
 * The codex pane's LIVE STATUS region — the counterpart of `liveStatusLines` for
 * a TUI that draws no rules, and it exists for the same reason (#33): the
 * transcript above the box is HISTORY, so a turn that merely *quotes* a marker is
 * not evidence of the state that marker names. Scanning the whole pane is what
 * put an idle session documenting agendo's own detection layer into `busy` and
 * left `send` refusing until the text scrolled off; codex is if anything more
 * exposed, since its own busy line is the sort of string that gets pasted around.
 *
 * Two bands, anchored on the `›` prompt row rather than on rules:
 *  - ABOVE it: the status block, reached with the shared `blockAbove` walk past
 *    the blank padding rows codex leaves between the transcript and the box.
 *  - BELOW it: the footer status bar and the blanks around it. Nothing below the
 *    box is ever transcript, so the whole band counts.
 *
 * `plain` must be ANSI-stripped and trimmed.
 */
function codexLiveStatus(plain: string[], promptRow: number): string {
  const above = blockAbove(plain, promptRow, CODEX_STATUS_ABOVE_MAX_LINES, (line) => line === "");
  return [...above, ...plain.slice(promptRow + 1)].join("\n");
}

/**
 * Classify a codex pane. Conservative in one specific direction: it only ever
 * answers "ready" on the POSITIVE evidence of the footer saying `Ready`.
 *
 * That matters because the run-state field is optional — `/statusline` can
 * switch it off. With it off, the busy line still catches most of a turn, and
 * everything else degrades to "unknown" (send refuses, and the user can be told
 * why) instead of to a confident, wrong "ready" that would inject a prompt into
 * a working session. So run-state is a soft requirement for `send`/`wait`
 * rather than something we silently guess around.
 */
export function codexReadiness(pane: CodexPane, cursor?: PaneCursor | null): Readiness {
  // An open dialog replaces the input box; codex's own confirmation footer
  // ("enter to confirm and close; esc to close") matches the shared signature.
  // Checked first: a dialog can coexist with a footer still reading `Ready`.
  if (isDialog(pane.raw)) return "dialog";
  // Both busy signals are positional: the run-state field is a whole field of
  // the footer line, and the status line is read from `pane.status` — never from
  // the transcript (see codexLiveStatus).
  if (pane.footer.state === "busy" || CODEX_BUSY_LINE.test(pane.status)) return "busy";
  // No positive `Ready` → we genuinely don't know (see the doc comment above).
  if (pane.footer.state !== "ready") return "unknown";
  if (pane.box === null) return "unknown";
  return inputEmpty(pane.box, cursor, CODEX_PROMPT) ? "ready" : "queued";
}

/** A recognised codex pane, with everything the classifier reads located once. */
interface CodexPane {
  /** The capture as handed in, for the checks that want it whole (`isDialog`). */
  raw: string;
  footer: CodexFooter;
  /** Codex's input box, or null when there is none to anchor on. */
  box: InputBox | null;
  /** The live status region (see codexLiveStatus); "" when there is no box. */
  status: string;
}

/**
 * Whether this capture is a codex TUI. Sniffed from the pane CONTENT rather than
 * the tmux window name: the name only carries the agent for codex's own windows
 * (`cl-codex-…`, `cl-bg-codex-…`), never for a `cl-wi-…`/`cl-pr-…` one, and
 * `paneReadiness`'s callers have only the text.
 *
 * Requires either the run-state field or the busy line — the two markers no
 * other TUI produces — and reads BOTH positionally, so a claude pane whose
 * transcript quotes one of them is not mistaken for codex. With no input box
 * there is nothing to anchor the status region on, so recognition then rests on
 * the footer's run-state field alone rather than on a whole-pane search.
 *
 * A codex pane with run-state switched off and no turn running is therefore not
 * recognised, and falls through to the claude path, which finds no input box and
 * answers "unknown". Same safe verdict, reached the long way round.
 */
export function codexPane(raw: string): CodexPane | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  const footer = codexFooter(lines);
  if (footer === null) return null;
  const box = codexInputBox(lines, footer.row);
  const status = box === null ? "" : codexLiveStatus(lines.map((l) => stripAnsi(l).trim()), box.promptRow);
  if (footer.state === null && !CODEX_BUSY_LINE.test(status)) return null;
  return { raw, footer, box, status };
}

