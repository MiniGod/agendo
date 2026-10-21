// Floors on how often agendo:// LINKS may act.
//
// Any web page can fire agendo:// links — in a loop, if the browser was told to
// "always" allow them, which in some browsers is a choice for every site at once.
// Two floors keep that from mattering:
//
//  • RESUME: resuming starts an agent process, so a resume that came in through
//    a link has to wait `URL_RESUME_GAP_MS` after the previous one. A page
//    walking `?pr=1…N` gets one resume, not N.
//  • FOCUS: every link moves the terminal the human last typed into. A page
//    firing links on a timer could yank it onto an agent's window mid-sentence
//    and land their keystrokes in its prompt, so links at all are held to one
//    per `URL_FOCUS_GAP_MS`.
//
// A human clicking a button never notices either. `agendo focus` typed in a
// terminal is not throttled.
//
// Each claim is atomic: two links fired at once (frames, tabs) must not both read
// "no stamp yet" and both go. A `mkdir` lock serialises the read-and-stamp, and a
// link that finds the lock held is simply refused — a concurrent claim is exactly
// the burst a floor exists for. So is a state dir agendo cannot write: without a
// stamp there is no floor, so the link is refused.
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../../app/config.ts";

export const URL_RESUME_GAP_MS = 15_000;
export const URL_FOCUS_GAP_MS = 2_000;

/** A lock older than this was left by a process that died mid-claim. */
export const STALE_LOCK_MS = 5_000;

/** Milliseconds still to wait, given when the last claim happened (null: never). */
export function resumeWaitMs(lastMs: number | null, nowMs: number, gapMs = URL_RESUME_GAP_MS): number {
  if (lastMs === null || lastMs > nowMs) return 0;
  return Math.max(0, lastMs + gapMs - nowMs);
}

function mtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Take the lock; false when another claim holds it (a stale one is cleared for the NEXT link, not taken over). */
function lock(dir: string, lockPath: string, nowMs: number): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(lockPath);
    return true;
  } catch {
    if (nowMs - (mtimeMs(lockPath) ?? nowMs) > STALE_LOCK_MS) rmSync(lockPath, { recursive: true, force: true });
    return false;
  }
}

/** Read the stamp and, when the gap has passed, renew it. Runs under the lock. */
function stampIfDue(stamp: string, gapMs: number, nowMs: number): number {
  const wait = resumeWaitMs(mtimeMs(stamp), nowMs, gapMs);
  if (wait === 0) writeFileSync(stamp, String(nowMs));
  return wait;
}

/** How long a `name` claim must still wait; 0 means go, and records this claim. `dir` is injected for tests. */
export function claimFloor(name: string, gapMs: number, nowMs = Date.now(), dir = STATE_DIR): number {
  const lockPath = join(dir, `${name}.lock`);
  if (!lock(dir, lockPath, nowMs)) return gapMs;
  try {
    return stampIfDue(join(dir, `${name}.stamp`), gapMs, nowMs);
  } catch {
    // A stamp that cannot be written cannot hold the floor: refuse rather than run unthrottled.
    return gapMs;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** The resume floor (see the header). */
export function claimUrlResume(nowMs = Date.now()): number {
  return claimFloor("url-resume", URL_RESUME_GAP_MS, nowMs);
}

/** The focus floor (see the header). */
export function claimUrlFocus(nowMs = Date.now()): number {
  return claimFloor("url-focus", URL_FOCUS_GAP_MS, nowMs);
}
