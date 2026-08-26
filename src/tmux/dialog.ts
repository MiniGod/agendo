// Dialogs, of two kinds.
//
// `isDialog` is the general one: an open menu or confirmation that has REPLACED
// the input box and is waiting on a human. The rest of the file is the narrow
// exception — the claude CLI's own "how should I resume?" startup prompt, which
// agendo answers itself rather than treating as a blocked session.
import { capturePane, stripAnsi } from "./pane.ts";
import { sleepSync, tmuxQuiet } from "./exec.ts";
import { inputBox } from "./inputBox.ts";

/**
 * Whether the pane shows an ACTIVE interactive dialog — an open menu/confirmation
 * awaiting a keypress — rather than a dialog footer or numbered list left in
 * scrollback above a now-idle input box. A real dialog REPLACES the input box, so
 * (mirroring isActiveLimitDialog) its signature must be the bottom-most content
 * with NO input-box rule (`─{20,}`) below it. Signatures: a confirmation footer
 * (`Enter to confirm`, `Esc to cancel/reject/go back`, `Press Enter to continue`)
 * or a numbered selection cursor (`❯ 1.`). Without the "nothing below it" guard,
 * an idle pane whose scrollback merely contained `❯ 1.`/`2.` lines read as
 * `dialog` and wrongly blocked `agendo send`. `raw` may include SGR escapes.
 */
export function isDialog(raw: string): boolean {
  const lines = raw.replace(/\r/g, "").split("\n");
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = stripAnsi(lines[i]);
    if (
      /Enter to confirm|Esc to (reject|cancel|go back)|Press Enter to continue/i.test(l) ||
      /^\s*❯\s*\d+\.\s/.test(l)
    ) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    if (/─{20,}/.test(lines[i])) return false;
  }
  return true;
}

// ── the CLI's own "how should I resume?" dialog ───────────────────────────────
// Resuming a large session, the claude CLI asks — before any turn runs — how to
// reload it:
//
//   This session is 1h 14m old and 249.4k tokens.
//
//   Resuming the full session will consume a substantial portion of your usage
//   limits. We recommend resuming from a summary.
//
//   ❯ 1. Resume from summary (recommended)
//     2. Resume full session as-is
//     3. Don't ask me again
//
//   Enter to confirm · Esc to cancel
//
// Structurally that IS a dialog — numbered options under a rule, no input box —
// so `isDialog` (correctly, and load-bearingly for auto-resume safety) fires on
// it and the session sat blocked forever. But nothing is waiting on a human
// decision about the *work*: it's a startup prompt agendo can answer itself. So
// it gets its own narrow detector rather than any loosening of `isDialog`.
//
// Anchored on the literal OPTION LABELS, not the header: the header carries a
// variable age and token count and reads like prose, so it's the likelier of the
// two to churn between CLI versions. Both resume labels are required, which no
// genuine agent question offers.

/** `1. Resume from summary (recommended)` — the option Claude marks recommended. */
const RESUME_SUMMARY_RE = /^resume from summary\b/i;
/** `2. Resume full session as-is` — reload the whole transcript. */
const RESUME_AS_IS_RE = /^resume full session as-is\b/i;
/**
 * `3. Don't ask me again` — deliberately NEVER selectable by agendo: it flips
 * the user's global claude CLI behaviour permanently, for every future session
 * in every project, which is not agendo's call to make. Matched only so it can
 * be filtered out of the choosable set (including from the `(recommended)`
 * fallback, should the marker ever land on it).
 */
const RESUME_DONT_ASK_RE = /^don['’]?t ask me again\b/i;

/** One numbered option of an open menu, as printed by the TUI. */
export interface ResumeDialogOption {
  /** The number the TUI prints — the key that selects it (`2` in `2. Resume …`). */
  number: number;
  /** Option text with the number stripped, e.g. `Resume from summary (recommended)`. */
  label: string;
  /** Whether the label carries claude's own `(recommended)` marker. */
  recommended: boolean;
  /** Whether the `❯` cursor currently highlights this option. */
  selected: boolean;
}

/**
 * The pane's ACTIVE menu region: the lines below the last horizontal rule,
 * ANSI-stripped. Anchoring below the last `─{20,}` is the same "nothing below
 * it" structure `isDialog`/`isActiveLimitDialog` use: an open dialog replaces the
 * input box, so once it's dismissed a rule appears beneath the (now historical)
 * option lines and they stop counting.
 */
function activeMenuLines(raw: string): string[] {
  const lines = raw.replace(/\r/g, "").split("\n").map(stripAnsi);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/─{20,}/.test(lines[i])) return lines.slice(i + 1);
  }
  return lines;
}

