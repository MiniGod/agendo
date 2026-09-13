// `paneReadiness` — the classifier that turns a capture into one `Readiness`.
//
// It is the only thing in this directory that reads from every parsing module at
// once, so it sits at the top of the import graph and nothing imports it back.
import { type PaneCursor } from "./pane.ts";
import { type Readiness } from "./readiness.ts";
import { inputBox, inputEmpty, liveStatusRegions } from "./inputBox.ts";
import { isDialog, paneResumeDialogActive } from "./dialog.ts";
import { paneUsageLimited } from "./chrome.ts";
import { codexPane, codexReadiness } from "./codex.ts";

/**
 * Classify a captured agent TUI pane to decide whether it's safe to send a
 * prompt. Codex panes are recognised and handed to `codexReadiness`; the rest
 * of this function is the claude classifier.
 *
 * Conservative: only "ready" is auto-sendable; everything else (a turn
 * generating → "busy", conversation being compacted → "compacting", unsent text
 * already in the box → "queued", an open question/menu → "dialog", or an
 * unrecognized screen → "unknown") is left for the caller to handle. The one
 * exception, checked before all of those, is the CLI's own resume dialog: it
 * reports "ready" without an input box behind it (see paneResumeDialogActive and
 * paneAcceptsPaste). Calibrated
 * against the real TUI:
 *  - Generating: a live spinner shows a time/token counter, e.g.
 *    `✢ Tinkering… (58s · ↓ 3.9k tokens)` — the counter (not an "esc to
 *    interrupt" hint, which this version omits) is the reliable busy signal.
 *  - The input box is drawn between two long `─` rules with a `❯` prompt; the
 *    *last* two rules in the capture are its borders. We anchor on those rather
 *    than a fixed offset, because sub-agent status lines (`● main`, `◯ …`) can
 *    render below the mode bar. The box can be empty even while busy, so busy is
 *    checked first and independently.
 * `raw` must include SGR escapes (see `capturePane`), and `cursor` — the caret
 * captured alongside it (see `capturePaneState`) — is the second, color-blind
 * signal for "is anything typed?"; omitting it falls back to the color read alone
 * (see `inputEmpty`).
 *
 * Every marker below is read POSITIONALLY, from the region of the screen that
 * actually carries the state it claims to prove — the compacting/busy markers from
 * the CLI's live status region (`liveStatusLines`), the limit notice from the last
 * content block above the box (`paneUsageLimited`), a dialog from the bottom-most
 * content (`isDialog`). Scanning the whole visible screen was tried and is wrong:
 * the transcript is history, so a turn that merely *quotes* a marker put an idle
 * session into a state that `send` refuses. This mirrors `paneResumeDialogActive`
 * (#30) and carries the same bias — a false "not ready" that blocks a send costs
 * more than a missed detect.
 */
