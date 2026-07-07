// Detecting — and optionally recovering from — Claude Code's "usage limit
// reached" screen. When a session exhausts its 5-hour rolling window or its
// weekly cap, Claude Code stops mid-flight and prints a notice in the pane,
// usually naming *when* the limit resets. To agendo such a session otherwise
// looks stalled (idle input box, no spinner), so we classify it explicitly and,
// when configured, nudge it to continue the moment the window reopens.
//
// A limited session shows the cap in one of two observed forms, and BOTH must
// classify as "limited":
//
//  (A) The NUMBERED CHOICE DIALOG — the primary, interactive state a limited
//      session sits in (captured verbatim, read-only, from a live limited pane):
//        What do you want to do?
//        ❯ 1. Stop and wait for limit to reset
//          2. Add funds to continue with usage credits
//        Enter to confirm · Esc to cancel
//      This dialog does NOT show the reset time. Pressing Escape ONCE dismisses
//      it and reveals form (B). We detect it by its two durable option lines (see
//      LIMIT_DIALOG_RE) — passive detection that works WITHOUT a timestamp.
//
//  (B) The TEXT NOTICE — the reset-time-bearing form. On a REAL limited session it
//      renders inside a tool result block (a leading ⎿ glyph, NBSP padding, a `·`
//      separator), sometimes with a "/usage-credits" continuation line, sometimes
//      without (both observed live):
//        ⎿  You've hit your session limit · resets 2:10pm (Atlantic/Reykjavik)
//        ⎿  You've hit your session limit · resets 7:20pm (Atlantic/Reykjavik)
//           /usage-credits to finish what you're working on.
//      Plus the historically-worded caps:
//        • 5-hour:  "Claude usage limit reached. Your limit will reset at 3pm (America/Santiago)."
//        • weekly:  "You've reached your weekly limit" / "Resets by 4:00 AM Friday Apr 24"
//
// We anchor on the DURABLE tokens ("hit/reached your … limit", "usage limit
// reached", the "/usage-credits" hint, the dialog's option wording) plus a
// separately-parsed reset time — never a brittle full-string match — so copy
// tweaks, the ⎿ prefix, NBSP padding and line-wrapping don't break detection.
import type { Readiness } from "./tmux.ts";

/**
 * Stable-token match for the usage-limit notice, on already-plain (ANSI-stripped)
 * text with whitespace normalized (see isUsageLimited). Covers every observed
 * cap and tolerates copy variation:
 *   - "You've hit your session limit"           (the real session/credit cap)
 *   - "reached your weekly/usage/5-hour limit"   ("You've reached your weekly limit")
 *   - "usage limit reached"                      (the canonical 5-hour line)
 *   - "weekly/5-hour/… limit reached"
 *   - "/usage-credits"                           (the credit-cap continuation hint)
 * The "hit/reached your … limit" arm keeps the qualifier constrained to Claude's
 * own cap names so unrelated prose ("reached your rate limit for the OpenAI API",
 * "up to its length limit") doesn't trip it.
 */
export const USAGE_LIMIT_RE =
  /\busage limit reached\b|\b(?:hit|reached) your (?:(?:5-hour|weekly|hourly|daily|usage|session|monthly)\s+)?limit\b|\b(?:5-hour|weekly|hourly|daily|session|usage)\s+limit\s+reached\b|\/usage-credits\b/i;

/**
 * Whether ANSI-stripped pane text shows a usage-limit notice. Tested against a
 * whitespace-normalized copy (collapsing runs of spaces/NBSP/newlines to one
 * space) so the ⎿ result-block prefix, NBSP padding, and any line-wrapping of
 * the notice can't split a token we're matching on.
 */
export function isUsageLimited(plain: string): boolean {
  return USAGE_LIMIT_RE.test(plain) || USAGE_LIMIT_RE.test(plain.replace(/\s+/g, " "));
}

/**
 * The numbered limit dialog (form A above), matched on its two durable option
 * lines. Either alone suffices — both are specific enough to the limit menu that
 * they never appear as ordinary prose, and matching either survives line-wrapping
 * or one option being clipped:
 *   - "Stop and wait for limit to reset"
 *   - "Add funds to continue with usage credits"
 * The dialog carries NO reset time; it's what a limited session shows by default,
 * so this is the load-bearing PASSIVE signal. Whether it's the *active* dialog
 * (vs. the same text left in scrollback after dismissal) is decided structurally
 * in tmux.ts, which anchors on the absence of an input box below it.
 */
export const LIMIT_DIALOG_RE =
  /\bstop and wait for (?:the |your )?limit to reset\b|\badd funds to continue with usage credits\b/i;

