import { stripAnsi, type PaneCursor } from "./pane.ts";
import { CODEX_PROMPT, type Readiness } from "./readiness.ts";
import { inputEmpty, inputRealText, type InputBox } from "./inputBox.ts";
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
 * two we captured live. `Starting` is codex 0.163's word for the seconds its MCP
 * servers take to boot: it reads `Ready`, then `Starting`, then `Ready` again,
 * and a message submitted meanwhile is held, not run — busy, for every caller.
 */
const CODEX_RUN_STATES: Record<string, Readiness> = { Ready: "ready", Working: "busy", Thinking: "busy", Starting: "busy" };

/**
 * The run-state a status bar's fields carry, or null for none. Two forms:
 *
 *  - a WHOLE field (see CODEX_RUN_STATES), at any position;
 *  - the LAST field cut short by the pane edge. Codex truncates the bar to the
 *    pane's width, a character at a time, with an ellipsis, and the run-state
 *    sits after the model, the cwd and the branch fields, so a long cwd on a
 *    160-column pane leaves `… · Rea…`. Branch fields grow and shrink between
 *    turns, so on the same pane the word came and went — which is how an idle
 *    session read "unknown" and `wait` sat out its whole timeout. Cut inside the
 *    word, the stem must be two or more characters and name exactly one
 *    run-state, case-sensitively: `Wor…` is Working, `R…` is nothing, and a
 *    lower-case `wor…` (a path, a branch) is nothing either. Cut just AFTER it
 *    (`Ready ·…`, `Ready …`), the word is whole and must match as one.
 *
 * Truncated before the word (`play ·…`), the bar carries no run-state at all
 * and the pane degrades to the run-state-off case below — unknown unless the
 * busy line says otherwise.
 */
function runStateOf(fields: string[]): Readiness | null {
  for (const field of fields) {
    if (Object.hasOwn(CODEX_RUN_STATES, field)) return CODEX_RUN_STATES[field];
  }
  const cut = /^(\S{2,})(\s*·?\s*)…$/.exec(fields[fields.length - 1]);
  if (cut === null) return null;
  const [, stem, gap] = cut;
  if (gap !== "") return Object.hasOwn(CODEX_RUN_STATES, stem) ? CODEX_RUN_STATES[stem] : null;
  const words = Object.keys(CODEX_RUN_STATES).filter((w) => w.startsWith(stem));
  return words.length === 1 ? CODEX_RUN_STATES[words[0]] : null;
}

/** A line's ` · `-separated status-bar fields, trimmed. */
function barFields(line: string): string[] {
  return line.split(" · ").map((f) => f.trim());
}

/**
 * Codex 0.163's startup hold, drawn on the key-hint row while MCP servers boot
 * and a message has been submitted: `Waiting for startup  · esc cancel`. The
 * message is queued, not running — it stays in the box, as real text, until
 * startup finishes — and nothing else on the pane says so, since the bar's
 * run-state can be truncated away (see runStateOf). Busy: the turn is coming,
 * and neither `send` nor `wait` should treat the session as settled.
 *
 * Read from the bar down only (see codexPane), never from the rows above the
 * box: a reply that wraps onto a line beginning "Waiting for startup" is prose.
 */
const CODEX_STARTUP_WAIT = /^Waiting for startup\b/m;

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
 * How many of the bottom non-empty rows may hold the status bar. Codex up to
 * 0.148 drew it LAST; 0.163 draws a key-hint row beneath it (`? for shortcuts`,
 * `⚠ 2 warnings · f2 to view`, `Waiting for startup  · esc cancel`, or nothing
 * at all while a draft is in the box). Reading only the last row made every idle
 * 0.163 pane "unknown" — `wait` never settled and `send` refused.
 */
const CODEX_FOOTER_ROWS = 2;

/**
 * Locate codex's footer status bar among the bottom CODEX_FOOTER_ROWS non-empty
 * rows and read its run-state field. A row whose run-state reads wins, nearest
 * the bottom first; with none, the HIGHEST row that has the bar's shape (two or
 * more ` · ` fields — a single field is any old line of prose, and the bar always
 * carries at least the model and the cwd) stands in with no state, since on 0.163
 * the hint row below it can have two fields too. Returns null when no row has
 * that shape, which is how a non-codex pane is rejected. `plain` is the capture
 * ANSI-stripped.
 *
 * A row only counts as the bar with codex's input box above it (codexInputBox),
 * which is how codex lays the two out whenever the bar is drawn at all. Other
 * TUIs end in ` · `-separated rows too: claude's mode row, and above it the
 * user's own statusLine, and one ending in `Working` (or cut to `Sta…`) would
 * otherwise make a claude pane codex. Claude's box sits between `─` rules at
 * column 0, which the box walk stops at.
 */