export function paneReadiness(raw: string, cursor?: PaneCursor | null): Readiness {
  // Codex first: its TUI is recognised from the pane's own content (see
  // codexPane) and classified separately. It must come before every claude check
  // because it shares one of their markers — codex also prints "esc to
  // interrupt" — while sharing none of the structure they'd then rely on: no `─`
  // rules around its input box, so `inputBox` (and with it `liveStatusLines`)
  // finds nothing to anchor on and would fall back to scanning the whole pane.
  // Codex gets the same positional treatment against its own chrome instead.
  const codex = codexPane(raw);
  if (codex) return codexReadiness(codex, cursor);
  // The claude CLI's OWN startup prompt about *how* to resume this session — not
  // the agent asking anything about the work, so from a caller's point of view
  // the session is available and we report it as "ready".
  //
  // Checked FIRST, before busy/limited/dialog. Everything above the dialog is
  // the PREVIOUS run's replayed transcript, which routinely ends in the very
  // notice that made the user resume — "You've hit your session limit …" — or in
  // an interrupted spinner's token counter. Judged in the usual order, such a
  // pane read "limited"/"busy" (verified on the real capture with a limit notice
  // spliced into its tail): `status` would print a stale reset time and
  // `agendo wait` would never settle, i.e. the exact blocked-forever reporting
  // this exists to fix, just wearing a different label. Nothing in that
  // scrollback is the CURRENT state: no turn has run yet.
  //
  // NB this is the one "ready" that does NOT mean "there's an empty input box to
  // paste into" — the dialog replaces the box — which is why every sender must
  // re-check `paneResumeDialogActive` and answer the dialog first (see
  // `answerResumeDialog`) instead of pasting on the strength of "ready".
  if (paneResumeDialogActive(raw)) return "ready";
  // WHERE the next two checks look: the CLI's own live status region, NOT the
  // whole screen (see liveStatusLines). Both markers below are transient facts
  // about the current instant, and the transcript above the box is history — a
  // session whose turn output merely *describes* a marker is not in that state.
  // Live specimen: a session documenting agendo's own detection layer printed a
  // comparison table whose cell read `inferred (esc to interrupt, token counter)`,
  // and `agendo list` called the finished, idle session "busy" — which makes
  // `send` refuse and leaves it unreachable until the text scrolls off.
  const { above, below } = liveStatusRegions(raw);
  const status = [...above, ...below].join("\n");
  // Compacting the conversation — a distinct, blocking state. Must be checked
  // *before* the input-box read below: compaction shows no token counter and no
  // "esc to interrupt" hint, and leaves the box empty, so it would otherwise
  // fall through every busy/dialog check and misclassify as "ready" — letting a
  // prompt be sent mid-compaction. The spinner verb line reads
  // `✻ Compacting conversation…` above a `▰▰▱▱ N%` progress bar — both inside the
  // status region, directly above the box's top rule.
  if (/compacting conversation/i.test(status)) return "compacting";
  // Actively generating — a live token/time counter (or an interrupt hint).
  // The counter always wears a directional ↑/↓ arrow (bytes flowing this turn):
  // `✢ Tinkering… (58s · ↓ 3.9k tokens)`. That arrow is the load-bearing
  // distinction from a FINISHED-turn *result* summary — `✔ Goal achieved (1m ·
  // 1 turn · 4.6k tokens)` — which wears the identical `(<time> · … tokens)`
  // shape (and leads with a ✔/✗ glyph + an "N turn(s)" count) but never an
  // arrow. So both checks REQUIRE the arrow: matching the bare parenthesized
  // shape alone read an idle, done-with-its-turn pane as "busy" and blocked
  // `agendo send`. The arrow is a *content* guard on top of the positional one,
  // and still needed: the status region legitimately holds a finished turn's
  // summary between turns.
  //
  // WHICH BAND each check reads is the other half of the positional guard, and it
  // is what #44 got wrong. The counter is only ever a LIVE counter above the box.
  // Below the box the same shape means something else entirely: a subagent row's
  // `↓ 99.9k tokens` is that agent's running TOTAL and outlives the agent, and the
  // row above it is the user's `statusLine` script, which may print anything —
  // claude hands those scripts the session's own duration and token counts, so
  // `1m 30s · ↓ 12.4k tokens` is a perfectly ordinary thing for one to say. Read
  // as the live counter, either pinned the pane to `busy` with nothing to clear
  // it: `wait` never settled and `send` refused a prompt sitting there idle.
  //
  // The interrupt hint keeps the whole region, but it does NOT get to appear just
  // anywhere in a line. Below the box the text is model- and user-authored — a
  // subagent's task description, the user's status line — and this repo is full of
  // agents whose task is literally "fix the esc to interrupt hint". A row like
  //   ◯ general-purpose  Fix the esc to interrupt hint   5m 39s · ↓ 9k tokens
  // outlives the agent it names, so reading the phrase there is #44 again, exactly:
  // busy forever, `wait` never settles, `send` refused. So the phrase must sit
  // where the TUI puts a HINT — opening the line, or after the separator its
  // footers and spinner parens use (`(58s · esc to interrupt)`), never mid-sentence.
  // Note `|` is deliberately NOT a separator here: `·` is what the TUI's own
  // footers use, `|` is what status-line scripts use, and `repo | esc to
  // interrupt: off | Opus 5` is a status line describing a keybinding, not a
  // session generating.
  // That asymmetry — numbers from above, hints from anywhere — is
  // deliberately not a test of what a panel row LOOKS like. Trying to recognize
  // the panel by its glyph swallowed the interrupt hint under any status line
  // starting with `●`; trying to recognize it by its trailing token column missed
  // every panel row whose column was worded or wrapped differently, and still
  // matched a status line that printed one. There is nothing to recognize: the
  // band simply does not carry this kind of evidence.
  //
  // Evidence rather than assertion, as far as it goes: across every capture in
  // e2e/fixtures, no CLAUDE pane has any busy evidence at all below its box, and
  // the only below-box matches for the counter shape are agent-panel rows. (Two
  // codex captures do carry the interrupt phrase below the box, but they return
  // from the codex branch above and never reach this check, so they are not
  // evidence for this decision either way.) A corpus is not a proof: if claude
  // ever draws a live counter under the box, this reads it as ready.
  const live = above.join("\n");
  if (
    /[↑↓]\s*[\d.,]+\s*k?\s*tokens?\b/i.test(live) ||
    /\(\s*\d[^)]*[↑↓][^)]*\btokens?\b[^)]*\)/i.test(live) ||
    /(?:^|[·•(]\s*)esc to interrupt\b/im.test(status)
  )
    return "busy";
  // Usage/token window exhausted — the 5-hour or weekly cap. Only when the notice
  // is the *active* bottom-most content (not stale scrollback from a session that
  // already resumed — see paneUsageLimited). Checked after busy (a session
  // generating again must read "busy") but before the input-box read: an active
  // notice sits just above the otherwise-idle box, so it would otherwise read
  // "ready" and invite a doomed send. See usageLimit.ts for the matched wording.
  if (paneUsageLimited(raw)) return "limited";
  // An open interactive menu / confirmation (not mere prose, and not a numbered
  // list left in scrollback — only the ACTIVE bottom-most dialog).
  if (isDialog(raw)) return "dialog";
  // Read the input box: the lines between the last two horizontal rules.
  const input = inputBox(raw);
  if (input === null) return "unknown";
  return inputEmpty(input, cursor) ? "ready" : "queued";
}


/**
 * Whether a captured pane is genuinely at an empty input box — i.e. "ready"
 * MINUS the single case where that word doesn't imply a box behind it: the CLI's
 * own resume dialog (see paneResumeDialogActive). `sendToPane` is keystroke
 * injection, not a queue, so this must be checked on a FRESH capture immediately
 * before pasting; a message pasted into a numbered menu picks an option.
 */
export function paneAcceptsPaste(raw: string, cursor?: PaneCursor | null): boolean {
  return !paneResumeDialogActive(raw) && paneReadiness(raw, cursor) === "ready";
}
