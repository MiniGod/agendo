// Everything read off a claude pane that is NOT the readiness verdict itself:
// the usage-limit notice and its dialog, the task panel, the compaction bar, the
// background-agent and shell counts — plus `paneResumeSafe`, which is the
// stricter question auto-resume asks before it fires keystrokes at a pane.
import { stripAnsi, type PaneCursor } from "./pane.ts";
import { boundedBox, inputBox, inputEmpty, liveStatusLines, liveStatusRegions } from "./inputBox.ts";
import { blockAbove, isPaneChrome, taskPanelLines, TASK_PANEL_HEADER_RE } from "./lines.ts";
import { isDialog, paneResumeDialogActive } from "./dialog.ts";
import { isUsageLimited, isLimitDialog } from "../usageLimit.ts";

/**
 * How many contiguous non-blank lines above the input box count as the "active"
 * block — the usage-limit notice must render here to be the current state.
 */
const LIMIT_ACTIVE_MAX_LINES = 12;

/**
 * Whether the numbered limit dialog is the *active* bottom-most content — not the
 * same text lingering in scrollback after it was dismissed. The dialog replaces
 * the input box while it's up (there's no `❯ ` prompt line, hence no `─` rule,
 * below it); once dismissed the session drops back to an input box, so a `─{20,}`
 * rule appears beneath the (now historical) dialog text. So: find the last line
 * carrying the dialog's option wording and treat it as active only when no input-
 * box rule sits below it. `lines` are raw (SGR escapes intact) — we strip per
 * line before matching. Note the dialog can render `─` rules *above* it (e.g. a
 * table in scrollback); only rules *below* the dialog demote it.
 */