/**
 * The `N. label` options among `lines`. The TUI paints the number and the label
 * in different colours, so the lines must already be ANSI-stripped (see
 * activeMenuLines).
 */
function menuOptions(lines: string[]): ResumeDialogOption[] {
  const out: ResumeDialogOption[] = [];
  for (const line of lines) {
    // The selection cursor `❯` marks whichever option is highlighted.
    const m = line.match(/^\s*(❯\s*)?(\d+)\.\s+(\S.*?)\s*$/);
    if (m) {
      out.push({
        number: Number(m[2]),
        label: m[3],
        recommended: /\(recommended\)/i.test(m[3]),
        selected: !!m[1],
      });
    }
  }
  return out;
}

/** The dialog's own footer — the affordance that proves a menu is really OPEN. */
const DIALOG_FOOTER_RE = /Enter to confirm|Esc to cancel/i;

/**
 * Whether the pane is sitting on the claude CLI's own resume-choice dialog (see
 * the block comment above). Four conditions, all within the active menu region:
 * BOTH resume option labels, the confirm/cancel footer, and a `❯` selection
 * cursor on one of the options.
 *
 * The footer and cursor are not redundant. A false positive here is
 * fail-DANGEROUS in a way `isDialog`'s is not: `isDialog` only ever costs a
 * refusal, whereas this verdict makes `send` press keys into the pane. With the
 * labels alone, turn output merely *quoting* them ("the CLI asked: 1. Resume
 * from summary … 2. Resume full session as-is") matched whenever no input-box
 * rule happened to sit below it — a mid-paint capture, say. Requiring the two
 * affordances only a live menu draws costs the real capture nothing, and the
 * cursor is needed to answer the dialog anyway (see answerResumeDialog).
 *
 * Known limit: on a pane narrow enough to WRAP an option label the anchors don't
 * match and the dialog reads as a plain `dialog` again — the pre-fix behaviour,
 * i.e. it fails safe (and `paneResumeMenuSuspect` keeps a forced send from
 * pasting into it regardless). `raw` may include SGR escapes (see capturePane).
 */
export function paneResumeDialogActive(raw: string): boolean {
  const lines = activeMenuLines(raw);
  if (!lines.some((l) => DIALOG_FOOTER_RE.test(l))) return false;
  const opts = menuOptions(lines);
  // EXACTLY one cursor. When the pane has no rule at all, the "active menu" is
  // the whole capture, and claude echoes user prompts with a bare `❯` — so a
  // replayed line like `❯ 1. rerun the failing spec` could add a second
  // "selected" option and leave the walk anchored on a highlight that isn't the
  // real one. Ambiguity here means we cannot know where a move would land.
  if (opts.filter((o) => o.selected).length !== 1) return false;
  return opts.some((o) => RESUME_SUMMARY_RE.test(o.label)) && opts.some((o) => RESUME_AS_IS_RE.test(o.label));
}

/**
 * The WEAK signal: a pane with NO input box whose active menu carries a resume
 * option label, whether or not the full detector fires. Used only to refuse a
 * *forced* paste (`send --force`) into a menu that looks like this one but didn't
 * fully match — a wrapped label, a reworded footer, a future option set. Without
 * it, `--force` (which `--help` and the agent guide both offer as the way past a
 * refusal) would type the message straight into the menu, where its digits pick
 * options and the trailing Enter confirms one.
 *
 * The cost to everything else is nil, because "active menu" means *below the last
 * `─` rule*: a session whose own output quotes these labels — one working on this
 * very feature, say — has them above its input box, so they're not in the region
 * at all and `--force` behaves there exactly as before. The explicit no-input-box
 * condition is belt-and-braces on top of that (if there's a box, there's somewhere
 * safe to paste, whatever the lines below it say). "Don't ask me again" is
 * deliberately NOT among the labels checked: it's generic enough to head a
 * numbered option in an unrelated CLI's menu.
 */
