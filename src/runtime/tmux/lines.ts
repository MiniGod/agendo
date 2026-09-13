// Recognising a single line of claude pane CHROME — the spinner's summary row,
// the box's side hints, a task-panel header or row — and the "walk upward from
// the box, skipping chrome" scan built on them.
//
// Its own module for a structural reason, not a thematic one: `inputBox.ts` needs
// these to find where the live status region ends, and `chrome.ts` needs them to
// find the last real conversation block. Left in `chrome.ts` they closed an
// inputBox ↔ chrome cycle, which `import/no-cycle` (correctly) fails.

/**
 * The spinner's own row, in the shape it wears BETWEEN turns: a turn summary,
 * `✻ Crunched for 0s` / `✻ Worked for 4m 54s` (the glyph and verb vary per
 * frame/turn). Captured live on v2.1.224. Expects an ANSI-stripped, trimmed line.
 *
 * Chrome to one scan and content to the other, which is why it is its own
 * predicate: `paneUsageLimited` looks for the last *conversation* block and must
 * skip past this to find it, while `liveStatusLines` is looking for this very row —
 * it is the same screen position the live `✢ Tinkering… (58s · ↓ 3.9k tokens)`
 * counter occupies while a turn runs.
 */
export function isSpinnerSummary(line: string): boolean {
  return /^[✻✢✳✶✽·∗+*]\s+\S+\s+for\s+\d+[smhd]/.test(line);
}

/**
 * The right-aligned hints the TUI parks in the gap between the spinner row and the
 * box's top rule (both captured live on v2.1.224):
 *   - the effort/mode hint: `● high · /effort`;
 *   - the context-pressure hint: `new task? /clear to save 293k tokens` (captured
 *     on a live limited pane, where it hid the notice from detection).
 * Expects an ANSI-stripped, trimmed line.
 *
 * Chrome to BOTH scans above the box, and skipping it is load-bearing for each: it
 * is neither conversation content nor CLI state, but it physically separates the
 * spinner row from the box — so a scan that collected it would stop at the very
 * next blank and never reach the row it came for.
 */
export function isBoxSideHint(line: string): boolean {
  return /^●\s+\S+\s+·\s+\/[\w-]+$/.test(line) || /^new task\?\s+\/clear to save\b/i.test(line);
}

/**
 * A line SHAPED like a task-panel item row — a checkbox glyph, or the elision
 * footer — with no header-then-run licence behind it. The unlicensed backstop to
 * `liveStatusLines`' licensed `taskPanelLines` skip: it covers the panel whose
 * header has scrolled off the top of the pane, where there is no header to license
 * anything. (It deliberately does NOT test the header itself: the call site already
 * runs `taskPanelLines` over the same lines with the same loose header, which marks
 * every header line it could match.)
 *
 * Nothing ENFORCES that this only ever sees the gap between the status row and the
 * box: when the status row is absent the walk keeps descending and applies this to
 * the conversation, so it has to be safe there too. Hence a glyph set deliberately
 * NARROWER than TASK_PANEL_ROW_RE's — the checkbox glyphs `◼◻◐◌☐☑` only, never
 * `●○✔✓✗`. Those five are what ordinary turn output is bulleted with (`● Agent "…"
 * failed`, `✔ Goal achieved (1m · 1 turn · 4.6k tokens)`), and skipping them
 * unlicensed let the walk climb an arbitrarily long run of transcript bullets and
 * read a marker quoted above them — the very false positive this whole change
 * removes. `✔` is a real done-row glyph, so dropping it here costs a real skip; the
 * loose header hands that case back positionally instead, which is the safe way to
 * buy it (see LOOSE_TASK_PANEL_HEADER_RE). Both regressions are pinned in the
 * detection suite.
 */
export function looksLikeTaskPanelRow(line: string): boolean {
  return /^[◼◻◐◌☐☑]\s+\S/.test(line) || /^…\s*\+\d+\b/.test(line);
}

/**
 * UI chrome the TUI renders between the last content block and the input box —
 * lines that carry no conversation content and so must NOT count as "the session
 * moved on" when locating the active block. Deliberately narrow: a turn-output
 * bullet (`● Build 123456 now: SUCCEEDED`) or a typed `❯ continue` is content,
 * and correctly demotes any notice above it to history.
 */
export function isPaneChrome(line: string): boolean {
  return isSpinnerSummary(line) || isBoxSideHint(line);
}

