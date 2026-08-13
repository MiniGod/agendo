// Idle age, and the "stalled" qualifier layered on top of it.
//
// WHY: `readiness` (from the live pane) answers "can I send to this session
// right now?" — it says nothing about *when* the session last did anything. A
// session that fell over at the end of a turn 22 hours ago renders exactly like
// one that finished cleanly 20 seconds ago: both are "ready". An orchestrator
// then has to fetch the last message and judge the prose to tell them apart.
//
// So we surface the age of the last activity alongside readiness, and flag the
// sessions that have been settled for implausibly long. Readiness itself is
// untouched — `ready`/`busy`/`limited`/`dialog` are load-bearing for `send`,
// `wait` and auto-resume. This is a QUALIFIER, never a new readiness state.
//
// HONESTY: agendo cannot know whether a session's work is *finished*. It knows
// only that nothing has been appended to its transcript for N hours while its
// window is still alive and not mid-turn. "stalled" means exactly that and the
// output says so; it is a prompt to go look, not a verdict.
//
// The default itself (4 hours) lives in src/config.ts next to the config shape.
// Why four hours: a live session that isn't busy is, by definition, doing
// nothing — the only legitimate reason for a long gap is that the human hasn't
// come back to it yet. So the threshold isn't "how long can work take", it's
// "how long before a gap stops looking like a coffee break". Under an hour would
// flag every session someone stepped away from over lunch; 4 hours is past the
// point where it's plausibly still the same working block, while still catching
// a session that died mid-afternoon on the same day.
import { DEFAULT_STALLED_AFTER_MINUTES, loadConfig } from "./config.ts";
import { WORKING_READINESS, type Readiness } from "./tmux.ts";

/**
 * The effective stall threshold in ms. Precedence: an explicit
 * `--stalled-after` (already parsed and validated by the caller's
 * `requireDuration`, which exits on anything malformed) beats
 * `stalledAfterMinutes` from config.json, which beats the default. A configured
 * value that isn't a non-negative number is ignored rather than obeyed — a
 * typo'd config must not silently mark every session stalled, or none.
 */
export function resolveStalledAfterMs(overrideMs?: number | null): number {
  if (overrideMs != null) return overrideMs;
  const mins = loadConfig().stalledAfterMinutes;
  const valid = typeof mins === "number" && Number.isFinite(mins) && mins >= 0;
  return (valid ? mins : DEFAULT_STALLED_AFTER_MINUTES) * 60_000;
}

/**
 * Whole seconds since a session's last recorded activity. Clamped at 0 so a
 * transcript mtime slightly in the future (clock skew, a file copied forward)
 * reports "just now" rather than a negative age.
 */
export function idleSeconds(lastUsed: Date, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - lastUsed.getTime()) / 1000));
}

/** The inputs the stall verdict is derived from. */
export interface StallInput {
  /** Whether the session has a live tmux window right now. */
  running: boolean;
  /** Readiness read from that window's pane, or null when none could be read. */
  readiness: Readiness | null;
  /** Seconds since the session's last recorded activity. */
  idleSeconds: number;
}

/**
 * Whether a session is stalled: it is still LIVE, its pane says it is not
 * mid-turn, and nothing has happened for at least the threshold.
 *
 * Every condition is there to keep the flag quiet unless it means something:
 *
 *  • A live window is required. A session whose window is gone is simply not
 *    running — flagging those would make every session on disk permanently
 *    "stalled" as it ages. For them, `running: false` plus the idle age (and
 *    `git.unpushed`, see src/gitrefs.ts) already tells the story.
 *  • A busy/compacting session is never stalled however old its transcript
 *    mtime looks — it is demonstrably alive and working.
 *  • An unreadable pane (`readiness === null` while nominally running — a
 *    restored-but-unopened placeholder tab, or a window we couldn't capture)
 *    is not stalled either: we cannot see that it ISN'T working, and a dormant
 *    placeholder has no agent in it to stall in the first place.
 */
export function isStalled(o: StallInput, thresholdMs: number): boolean {
  if (!o.running || o.readiness === null) return false;
  if (WORKING_READINESS.has(o.readiness)) return false;
  return o.idleSeconds * 1000 >= thresholdMs;
}

/** Compact age for humans, single-unit and rounded down: `45s`, `12m`, `22h`, `3d`. */
export function shortAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/**
 * A configured duration, printed WITHOUT losing precision — unlike `shortAge`,
 * which is single-unit and would render a 90-minute threshold as "1h" and a
 * sub-second one as "0s". Used wherever we quote the threshold back to the user,
 * so what they configured is what they see: `1h30m`, `4h`, `1m`, `500ms`.
 */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const total = Math.round(ms / 1000);
  const parts = [
    Math.floor(total / 86_400) ? `${Math.floor(total / 86_400)}d` : "",
    Math.floor((total % 86_400) / 3600) ? `${Math.floor((total % 86_400) / 3600)}h` : "",
    Math.floor((total % 3600) / 60) ? `${Math.floor((total % 3600) / 60)}m` : "",
    total % 60 ? `${total % 60}s` : "",
  ];
  return parts.filter(Boolean).join("") || "0s";
}