function isActiveLimitDialog(lines: string[]): boolean {
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isLimitDialog(stripAnsi(lines[i]))) {
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

/**
 * Whether a captured pane is showing the ACTIVE numbered limit dialog (the
 * public, raw-string form of isActiveLimitDialog). Exposed so callers — the
 * auto-resume poll in particular — can key the dialog-reveal nudge off the same
 * structural check the readiness classifier uses, rather than re-deriving it.
 * `raw` may include SGR escapes (see capturePane).
 */
export function paneLimitDialogActive(raw: string): boolean {
  return isActiveLimitDialog(raw.replace(/\r/g, "").split("\n"));
}

/**
 * Whether the pane is CURRENTLY at a usage limit — the notice is the active,
 * bottom-most content, not a stale line left in scrollback after the session
 * resumed. The message persists in history once the user continues, so a plain
 * whole-screen match would keep flagging a recovered, idle session as limited.
 *
 * When an input box is present we look only at the LAST CONTENT BLOCK above it —
 * the contiguous run of non-blank lines nearest the box's top rule (bounded by
 * LIMIT_ACTIVE_MAX_LINES), skipping past blank lines AND pane chrome (the
 * spinner's `✻ Crunched for 0s` summary, the `● high · /effort` mode hint — see
 * isPaneChrome — plus the standing `N tasks (…)` panel, see taskPanelLines). An active
 * limit renders its notice as that block; a recovered session has a later
 * completed turn (and its typed `❯ continue`) between the old notice and the
 * box, so the nearest content block is that turn's tail, not the notice. With
 * no input box to anchor on, fall back to scanning the whole capture
 * (permissive — better to flag than to miss). `raw` must include SGR escapes
 * (see capturePane).
 */
export function paneUsageLimited(raw: string): boolean {
  const lines = raw.replace(/\r/g, "").split("\n");
  // The numbered limit dialog — the primary interactive limit state (form A in
  // usageLimit.ts). It has no reset time and no input box of its own, so the
  // text-block heuristic below can't see it; detect it structurally instead.
  if (isActiveLimitDialog(lines)) return true;
  const rules = lines.flatMap((l, i) => (/─{20,}/.test(l) ? [i] : []));
  if (rules.length === 0) return isUsageLimited(stripAnsi(raw));
  const top = rules.length >= 2 ? rules[rules.length - 2] : rules[rules.length - 1] - 2;
  const plainLines = lines.map((l) => stripAnsi(l).trim());
  const taskPanel = taskPanelLines(plainLines, TASK_PANEL_HEADER_RE);
  const block = blockAbove(
    plainLines,
    top,
    LIMIT_ACTIVE_MAX_LINES,
    (line, i) => line === "" || isPaneChrome(line) || taskPanel.has(i),
  );
  return isUsageLimited(block.join(" "));
}

/**
 * Whether it's safe to auto-send the resume keystrokes to a captured pane:
 * still *actively* at the usage limit (so a recovered session — notice only in
 * scrollback — is never clobbered), with no open dialog (Escape would dismiss
 * it) and an *empty* input box (so a draft the user queued for after reset isn't
 * wiped). Stricter than `paneReadiness` alone, which reports "limited" even over
 * a lingering dialog / queued text because the limit check outranks both. `raw`
 * must include SGR escapes (see capturePane); pass the caret captured with it
 * (see capturePaneState) so a greyed-out autocomplete *suggestion* sitting in the
 * box doesn't read as a draft and veto the resume — a false-dirty read here is
 * silent and permanent: auto-resume simply never fires for that limit window.
 *
 * The numbered limit dialog is the one dialog we DO fire into: the resume
 * keystrokes lead with Escape, which dismisses it (verified live), and the dialog
 * has no input box holding a user draft. Every *other* open dialog still blocks —
 * Escape would dismiss it too, but that's not what the user wants.
 */
export function paneResumeSafe(raw: string, cursor?: PaneCursor | null): boolean {
  if (!paneUsageLimited(raw)) return false;
  // Never fire into the CLI's own resume dialog. Its replayed transcript can
  // still carry the limit notice that stopped the previous run (so the check
  // above can be true), and the resume keystrokes lead with Escape — which here
  // is the dialog's own "Esc to cancel", i.e. cancelling the resume. Stated
  // explicitly rather than left to the isDialog check below, since this is the
  // one dialog whose *other* consumers now treat the pane as available.
  if (paneResumeDialogActive(raw)) return false;
  const lines = raw.replace(/\r/g, "").split("\n");
  if (isActiveLimitDialog(lines)) return true;
  if (isDialog(raw)) return false;
  const input = inputBox(raw);
  return input !== null && inputEmpty(input, cursor);
}

/**
 * The compaction progress bar's percentage — `42` for `▰▰▰▱▱▱ 42%` — or null when
 * the pane isn't showing one. Read from the live status region (`liveStatusLines`),
 * the same band `paneReadiness` takes the "compacting" verdict from, so a transcript
 * that merely quotes a bar can't produce a reading.
 *
 * Anchored on the bar's own `▰`/`▱` blocks rather than on `%`, and that anchor is
 * load-bearing: the status region deliberately includes everything below the input
 * box, and the TUI's footer there is full of percentages — `29% ctx | 5h: 9% (3h 9m)
 * | 7d: 63%` — any of which a bare `\d+%` would happily return as the compaction
 * progress. The bar glyphs appear nowhere else.
 *
 * Deliberately NOT gated on the pane being compacting: callers that display it pair
 * it with the readiness they already have (see `rowCompactionPercent` in index.tsx),
 * which keeps this a pure read of one thing. Returns null rather than 0 when there
 * is no bar — "no reading" and "0% done" are different claims, and a compaction that
 * has genuinely just started does print `0%`.
 */
export function paneCompactionPercent(raw: string): number | null {
  const m = liveStatusLines(raw).join("\n").match(/[▰▱]+\s*(\d{1,3})\s*%/);
  if (!m) return null;
  const pct = Number(m[1]);
  // A bar that reports something impossible is a misread, not a datum.
  return pct >= 0 && pct <= 100 ? pct : null;
}

/**
 * How many background AGENTS the session is currently waiting on, read from the
 * TUI's own words: `✻ Waiting for 1 background agent to finish`.
 *
 * This is the signal `busy` used to stand in for, and the two are not the same
 * thing (#44). A running subagent means the session IS working — so `agendo wait`
 * must not settle — while the main agent is idle at its prompt, so `agendo send`
 * must still deliver. One flag could not say both. Monitors and background shells
 * are a third case again: legitimately long-running (a dev server, an armed
 * watcher), so they hold neither — `wait` would never return for anyone running
 * one. They need no counter of their own for that: they simply never produce this
 * sentence, so a session running one settles.
 *
 * Read from the live status region, NOT the whole pane: this phrase is ordinary
 * English and a session whose transcript merely *discusses* background agents (a
 * pane documenting this very detection layer, say) would otherwise be held open
 * forever. The panel's own rows are deliberately not counted — they persist after
 * their agents finish, so they say "this session once spawned agents", not "an
 * agent is running now".
 *
 * Matched on the TUI's exact wording, and on its exact POSITION, which is the weak
 * point. It reads 0 — `wait` settles, `⚠stalled` becomes possible — whenever the
 * sentence is reworded ("Waiting on", "background-agents"), truncated on a narrow
 * pane, pushed further than STATUS_ABOVE_MAX_LINES rows above the box, separated
 * from the box by a chrome row `blockAbove` doesn't recognize, prefixed by more
 * than a one-character glyph, or followed on the same row by anything that is not
 * TUI chrome (a right-aligned `/clear to save 172.1k tokens` hint would do it). Neither
 * direction of a misread is safe: an over-count holds `wait` to its timeout on a
 * finished session, an under-count settles it on one that is still working. So it
 * is worth re-checking against a real capture whenever claude's status line
 * changes, rather than loosened into something that would match prose.
 *
 * One shape would break the split rather than this function: if the TUI ever drew
 * a live counter on this same row (`✻ Waiting for 1 background agent to finish
 * (2m · ↓ 4.2k tokens)`), the pane would read `busy` AND count 1, and `send` would
 * refuse a prompt that is idle. Today's captures carry no counter there.
 *
 * Returns 0 when the TUI is not waiting on any.
 */
export function paneBackgroundAgents(raw: string): number {
  // Without a bounded box `liveStatusLines` falls back to the WHOLE capture, and
  // this phrase is ordinary English — a resume dialog (which replaces the box,
  // and which `paneReadiness` calls settled) over a transcript discussing
  // background agents would hold `agendo wait` open until its timeout, on a
  // session that is finished. Read nothing rather than read the transcript.
  if (boundedBox(raw) === null) return 0;
  let max = 0;
  // The ABOVE band only: this sentence is part of the turn status the TUI draws
  // over the box, and the band below it holds a panel whose rows carry model- and
  // user-authored text (a subagent's task title, the user's status line).
  for (const line of liveStatusRegions(raw).above) {
    // The sentence has to BE the whole line, past at most a one-character spinner
    // glyph: anchored at both ends, and with the assistant's own bullet (`●`/`⏺`)
    // excluded up front. A transcript line CAN reach this band — `blockAbove`
    // collects up to STATUS_ABOVE_MAX_LINES rows when the transcript butts against
    // the box — and the sentence is ordinary English that an orchestrator narrating
    // its own fan-out will print verbatim. Three separate holes were closed here:
    // `\W*` admitted `## Waiting for 3…` and `> "Waiting for 2…"`, a bare `\S\s+`
    // admitted `● Waiting for 3…`, and no end anchor admitted `● Waiting for 3
    // background agents to finish before I commit.`
    // The tail is the other half of that: the sentence may be followed by the
    // TUI's own chrome — an ellipsis, or a parenthesized/middot-led suffix like
    // `(3m 12s)` or `· esc to interrupt`, which claude's spinner rows habitually
    // carry — but never by more words. `…to finish, then I'll commit.` is prose
    // and reads 0; `…to finish (2m · ↓ 4.2k tokens)` is the TUI and reads the
    // count. An anchor that admitted neither under-counted, which is the
    // destructive direction: `wait` settles and `close` kills a working session.
    const m = line.match(
      /^(?!●|⏺)(?:\S\s+)?waiting for\s+(\d+)\s+background\s+agents?\s+to\s+finish(?:\s*[.…]+)?(?:\s*[(·•].*)?$/i,
    );
    // Two lines both claiming a count is not a shape the TUI produces; if it
    // ever does, the higher number is the survivable misread — an over-count
    // wakes late and loudly (a timeout, non-zero exit), an under-count wakes
    // early and silently on a session that is still working.
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/**
 * Number of background shells the session has running, read from the TUI's
 * `· N shell(s) ·` indicator (the footer's clickable "view background shells"
 * button, also echoed in the turn summary as `N shell still running`). This is
 * orthogonal to readiness — a session can be busy *or* idle while a background
 * shell keeps working, most notably a monitor (an `until` loop that re-wakes
 * claude). Anchored on the leading middot `·` (U+00B7, the TUI's separator —
 * never the bullet `•`) so prose mentioning "shell" doesn't count.
 * Returns 0 when none are shown.
 */
export function paneShells(raw: string): number {
  let max = 0;
  const re = /·\s*(\d+)\s+shells?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripAnsi(raw)))) max = Math.max(max, Number(m[1]));
  return max;
}