function codexFooter(lines: string[], plain: string[]): CodexFooter | null {
  let fallback: CodexFooter | null = null;
  let seen = 0;
  for (let row = plain.length - 1; row >= 0 && seen < CODEX_FOOTER_ROWS; row--) {
    if (!plain[row].trim()) continue;
    seen++;
    const fields = barFields(plain[row]);
    if (fields.length < 2 || codexInputBox(lines, plain, row) === null) continue;
    const state = runStateOf(fields);
    if (state !== null) return { row, state };
    fallback = { row, state: null };
  }
  return fallback;
}

/**
 * Codex's input box: the `›` prompt row above the footer, plus every row down to
 * it. There are no rules to anchor on, so the walk goes up from the footer over
 * rows the box can contain — blank padding and its own continuation rows, which
 * codex indents two columns — and takes the first row that STARTS with `›`.
 * Anything else at column 0 ends it: that is transcript (codex's `• …` replies),
 * so the box is not in reach. The same rule keeps a `›` in transcript prose out,
 * and the `›` codex uses as the SELECTION CURSOR inside its dialogs is caught by
 * the dialog checks before the box is ever read for content.
 *
 * The walk has no row bound of its own. A multi-line draft grows the box UPWARD
 * — a captured six-paragraph paste put the prompt row fourteen rows above the
 * bar — and a message of many short lines stays under codex's ~1,000-character
 * paste placeholder, so any fixed bound is one a real message can exceed. A box
 * whose prompt row has scrolled off the top yields null, and with it the bar
 * (see codexFooter): the pane is then not read as codex at all, and the claude
 * path it falls through to answers "unknown", the safe way — `agendo send`
 * refuses rather than overwrite a draft it couldn't measure.
 */
function codexInputBox(lines: string[], plain: string[], footerRow: number): InputBox | null {
  for (let i = footerRow - 1; i >= 0; i--) {
    if (plain[i].startsWith(CODEX_PROMPT)) {
      // `› ` — the marker plus the single space separating it from the input.
      return { text: lines.slice(i, footerRow).join("\n"), promptRow: i, promptOffset: 0, inputCol: 2 };
    }
    if (plain[i].trim() && !plain[i].startsWith("  ")) return null;
  }
  return null;
}

/** A numbered option row of codex's own selection list: `› 1. Trust and continue`, `  2. Quit`. */
const CODEX_OPTION_ROW = /^(?:›| ) *\d+\.\s/;

/** The key hint under one of those lists: `enter continue · esc quit`. */
const CODEX_DIALOG_KEYS = /\benter\b.*\besc\b/i;

/**
 * Codex's own numbered selection list, open — codex 0.163's folder-trust prompt
 * is the captured one (`› 1. Trust and continue` / `  2. Quit` / `enter continue
 * · esc quit`), worded so that `isDialog`'s confirmation-footer signatures miss it
 * and the pane read "unknown": `wait` never woke for a session stuck on it.
 *
 * `›` at column 0 is also how 0.163 echoes the user's own messages into the
 * transcript, so the glyph alone proves nothing. What does is POSITION: the
 * BOTTOM-most column-0 `›` row is a selected option with another option row next
 * to it, everything below it is indented, the last row is the enter/esc hint, and
 * no status bar with a run-state sits below it. That last condition is what
 * separates a list from a draft that merely starts `1. …` — the box always sits
 * directly above codex's bar. `plain` is the capture ANSI-stripped.
 */
function codexOptionDialog(plain: string[]): boolean {
  const rows = plain.flatMap((l, i) => (l.trim() ? [i] : []));
  const sel = rows.findLast((i) => plain[i].startsWith(CODEX_PROMPT));
  if (sel === undefined || !CODEX_OPTION_ROW.test(plain[sel])) return false;
  const below = rows.filter((i) => i > sel).map((i) => plain[i]);
  if (below.some((l) => !l.startsWith(" ") || runStateOf(barFields(l)) !== null)) return false;
  const neighbour = [plain[sel - 1], plain[sel + 1]].some((l) => l !== undefined && CODEX_OPTION_ROW.test(l));
  return neighbour && CODEX_DIALOG_KEYS.test(below.at(-1) ?? "");
}

