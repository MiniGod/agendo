// Locating the claude TUI's input box inside a capture, and reading it: whether
// it holds real user text, and which rows form the CLI's own live status region.
// The positional anchor the busy/compacting checks in `paneReadiness.ts` depend on.
import { stripAnsi, type PaneCursor } from "./pane.ts";
import { CLAUDE_PROMPT } from "./readiness.ts";
import { blockAbove, isBoxSideHint, looksLikeTaskPanelRow, taskPanelLines, LOOSE_TASK_PANEL_HEADER_RE } from "./lines.ts";

/**
 * Real (user-typed) text on an input line, ignoring the prompt `marker` and any
 * gray/dim *placeholder*. Both TUIs render their placeholder faint (`\e[2m`) or
 * gray and real text in the default color — claude an autocomplete suggestion,
 * codex a rotating example prompt — so we count only non-faint, non-gray
 * glyphs. Expects the raw line *with* SGR escapes; returns "" when the input is
 * effectively empty (blank or only a placeholder).
 */
function inputRealText(line: string, marker: string = CLAUDE_PROMPT): string {
  const after = line.split(marker)[1] ?? "";
  let faint = false;
  let gray = false;
  let out = "";
  const re = /\x1b\[([0-9;]*)m|([^\x1b]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(after))) {
    if (m[1] !== undefined) {
      const codes = m[1].split(";");
      for (let i = 0; i < codes.length; i++) {
        const c = codes[i];
        if (c === "0" || c === "") faint = gray = false;
        else if (c === "2") faint = true;
        else if (c === "22") faint = false;
        else if (c === "39") gray = false;
        else if (c === "90") gray = true;
        else if ((c === "38" || c === "48") && codes[i + 1] === "5") {
          // 256-color: consume `38;5;n` so the `5` selector isn't read as faint.
          if (c === "38") {
            const n = Number(codes[i + 2]);
            gray = n === 8 || (n >= 236 && n <= 250);
          }
          i += 2;
        } else if ((c === "38" || c === "48") && codes[i + 1] === "2") {
          // truecolor: consume `38;2;r;g;b` so the `2` selector isn't read as faint.
          if (c === "38") {
            const r = Number(codes[i + 2]);
            const g = Number(codes[i + 3]);
            const b = Number(codes[i + 4]);
            gray = r === g && g === b && r >= 90 && r <= 200;
          }
          i += 4;
        } else if (/^(3[0-7]|9[0-6])$/.test(c)) gray = false;
      }
    } else if (m[2] && !faint && !gray) {
      out += m[2];
    }
  }
  return out.trim();
}


/** The claude input box, located inside a capture. */
export interface InputBox {
  /** The box's lines (SGR escapes intact), joined — what `inputRealText` reads. */
  text: string;
  /** Index of the `❯` prompt line *in the full capture* = its pane row. */
  promptRow: number;
  /** Index of the same line within `text` (the box's own rows). */
  promptOffset: number;
  /** Column of the first input cell, one past the `❯ ` marker. */
  inputCol: number;
}

/**
 * A claude input box, which is BOUNDED BY TWO `─` RULES — the anchor every
 * positional read above and below the box measures from.
 *
 * Split from `InputBox` because codex's box has no rules at all (it is a
 * background-colour band, see codexInputBox) and would have to fabricate these
 * three fields to satisfy the type. A fabricated rule index is exactly the thing
 * `topRuleFound` exists to warn about, so codex gets the ruleless base type and
 * anchors its own region on the prompt row instead.
 */
