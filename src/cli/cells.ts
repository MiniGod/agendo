import { paneCompactionPercent, stripAnsi, type Readiness } from "../tmux.ts";
import { formatResetTime, paneResetAt } from "../usageLimit.ts";
import { idleSeconds, shortAge } from "../idle.ts";

// The CLI tables and the TUI measure a fixed-width cell the same way, so the
// column helper lives in `ui/format.ts` and is re-exported here rather than
// reimplemented — `cells.ts` is where the CLI looks for its column helpers.
export { padCell } from "../ui/format.ts";

/**
 * Compact "last used" age for the list columns (matches the menu's timeAgo).
 * Built from the same `idleSeconds`/`shortAge` pair the `idle:` line and the
 * `--json` `idleSeconds` field use, so the age column can't disagree with them
 * at a bucket boundary.
 */
export function timeAgo(d: Date): string {
  return `${shortAge(idleSeconds(d))} ago`;
}

/**
 * The reset instant for a limited row, or null. Read-only: we parse whatever the
 * pane already shows and never send a keystroke to uncover it, so a session
 * parked in the numbered limit dialog — which hides the time until Escape —
 * legitimately yields null. Shares `paneResetAt` with `wait` and the TUI so the
 * three read the same screen the same way.
 */
export function rowResetAt(readiness: Readiness | null, raw: string): number | null {
  return readiness === "limited" ? paneResetAt(stripAnsi(raw)) : null;
}

/**
 * How far a compacting pane has got, or null for any other state. Gated on the
 * readiness for the same reason `rowResetAt` is: the bar belongs to *this* state,
 * and reading it off a pane that isn't compacting would report a stale number from
 * whatever else drew blocks on screen.
 */
export function rowCompactionPercent(readiness: Readiness | null, raw: string): number | null {
  return readiness === "compacting" ? paneCompactionPercent(raw) : null;
}

/**
 * The readiness column's text: the bare state word, plus whatever detail the state
 * itself carries — the locale-formatted reset time when a limited pane told us one
 * ("limited 14:00"), or the progress of a compaction ("compacting 42%"). No
 * placeholder when the pane didn't say — a plain "limited" / "compacting" is the
 * honest answer. The reset time is printed as stated even when it has already
 * passed (the pane's own claim, and a clock time the reader can compare to now);
 * the TUI, which has room, additionally distinguishes that case as "reset passed".
 *
 * The two details are mutually exclusive by construction (each is gated on its own
 * readiness), so at most one is ever appended.
 */
export function readyCell(readiness: Readiness | null, resetAt: number | null, percent: number | null): string {
  const word = readiness ?? "-";
  if (resetAt !== null) return `${word} ${formatResetTime(resetAt)}`;
  return percent === null ? word : `${word} ${percent}%`;
}

/**
 * Width of the readiness column: the usual 10 (fits every state word), widened
 * only as far as the longest `limited <time>` on screen so the columns after it
 * stay aligned whatever the locale's time format is.
 */
export function readyWidth(cells: string[]): number {
  return Math.max(10, ...cells.map((c) => c.length));
}