/**
 * The rows of a codex pane that `isDialog`'s confirmation-footer signatures may
 * be read from. Not the whole pane: codex draws no `─` rule under its box, so
 * `isDialog`'s "nothing below it" guard never fires, and the bottom-most line
 * anywhere reading `Press Enter to continue` or `Esc to cancel` would do — a
 * draft in the box, or the transcript's echo of a message once sent. A message
 * that merely mentions one of those prompts then read `dialog`: `send` couldn't
 * read its own paste back and left it unsent, and `wait` woke on a dialog that
 * wasn't there.
 *
 * So with the box located the area starts at the bar: the rows above it are the
 * box's own text. The one exception is a box whose `›` row is a numbered option
 * over a bar with no run-state — the shape a selection list has, by the test
 * codexOptionDialog uses too. A run-state under it makes it a draft that starts
 * `1.`, read from the bar like any other. With no box the area starts at the
 * bottom-most column-0 `›` row (a dialog's selected option, say), and with no
 * `›` at all it is the whole pane, as before.
 */
function codexDialogArea(pane: CodexPane): string {
  const lines = pane.raw.replace(/\r/g, "").split("\n");
  const plain = lines.map(stripAnsi);
  const { box, footer } = pane;
  const list = box !== null && CODEX_OPTION_ROW.test(plain[box.promptRow]) && footer?.state === null;
  if (box !== null && footer !== null && !list) return lines.slice(footer.row).join("\n");
  return lines.slice(Math.max(0, plain.findLastIndex((l) => l.startsWith(CODEX_PROMPT)))).join("\n");
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
 * Two bands, anchored on the box rather than on rules:
 *  - ABOVE its `›` prompt row: the status block, reached with the shared
 *    `blockAbove` walk past the blank padding rows codex leaves between the
 *    transcript and the box. With no turn running, that block is the last few
 *    rows of the transcript itself, so only the busy line's full shape
 *    (CODEX_BUSY_LINE) is looked for there, never a bare word.
 *  - FROM the footer down: the status bar and, on 0.163, the key-hint row under
 *    it. Nothing there is ever transcript, so the whole band counts. The rows
 *    between the prompt and the footer are the box itself — a multi-line draft's
 *    own text, which says nothing about the session's state — so they are left
 *    out, or a draft that quotes the busy line would read busy.
 *
 * `plain` must be ANSI-stripped and trimmed.
 */
function codexLiveStatus(plain: string[], promptRow: number, footerRow: number): string {
  const above = blockAbove(plain, promptRow, CODEX_STATUS_ABOVE_MAX_LINES, (line) => line === "");
  return [...above, ...plain.slice(footerRow)].join("\n");
}

/**
 * Classify a codex pane. Conservative in one specific direction: it only ever
 * answers "ready" on the POSITIVE evidence of the footer saying `Ready`.
 *
 * That matters because the run-state field is optional — `/statusline` can
 * switch it off, and a narrow pane can truncate it away. Without it, the busy
 * line still catches most of a turn, and everything else degrades to "unknown"
 * (send refuses, and the user can be told why) instead of to a confident, wrong
 * "ready" that would inject a prompt into a working session. So run-state is a
 * soft requirement for `send`/`wait` rather than something we silently guess
 * around.
 */
export function codexReadiness(pane: CodexPane, cursor?: PaneCursor | null): Readiness {
  // An open dialog replaces the input box. Codex's older confirmation footers
  // ("enter to confirm and close; esc to close") match the shared signature,
  // read from the live area only (codexDialogArea); 0.163's numbered lists need
  // their own (codexOptionDialog). Checked first: a dialog can coexist with a
  // footer still reading `Ready`.
  if (pane.dialog || isDialog(codexDialogArea(pane))) return "dialog";
  // Every busy signal is positional: the run-state field is a whole field of
  // the footer line, the startup hold is on the row under it, and the busy line
  // is read from the block directly above the box (see codexLiveStatus).
  if (pane.footer?.state === "busy" || pane.held || CODEX_BUSY_LINE.test(pane.status)) return "busy";
  // No positive `Ready` → we genuinely don't know (see the doc comment above).
  if (pane.footer?.state !== "ready") return "unknown";
  if (pane.box === null) return "unknown";
  return inputEmpty(pane.box, cursor, CODEX_PROMPT) ? "ready" : "queued";
}

/** A recognised codex pane, with everything the classifier reads located once. */
export interface CodexPane {
  /** The capture as handed in, for the checks that re-read it (`codexDialogArea`). */
  raw: string;
  /** Whether codex's own numbered selection list is open (see codexOptionDialog). */
  dialog: boolean;
  /** The status bar, or null on a screen that has none (a dialog before startup). */
  footer: CodexFooter | null;
  /** Codex's input box, or null when there is none to anchor on. */
  box: InputBox | null;
  /** The live status region (see codexLiveStatus); "" when there is no box. */
  status: string;
  /** Whether codex is holding a submitted message for its startup (CODEX_STARTUP_WAIT). */
  held: boolean;
}

/**
 * Whether this capture is a codex TUI. Sniffed from the pane CONTENT rather than
 * the tmux window name: the name only carries the agent for codex's own windows
 * (`cl-codex-…`, `cl-bg-codex-…`), never for a `cl-wi-…`/`cl-pr-…` one, and
 * `paneReadiness`'s callers have only the text.
 *
 * Requires the run-state field, the busy line, the startup hold or codex's own
 * option list — markers no other TUI produces — and reads them all
 * positionally, so a claude pane whose transcript quotes one of them is not
 * mistaken for codex. The bar is only taken with codex's box above it (see
 * codexFooter), so with no box, recognition rests on the option list alone.
 *
 * A codex pane with run-state switched off and no turn running is therefore not
 * recognised, and falls through to the claude path, which finds no input box and
 * answers "unknown". Same safe verdict, reached the long way round.
 */
export function codexPane(raw: string): CodexPane | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  const plain = lines.map(stripAnsi);
  const dialog = codexOptionDialog(plain);
  const footer = codexFooter(lines, plain);
  const box = footer === null ? null : codexInputBox(lines, plain, footer.row);
  const trimmed = plain.map((l) => l.trim());
  const status = box === null || footer === null ? "" : codexLiveStatus(trimmed, box.promptRow, footer.row);
  // The hold's hint row sits under the bar, so it is read from the bar down.
  const held = status !== "" && footer !== null && CODEX_STARTUP_WAIT.test(trimmed.slice(footer.row).join("\n"));
  if (!dialog && footer?.state == null && !held && !CODEX_BUSY_LINE.test(status)) return null;
  return { raw, dialog, footer, box, status, held };
}