interface RuledInputBox extends InputBox {
  /** Capture line index of the box's top `─` rule (may be < 0, see inputBox). */
  topRule: number;
  /**
   * Whether a second rule was found at all. False when only one was and the top had
   * to be fabricated (`bottom - 2`), in which case the index points at whatever
   * happens to sit two rows up — a transcript line, not a boundary. Callers that
   * reason about the region ABOVE the box must not trust `topRule` without it.
   *
   * A weaker guarantee than "the box's top rule is on screen": with the real top
   * rule scrolled off and a table drawing `─{20,}` back in the scrollback, two rules
   * are found and this is true while `topRule` still points into the transcript.
   * Nothing observed does that (the box sits at the bottom of the pane, so its own
   * rule scrolls off only when the box body is taller than the screen), but the flag
   * is the cheap half of the test, not the whole of it.
   */
  topRuleFound: boolean;
  /** Capture line index of the box's bottom `─` rule. */
  bottomRule: number;
}

/**
 * The input-box region — the lines between the last two horizontal rules, which
 * bound the `❯` prompt — or null if there's no recognizable box. `raw` must keep
 * its SGR escapes (inputRealText reads them to tell real text from a suggestion).
 *
 * The prompt's row/column are reported alongside the text so `inputEmpty` can
 * line the pane's caret up against them. The row is a capture line index, which
 * IS the pane row (`capture-pane`'s first line is row 0, the origin `#{cursor_y}`
 * uses); the column is counted on the ANSI-stripped line, so it's a cell offset
 * (the prompt line carries only spaces before the `❯`, one cell each).
 */
export function inputBox(raw: string): RuledInputBox | null {
  const lines = raw.replace(/\r/g, "").split("\n");
  const rules = lines.flatMap((l, i) => (/─{20,}/.test(l) ? [i] : []));
  if (rules.length === 0) return null;
  const bottom = rules[rules.length - 1];
  const top = rules.length >= 2 ? rules[rules.length - 2] : bottom - 2;
  const body = lines.slice(Math.max(top + 1, 0), bottom);
  const promptOffset = body.findIndex((l) => l.includes("❯"));
  if (promptOffset === -1) return null;
  const promptRow = Math.max(top + 1, 0) + promptOffset;
  return {
    text: body.join("\n"),
    promptRow,
    promptOffset,
    // `❯ ` — the marker plus the single space separating it from the input.
    inputCol: stripAnsi(lines[promptRow]).indexOf("❯") + 2,
    topRule: top,
    topRuleFound: rules.length >= 2,
    bottomRule: bottom,
  };
}

/**
 * How many contiguous lines above the input box's top rule can be the CLI's live
 * status line, once the blanks, the right-aligned hints and the task panel between
 * it and the box have been skipped (see liveStatusLines). One is the common case
 * (`✢ Tinkering… (58s · ↓ 3.9k tokens)`, or the idle `✻ Churned for 11m 13s` it
 * turns into); compaction draws two (the verb line plus its `▰▰▱▱ 42%` bar). Three
 * leaves a line of slack without letting the walk run on into the transcript, and
 * it truncates the far end, so the row nearest the box always survives.
 */
const STATUS_ABOVE_MAX_LINES = 3;