export function paneResumeMenuSuspect(raw: string): boolean {
  if (inputBox(raw) !== null) return false;
  // Matched on the label's HEAD, not the whole phrase: a pane narrow enough to
  // wrap BOTH labels leaves only "Resume from" / "Resume full" on the numbered
  // lines, and that is precisely the case this signal exists for.
  return menuOptions(activeMenuLines(raw)).some((o) => /^resume (from|full)\b/i.test(o.label));
}

/** Which resume option agendo picks for the user (see Config.resumeDialogChoice). */
export type ResumeDialogChoice = "summary" | "as-is";

/**
 * The option to select on the resume dialog for `choice`, or null if the pane
 * isn't showing one. "Don't ask me again" is filtered out first and can never be
 * returned (see RESUME_DONT_ASK_RE).
 *
 * The default ("summary") resolves by claude's own `(recommended)` MARKER rather
 * than by option index or position — the marker is what "recommended" actually
 * means, and the option could move — falling back to the literal
 * `Resume from summary` label if a future version drops the marker.
 */
export function resumeDialogOption(raw: string, choice: ResumeDialogChoice): ResumeDialogOption | null {
  // Only ever choose on a pane the detector fully vouches for — never on a
  // numbered menu that merely happens to carry one of the labels.
  if (!paneResumeDialogActive(raw)) return null;
  const opts = menuOptions(activeMenuLines(raw)).filter((o) => !RESUME_DONT_ASK_RE.test(o.label));
  if (choice === "as-is") return opts.find((o) => RESUME_AS_IS_RE.test(o.label)) ?? null;
  return opts.find((o) => o.recommended) ?? opts.find((o) => RESUME_SUMMARY_RE.test(o.label)) ?? null;
}

/**
 * The option the `❯` cursor currently highlights, or null when that can't be read
 * unambiguously (no cursor, or more than one — see paneResumeDialogActive).
 */
export function resumeDialogSelection(raw: string): ResumeDialogOption | null {
  const selected = menuOptions(activeMenuLines(raw)).filter((o) => o.selected);
  return selected.length === 1 ? selected[0] : null;
}

/**
 * The single `send-keys` argv for one step of answering the dialog: Enter when
 * the cursor already sits on the option we want, otherwise one move toward it.
 * Pure, so the key choice can be asserted without a tmux server.
 *
 * Arrow keys, deliberately, rather than typing the option's NUMBER. A digit may
 * activate an option outright in some CLI versions and merely select it in
 * others — an ambiguity with no safe resolution: send Enter as well and it can
 * land on whatever screen the reloading session draws next (accepting ITS
 * default); don't, and a dialog whose footer says "Enter to confirm" is never
 * answered at all. Up/Down only ever move the highlight, so Enter's meaning is
 * unambiguous — and the caller re-reads the cursor after every step, so nothing
 * is ever confirmed on an assumption about where the selection ended up.
 */
export function resumeDialogStep(target: string, at: number, want: number): string[] {
  const key = at === want ? "Enter" : at < want ? "Down" : "Up";
  return ["send-keys", "-t", target, key];
}

/**
 * Gap between the pane reads that answer the dialog. Its own constant, NOT
 * RESUME_KEY_DELAY_MS: that one is a pty-write-coalescing gap ("any real gap"),
 * whereas this is a repaint budget for an Ink TUI that is also reloading a
 * quarter-million-token session. Comfortably larger than the coalescing gap, so
 * it satisfies that constraint too.
 */
const RESUME_DIALOG_STEP_MS = 250;

/**
 * How many pane reads to spend answering the dialog before giving up. A move
 * costs two reads to settle plus however many frames the pane needs to show it,
 * so this covers any reachable distance in a three-option menu with room for a
 * slow repaint. The bound only matters when the pane stops responding to the
 * arrows, in which case we must not loop forever.
 */
const RESUME_DIALOG_LOOKS = 16;