/**
 * Whether ANSI-stripped text shows the numbered limit dialog. Like isUsageLimited,
 * tested against a whitespace-normalized copy too so NBSP padding / wrapping can't
 * split a matched phrase.
 */
export function isLimitDialog(plain: string): boolean {
  return LIMIT_DIALOG_RE.test(plain) || LIMIT_DIALOG_RE.test(plain.replace(/\s+/g, " "));
}

// ── reset-time parsing ─────────────────────────────────────────────────────────
// The notice's reset time comes in two observed shapes, both keyed off "reset":
//   A) "Your limit will reset at 3pm (America/Santiago)."  — time + optional IANA tz
//   B) "Resets by 4:00 AM Friday Apr 24"                   — time + optional weekday/date
// We parse whichever is present into an absolute instant relative to a supplied
// `now`, so callers can decide when the window has actually reopened. When no
// time is parseable we return null — the session is still reported as limited,
// but auto-resume can't run because we can't know when to act.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Wall-clock components of `date` as seen in IANA zone `tz`. */
function tzParts(tz: string, date: Date): { y: number; mo: number; d: number; h: number; mi: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

/** Offset (ms) of zone `tz` at instant `utcMs`, i.e. wall-clock − UTC. */
function tzOffsetMs(tz: string, utcMs: number): number {
  const p = tzParts(tz, new Date(utcMs));
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - utcMs;
}

/**
 * The UTC instant at which zone `tz`'s wall clock reads Y-M-D h:mi. Uses the
 * standard two-step offset refinement so it stays correct across DST changes.
 */
function zonedToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffsetMs(tz, guess);
  let inst = guess - off1;
  const off2 = tzOffsetMs(tz, inst);
  if (off2 !== off1) inst = guess - off2;
  return inst;
}

/** "today" in the given zone (or local time when `tz` is null). */
function todayIn(tz: string | null, now: Date): { y: number; mo: number; d: number } {
  if (tz) {
    const p = tzParts(tz, now);
    return { y: p.y, mo: p.mo, d: p.d };
  }
  return { y: now.getFullYear(), mo: now.getMonth() + 1, d: now.getDate() };
}

/** Build the absolute instant for wall-clock Y-M-D h:mi in `tz` (or local). */
function instantFor(tz: string | null, y: number, mo: number, d: number, h: number, mi: number): number {
  if (tz) return zonedToUtc(tz, y, mo, d, h, mi);
  return new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
}

/**
 * How far into the past a parsed reset instant may sit and still be treated as
 * "already reopened, act now" rather than rolled forward to the next occurrence.
 * A session first *seen* limited shortly after its own reset (the notice lingers
 * on screen) should resume immediately, not wait a day/week/year. Sized past the
 * weekly cap so a just-passed weekly reset still counts as current.
 */
export const RESET_LOOKBACK_MS = 8 * 24 * 3600_000;

/**
 * Parse the reset time out of a usage-limit notice into an absolute epoch-ms
 * instant, relative to `now`, or null if no time is present.
 *
 * `plain` should be ANSI-stripped. We scope parsing to the text *at/after* the
 * usage-limit phrase (so a stray "reset" in scrollback — `git reset`, prose —
 * can't hijack it), take the tail after the "reset(s) at/by" anchor, drop the
 * parenthesized timezone before scanning for a weekday/date (so zone names like
 * `America/Monterrey` aren't misread as "Monday"), and extract a time-of-day
 * plus an optional IANA timezone, weekday, and/or month+day.
 *
 * The result is the matching instant, rolled *forward* to the next occurrence
 * only when the candidate sits further in the past than `lookbackMs`:
 *   - date (month+day) → that calendar date (→ next year only if long past);
 *   - weekday only     → that weekday this week, else next week;
 *   - time only        → today, else tomorrow.
 * With `lookbackMs > 0`, a candidate in the recent past is returned as-is so the
 * caller can act now. An unparseable/invalid timezone falls back to local time —
 * the notice's zone is normally the user's own, safe for same-machine resume.
 */