/**
 * The pane's LIVE STATUS region, ANSI-stripped and trimmed: the parts of the
 * screen that show what the CLI is doing *right now*, as opposed to the
 * transcript, which is history.
 *
 * Two disjoint bands, both anchored on the input box:
 *
 *  - ABOVE its top rule: the CLI's own status line — the spinner. `blockAbove`
 *    descends from the rule past everything the TUI parks in the gap beneath that
 *    row — blank lines, the right-aligned hints (`isBoxSideHint`), and the standing
 *    `N tasks (…)` panel (`taskPanelLines` for the structural match, plus
 *    `looksLikeTaskPanel` so one unrecognized row can't end the walk; its item
 *    titles are the user's own words and must never be read as CLI state) — and
 *    returns the run that follows. Skipping all of it is not cosmetic: every one of
 *    those lines sits between the status row and the rule on a long session, so
 *    collecting one would end the walk at the next blank and the live spinner above
 *    would never be seen — a busy pane reading `ready`, the direction that lets
 *    `send` paste into a running turn and `close` kill it.
 *  - BELOW its bottom rule: the footer, the mode bar, the user's own `statusLine`
 *    script and the sub-agent panel
 *    (`❯ ◯ general-purpose  Review …  5m 39s · ↓ 99.9k tokens`). Nothing below the
 *    box is ever transcript, so the whole band counts.
 *
 * The two bands are returned separately by `liveStatusRegions` because they do not
 * carry the same KIND of evidence, and one caller needs to tell them apart: there
 * is no live turn counter below the box. The counter lives on the spinner row
 * above it; a `↓ 99.9k tokens` below the box is either a subagent's running total
 * on a panel row or a number the user's own status line chose to print. Reading
 * either as the live counter is #44 — it pinned every session that had ever
 * spawned a subagent to `busy` forever, so `wait` never settled and `send`
 * refused an idle prompt. Below the box the busy signal is a PHRASE (`esc to
 * interrupt`), never a number. See `paneReadiness`.
 *
 * Two cases fall back to returning the WHOLE capture — the pre-existing behaviour —
 * and they are not equally free:
 *
 *  - No input box at all. Free: by the time this runs the one boxless "ready" (the
 *    CLI's own resume dialog) has already been answered above, so every remaining
 *    boxless verdict — dialog, limited, unknown, and the boxless `compacting` that
 *    `agendo send` relies on — is un-sendable either way. Narrowing instead against
 *    rules that may not bound a box at all (a table in scrollback draws `─` too)
 *    would guess at a region rather than find one.
 *  - A box whose top rule is off screen, so `inputBox` fabricated one and
 *    `topRuleFound` is false. NOT free: that pane has a working input box and could
 *    be perfectly ready, so scanning it whole is a live false-busy path — the thing
 *    this change exists to remove, in the one place it is still possible. Taken
 *    anyway because the alternative is worse: measuring a band from a fabricated
 *    boundary reads the transcript as status, which fails the other way (a busy pane
 *    reading ready) on a pane we cannot see enough of to check. It needs a box body
 *    taller than the screen to happen at all.
 *
 * `raw` may include SGR escapes (see capturePane).
 *
 * Two known limits, in opposite directions. A pane whose transcript butts directly
 * against the box — no blank, no status row between them — contributes up to
 * STATUS_ABOVE_MAX_LINES transcript lines, so a marker QUOTED there still reads
 * busy; that is a far narrower target than the whole screen (the capture this
 * exists for matched ~35 lines up, inside a table) and it fails safe. Conversely, a
 * status line pushed further from the box than the walk survives is MISSED, and
 * that one fails dangerous — a busy pane reading `ready`. Anything unrecognized in
 * the gap does it: more than STATUS_ABOVE_MAX_LINES rows of status line, a new hint
 * the TUI starts drawing there, or the shapeless tail of a WRAPPED panel row on a
 * narrow pane (pinned in the detection suite; closing it needs a real narrow-pane
 * capture). New chrome in that gap therefore belongs in `isBoxSideHint` or
 * `looksLikeTaskPanel`, not in the bound — widening the bound trades the miss for
 * the false positive this exists to remove.
 */
/**
 * The input box, but only when it is BOUNDED — both rules on screen, so the band
 * above it is a measured region and not a guess. One definition, because two
 * callers depend on the same condition (`liveStatusRegions` decides whether it has
 * a region at all; `paneBackgroundAgents` refuses to read the whole capture) and a
 * copy of the rule that drifted would silently un-guard the second one.
 */
export function boundedBox(raw: string): RuledInputBox | null {
  const box = inputBox(raw);
  return box === null || !box.topRuleFound ? null : box;
}