/**
 * Answer the resume dialog on `target` with `option`: walk the `❯` cursor onto it
 * with arrow keys, then press Enter. Returns whether Enter was actually sent.
 *
 * The pane is re-read RESUME_DIALOG_STEP_MS apart, and three rules together make
 * a lagging repaint harmless — the whole hazard being that the option one past
 * the target is "Don't ask me again", which flips the user's global claude CLI
 * behaviour permanently and must never be pressed:
 *
 *  1. After a move, every frame that still shows the selection we moved FROM is
 *     discarded — the key isn't on screen yet, and acting on it would issue a
 *     second move the menu never needed. This is the load-bearing one: "the same
 *     selection twice running" alone does not mean "settled", because a display
 *     that is uniformly N frames behind is perfectly stable frame to frame.
 *  2. Only a selection seen twice running is acted on at all, so a half-drawn
 *     frame between two states isn't mistaken for either.
 *  3. Enter goes out only when that settled selection's LABEL is the one we
 *     chose — not its number, not a count of the moves we've made — and the
 *     target is re-resolved by label from every capture, so a menu that gains,
 *     drops or reorders an option moves the target with it.
 *
 * A pane that never shows the move therefore receives exactly ONE arrow and then
 * gives up, rather than walking the highlight down the menu and abandoning it on
 * the option we must never press. (Rule 1 covers lag that our OWN moves induce.
 * A pane whose very first capture is already stale — because something else moved
 * the cursor — is outside what any of this can see, and nothing short of a probe
 * keypress into the menu could establish where the highlight really is.)
 *
 * Anything unexpected — the dialog gone, an unreadable cursor, arrows with no
 * effect — returns false, having sent only arrows. Those are harmless while the
 * menu is up. If it closes underneath us (a human answered it) the pane can
 * receive one stray arrow: Down is a no-op in the restored input box, Up recalls
 * history into it. `waitForInputBox` then reads that as a draft and refuses to
 * paste over it, so the message is never delivered blind — but note the Enter
 * that follows a *successful* walk could, in that same window, submit it.
 *
 * Answering is all this does. It does NOT verify the input box came back — the
 * caller must re-capture and check that before pasting anything (see runSend).
 */
export function answerResumeDialog(target: string, option: ResumeDialogOption): boolean {
  let seen: number | null = null;
  let times = 0;
  let movedFrom: number | null = null;
  for (let i = 0; i < RESUME_DIALOG_LOOKS; i++) {
    if (i > 0) sleepSync(RESUME_DIALOG_STEP_MS);
    const raw = capturePane(target);
    // Gone (someone answered it, or it was never really there): nothing to confirm.
    if (!paneResumeDialogActive(raw)) return false;
    const at = resumeDialogSelection(raw);
    // Belt-and-braces: paneResumeDialogActive already required exactly one
    // cursor on this same capture, so this can't be null today.
    if (at === null) return false; // can't read the cursor — never guess where it is
    // Rule 1: the frame predates our last move. Wait for one that doesn't.
    if (movedFrom !== null && at.number === movedFrom) continue;
    movedFrom = null;
    // Where the option we chose sits in the menu AS IT IS NOW. Re-resolved by
    // label every look, so a menu that gains, drops or reorders an option
    // between frames moves the target with it instead of aiming at a number
    // that now belongs to something else.
    const want = menuOptions(activeMenuLines(raw)).find((o) => o.label === option.label);
    if (!want) return false; // our option is no longer on the menu
    times = at.number === seen ? times + 1 : 1;
    seen = at.number;
    if (times < 2) continue; // not a settled frame yet — look again
    if (at.label === option.label) {
      tmuxQuiet(resumeDialogStep(target, at.number, at.number)); // Enter
      return true;
    }
    tmuxQuiet(resumeDialogStep(target, at.number, want.number));
    movedFrom = at.number; // ignore frames still showing this until the move lands
    seen = null; // whatever the next frame shows must settle again before we act
    times = 0;
  }
  return false;
}

/**
 * CEILING on the wait for the input box after answering the resume dialog — an
 * error deadline, NOT a latency anyone pays. waitForInputBox polls every
 * RESUME_DIALOG_POLL_MS and returns the moment it gets two consecutive good
 * reads, so the ordinary cost is about half a second; the full 120s elapses only
 * when the box never comes back at all, i.e. the session is already broken.
 *
 * Generous on purpose, and lowering it buys nothing but a faster failure on that
 * broken session: the dialog only appears for BIG sessions (the captured one was
 * 249.4k tokens), and "resume from summary" — the shipped default — makes the
 * CLI build and load that summary before it draws a box, reading busy or unknown
 * throughout. A tighter deadline would abort those legitimate loads.
 * Overridable per call with `send --timeout`.
 */
export const RESUME_DIALOG_WAIT_MS = 120_000;

/** Poll cadence while waiting for that input box to appear. */
export const RESUME_DIALOG_POLL_MS = 250;