/** Whether `raw` is a codex pane holding a submitted message until its startup finishes. */
export function codexStartupHeld(raw: string): boolean {
  return codexPane(raw)?.held ?? false;
}

/**
 * What codex's input box holds right now — the user's (or our own) text, with its
 * dim example placeholder read as empty — or null when it can't be read: not a
 * codex pane, a dialog over it, no box, or a status bar whose run-state is
 * unreadable (the box is measured down to the bar, so without the bar the rows
 * it would end at are a guess).
 *
 * Any `›` INSIDE the text reads back as `>`. `inputRealText` cuts at its marker,
 * so the text's own copies are swapped out first; compare with `codexComparable`,
 * which applies the same swap to the other side.
 */
export function codexComposerText(raw: string): string | null {
  const pane = codexPane(raw);
  if (pane === null || pane.box === null || pane.footer?.state == null) return null;
  if (codexReadiness(pane) === "dialog") return null;
  const text = pane.box.text;
  const rest = text.slice(text.indexOf(CODEX_PROMPT) + CODEX_PROMPT.length).replaceAll(CODEX_PROMPT, ">");
  return inputRealText(CODEX_PROMPT + rest, CODEX_PROMPT);
}

/**
 * `text` reduced to what survives codex's input box: no whitespace at all (the
 * box wraps long lines and indents its continuation rows) and `›` as `>` (see
 * codexComposerText). Two strings that compare equal here are the same draft.
 */
export function codexComparable(text: string): string {
  return text.replaceAll(CODEX_PROMPT, ">").replace(/\s+/g, "");
}