export function liveStatusRegions(raw: string): { above: string[]; below: string[] } {
  const lines = raw.replace(/\r/g, "").split("\n");
  const plain = lines.map((l) => stripAnsi(l).trim());
  const box = boundedBox(raw);
  if (box === null) return { above: plain, below: [] };
  const taskPanel = taskPanelLines(plain, LOOSE_TASK_PANEL_HEADER_RE);
  const above = blockAbove(
    plain,
    box.topRule,
    STATUS_ABOVE_MAX_LINES,
    (line, i) => line === "" || isBoxSideHint(line) || taskPanel.has(i) || looksLikeTaskPanelRow(line),
  );
  return { above, below: plain.slice(box.bottomRule + 1) };
}

/** The two bands joined, for the callers that don't care which is which. */
export function liveStatusLines(raw: string): string[] {
  const { above, below } = liveStatusRegions(raw);
  return [...above, ...below];
}

/**
 * Whether the input box holds nothing the user typed — the check that gates both
 * `agendo send` and auto-resume. Two independent discriminators, either of which
 * is enough to call the box empty:
 *
 *  1. COLOR (`inputRealText`): the TUI draws an autocomplete *suggestion* faint
 *     (`\e[2m`) or gray and real text in the default color, so a box whose only
 *     glyphs are faint/gray holds no typed text. Precise when it applies, but
 *     it's a palette heuristic — it can only recognize the grays it enumerates,
 *     and it needs a capture that kept its escapes.
 *  2. CARET (`cursor`): a suggestion is rendered *at* the caret, waiting for Tab;
 *     typed text pushes the caret to its end. So a caret still resting at the
 *     prompt column means nothing was typed, whatever color the box is drawn in —
 *     no palette knowledge, no escapes needed. Accepted only at EXACTLY the
 *     prompt's row and column: the caret is sampled by a second tmux read (see
 *     capturePaneState), and a pane caught mid-paint parks its cursor wherever the
 *     output stream reached — column 0 of a row it is only passing through, say —
 *     so anything short of the resting position is treated as no evidence.
 *
 * They're OR'd because the bug being fixed is a FALSE dirty read: a ghost
 * suggestion that (1) can't recognize — an unenumerated gray, a theme that draws
 * suggestions without dim, a capture stripped of escapes — makes `agendo send`
 * refuse and, worse, makes `paneResumeSafe` refuse, so a usage-limited session
 * never resumes hands-off however long it waits.
 *
 * The OR is not free, and signal 1 does NOT backstop signal 2 — the moment the
 * caret says empty, the color read is discarded. The way that clobbers a real
 * draft: the user types something, then moves the caret back to the prompt column
 * (Home / Ctrl-A, or `0`/`^` under vim bindings) and leaves it there across a
 * poll, at which point a `send`/auto-resume can overwrite the draft. We take that
 * trade knowingly: it needs a caret deliberately moved off the text and left
 * there in an unattended session, versus a suggestion — which the TUI offers
 * constantly, unprompted — silently disabling hands-off resume. `onlyPromptRow`
 * below keeps the trade as narrow as it can be made: the caret may only speak for
 * a box whose other rows are blank, so a multi-row draft (whose caret was moved
 * back up to the prompt row) is never overruled.
 */
export function inputEmpty(box: InputBox, cursor?: PaneCursor | null, marker: string = CLAUDE_PROMPT): boolean {
  if (inputRealText(box.text, marker) === "") return true;
  return (
    !!cursor && cursor.y === box.promptRow && cursor.x === box.inputCol && onlyPromptRow(box)
  );
}

/**
 * Whether the input box's content is confined to the prompt row — every other row
 * blank. Bounds what the caret is allowed to vouch for (see `inputEmpty`): the
 * caret proves nothing about rows it isn't on, so a box with content elsewhere
 * keeps the (conservative) color verdict. Costs the caret signal on a suggestion
 * long enough to WRAP onto a second row, which is the safe direction to fail.
 */
function onlyPromptRow(box: InputBox): boolean {
  return box.text
    .split("\n")
    .every((l, i) => i === box.promptOffset || stripAnsi(l).trim() === "");
}