/**
 * The contiguous block of interesting lines directly above `top`, nearest-first
 * from the caller's point of view: descend from `top - 1`, skipping whatever `skip`
 * rejects until something is collected, then stop at the first rejected line after
 * that. Bounded by `max`, which truncates the FAR (upper) end — the nearest lines
 * to the box are the ones both callers care most about.
 *
 * `max` bounds what is COLLECTED, not how far the descent goes: a run of skipped
 * lines is walked through however long it is. That is what lets both callers reach
 * past a tall task panel, and equally what makes a too-permissive `skip` dangerous —
 * it tunnels into the transcript instead of stopping at it.
 *
 * Shared by the two scans that ask "what is directly above the input box?" —
 * `paneUsageLimited` (which content block is current?) and `liveStatusLines` (what
 * is the CLI doing?). They differ only in `skip` and `max`, and deliberately so:
 * the spinner row is chrome to the first and the whole point of the second (see
 * isSpinnerSummary). `plain` must be ANSI-stripped and trimmed.
 */
export function blockAbove(plain: string[], top: number, max: number, skip: (line: string, i: number) => boolean): string[] {
  const out: string[] = [];
  for (let i = top - 1; i >= 0 && out.length < max; i--) {
    if (skip(plain[i], i)) {
      if (out.length) break; // reached the gap above the block
      continue; // still below it — keep descending
    }
    out.unshift(plain[i]);
  }
  return out;
}

/**
 * The task panel's header line, e.g. `7 tasks (3 done, 1 in progress, 3 open)`
 * (also `1 task (…)`). Requires at least one of the TUI's own status words inside
 * the parens so ordinary prose ("3 tasks (see below)") can't open a panel.
 */
export const TASK_PANEL_HEADER_RE = /^\d+\s+tasks?\s+\([^)]*\b(?:done|in progress|open|pending)\b[^)]*\)$/i;

/**
 * The same header with the vocabulary and the closing `)` dropped — the SHAPE only.
 * Used solely by `liveStatusLines`, which needs to get *past* a panel rather than
 * decide whether one exists, and which pays a fail-dangerous price for a header it
 * fails to recognize: an unmarked panel row ends the walk before the status row and
 * a generating pane reads `ready`. This shape survives a reworded count
 * (`(2 completed, 3 remaining)`) and a header wrapped on a narrow pane, neither of
 * which the strict form does.
 *
 * `paneUsageLimited` keeps the strict form on purpose: over-marking there hides an
 * active limit notice, so its error has the opposite sign.
 *
 * The cost, stated: dropping the wording test lets PROSE open a run — a sentence
 * like `3 tasks (one per repo):` — and the rows under it are then matched by the
 * permissive TASK_PANEL_ROW_RE, `●` and `✔` included. A marker quoted above such a
 * run can therefore be reached. It needs the status row to be absent, the prose line
 * to be digit-led, and a contiguous bullet run directly beneath it with no blank
 * between; and it fails in the false-busy direction this file accepts. Anchoring the
 * loose form on the closing `)` would not help: that is exactly what a header
 * wrapped on a narrow pane loses. Pinned in the detection suite as a known limit,
 * with the two controls that close it.
 */
export const LOOSE_TASK_PANEL_HEADER_RE = /^\d+\s+tasks?\s+\(/i;

/**
 * A row *inside* an already-opened task panel: a status-glyph item line
 * (`◼ WebRTC session…` in progress, `◻ UI: pair code…` open, `✔ Gradle skeleton…`
 * done) or the elision footer (`… +2 completed`). Only ever applied to the
 * contiguous run directly beneath a matched header (see taskPanelLines), so the
 * glyph set can stay permissive without swallowing turn output that happens to
 * start with `✔`.
 */
export const TASK_PANEL_ROW_RE = /^(?:[◼◻◐◌●○☐☑✔✓✗]\s+\S|…\s*\+\d+\b)/;

/**
 * Indices of the lines belonging to the TUI's TASK PANEL — the persistent
 * `N tasks (…)` summary plus its item rows, which Claude Code renders directly
 * above the input box while a task list exists. It is standing UI, not
 * conversation content: it stays on screen unchanged across turns, so counting it
 * as "the last content block" hid an active usage-limit notice sitting just above
 * it and made a blocked session read `ready` (the field miss this exists for).
 *
 * Found structurally — a header line, then the contiguous run of rows beneath it —
 * rather than by matching item glyphs anywhere on screen, so a turn-output line
 * that merely starts with one of those glyphs is still content. That header is what
 * LICENSES the permissive glyph set: `●`, `✔` and `✗` are also how ordinary turn
 * output is bulleted, and marking them unlicensed reads the conversation as UI.
 *
 * `header` is which header opens a run, and both callers pass it explicitly — there
 * is no sensible default, because the two scans need OPPOSITE strictness: a header
 * `paneUsageLimited` wrongly accepts hides an active limit notice, while one
 * `liveStatusLines` wrongly rejects hides a live spinner. `lines` are ANSI-stripped
 * and trimmed.
 */
export function taskPanelLines(lines: string[], header: RegExp): Set<number> {
  const marked = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!header.test(lines[i])) continue;
    marked.add(i);
    for (let j = i + 1; j < lines.length && TASK_PANEL_ROW_RE.test(lines[j]); j++) marked.add(j);
  }
  return marked;
}
