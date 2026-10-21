// A floor on how often an agendo:// LINK may resume a session.
//
// Focusing is free, but resuming starts an agent process, and any web page can
// fire agendo:// links — in a loop, if the browser was told to "always" allow
// them, which in some browsers is a choice for every site at once. So a resume
// that came in through a link has to wait `URL_RESUME_GAP_MS` after the previous
// one. A human clicking a button never notices; a page walking `?pr=1…N` gets
// one resume, not N. `agendo focus` typed in a terminal is not throttled.
//
// The claim is atomic: two links fired at once (frames, tabs) must not both read
// "no stamp yet" and both resume. A `mkdir` lock serialises the read-and-stamp,
// and a link that finds the lock held is simply refused — a concurrent claim is
// exactly the burst the floor exists for. So is a state dir agendo cannot write:
// without a stamp there is no floor, and a link then only focuses.
import { mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../../app/config.ts";

export const URL_RESUME_GAP_MS = 15_000;

/** A lock older than this was left by a process that died mid-claim. */
const STALE_LOCK_MS = 5_000;

const STAMP = join(STATE_DIR, "url-resume.stamp");
const LOCK = join(STATE_DIR, "url-resume.lock");

/** Milliseconds still to wait, given when the last link-resume happened (null: never). */
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
function lock(nowMs: number): boolean {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    mkdirSync(LOCK);
    return true;
  } catch {
    if (nowMs - (mtimeMs(LOCK) ?? nowMs) > STALE_LOCK_MS) rmSync(LOCK, { recursive: true, force: true });
    return false;
  }
}

/** Read the stamp and, when the gap has passed, renew it. Runs under the lock. */
function stampIfDue(nowMs: number): number {
  const wait = resumeWaitMs(mtimeMs(STAMP), nowMs);
  if (wait === 0) writeFileSync(STAMP, String(nowMs));
  return wait;
}

/** How long a link must wait before it may resume; 0 means go, and records this resume. */
export function claimUrlResume(nowMs = Date.now()): number {
  if (!lock(nowMs)) return URL_RESUME_GAP_MS;
  try {
    return stampIfDue(nowMs);
  } catch {
    // A stamp that cannot be written cannot hold the floor: refuse rather than run unthrottled.
    return URL_RESUME_GAP_MS;
  } finally {
    rmSync(LOCK, { recursive: true, force: true });
  }
}