export function parseResetTime(plain: string, now: Date, lookbackMs = 0): number | null {
  // Confine the search to the notice itself when the phrase is present.
  const phrase = plain.match(USAGE_LIMIT_RE);
  const region = phrase ? plain.slice(phrase.index) : plain;
  const anchor = region.match(/\breset[s]?(?:\s+(?:by|at))?\s+([^\n]*)/i);
  if (!anchor) return null;
  let tail = anchor[1];

  // Optional IANA timezone in parens, e.g. "(America/Santiago)". Extract, then
  // strip it from the tail so its letters can't feed the weekday/month scans.
  let tz: string | null = null;
  const tzMatch = tail.match(/\(([A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)\)/);
  if (tzMatch) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tzMatch[1] }); // throws for garbage
      tz = tzMatch[1];
    } catch {
      tz = null;
    }
    tail = tail.replace(tzMatch[0], " ");
  }

  // Time-of-day: "3pm", "3:30pm", "4:00 AM" (hour bounded 1-12 so a stray
  // "…30pm" from "4.30pm" can't match), or a 24h "15:30".
  let h: number, mi: number;
  const ampm = tail.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*([ap])\.?m\.?/i);
  if (ampm) {
    h = +ampm[1] % 12;
    if (/p/i.test(ampm[3])) h += 12;
    mi = ampm[2] ? +ampm[2] : 0;
  } else {
    const h24 = tail.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
    if (!h24) return null;
    h = +h24[1];
    mi = +h24[2];
  }

  const nowMs = now.getTime();
  const floor = nowMs - lookbackMs;

  // Optional explicit month + day ("Apr 24" / "April 24").
  const md = tail.match(/\b([A-Za-z]{3,})\.?\s+(\d{1,2})\b/);
  const monthIdx = md ? MONTHS[md[1].slice(0, 3).toLowerCase()] : undefined;

  if (monthIdx !== undefined) {
    const day = +md![2];
    const { y } = todayIn(tz, now);
    let inst = instantFor(tz, y, monthIdx + 1, day, h, mi);
    // Only roll to next year when the date is *long* past (a Dec→Jan window);
    // a recently-passed date stays put so the caller can resume now.
    if (inst < floor) inst = instantFor(tz, y + 1, monthIdx + 1, day, h, mi);
    return inst;
  }

  // Optional weekday ("Friday") without an explicit date.
  const wd = tail.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/i);
  const targetDow = wd ? WEEKDAYS[wd[1].slice(0, 3).toLowerCase()] : undefined;

  const { y, mo, d } = todayIn(tz, now);
  let inst = instantFor(tz, y, mo, d, h, mi);

  if (targetDow !== undefined) {
    const dow = new Date(instantFor(null, y, mo, d, 12, 0)).getDay();
    let offset = (targetDow - dow + 7) % 7;
    if (offset === 0 && inst < floor) offset = 7;
    if (offset > 0) {
      const base = new Date(instantFor(null, y, mo, d, 12, 0));
      base.setDate(base.getDate() + offset);
      inst = instantFor(tz, base.getFullYear(), base.getMonth() + 1, base.getDate(), h, mi);
    }
    return inst;
  }

  // Bare time-of-day: today unless it's further past than the lookback, then tomorrow.
  if (inst < floor) {
    const base = new Date(instantFor(null, y, mo, d, 12, 0));
    base.setDate(base.getDate() + 1);
    inst = instantFor(tz, base.getFullYear(), base.getMonth() + 1, base.getDate(), h, mi);
  }
  return inst;
}

// ── auto-resume decision ────────────────────────────────────────────────────────
// A small grace period past the stated reset before we act: Claude Code's window
// can lag its own countdown by a few seconds, and firing the moment the clock
// ticks over risks the "continue" landing while the pane is still limited (which,
// under fire-at-most-once, would burn our single shot). 30s is comfortably inside
// the poll cadence without being noticeable.
export const RESET_GRACE_MS = 30_000;

export interface AutoResumeInput {
  /** Whether the user enabled auto-resume (default OFF). */
  enabled: boolean;
  /** The pane's current readiness (must still be "limited" to act). */
  readiness: Readiness;
  /** Frozen reset instant (epoch ms) for the current limit window, or null. */
  resetAt: number | null;
  /** Current time (epoch ms) — injected so the decision is testable. */
  now: number;
  /** The resetAt we already fired for, or null — enforces fire-at-most-once. */
  firedFor: number | null;
  /** Override the grace period; defaults to RESET_GRACE_MS. */
  graceMs?: number;
}

/**
 * Pure decision: should we send the resume keystrokes now? True only when
 * auto-resume is on, the pane is *still* limited (so we never clobber a session
 * that already recovered), a reset time is known and has passed (plus grace),
 * and we haven't already fired for this exact reset window. Callers key
 * `firedFor` off the same `resetAt` so a fresh limit window (new reset instant)
 * is eligible again while the current one fires exactly once.
 */
export function shouldAutoResume(i: AutoResumeInput): boolean {
  if (!i.enabled) return false;
  if (i.readiness !== "limited") return false;
  if (i.resetAt == null) return false;
  if (i.firedFor === i.resetAt) return false;
  return i.now >= i.resetAt + (i.graceMs ?? RESET_GRACE_MS);
}
