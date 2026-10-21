// A floor on how often an agendo:// LINK may resume a session.
//
// Focusing is free, but resuming starts an agent process, and any web page can
// fire agendo:// links — in a loop, if the browser was told to "always" allow
// them, which in some browsers is a choice for every site at once. So a resume
// that came in through a link has to wait `URL_RESUME_GAP_MS` after the previous
// one. A human clicking a button never notices; a page walking `?pr=1…N` gets
// one resume, not N. `agendo focus` typed in a terminal is not throttled.
import { mkdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { STATE_DIR } from "../../app/config.ts";

export const URL_RESUME_GAP_MS = 15_000;

const STAMP = join(STATE_DIR, "url-resume.stamp");

/** Milliseconds still to wait, given when the last link-resume happened (null: never). */
export function resumeWaitMs(lastMs: number | null, nowMs: number, gapMs = URL_RESUME_GAP_MS): number {
  if (lastMs === null || lastMs > nowMs) return 0;
  return Math.max(0, lastMs + gapMs - nowMs);
}

function lastStampMs(): number | null {
  try {
    return statSync(STAMP).mtimeMs;
  } catch {
    return null;
  }
}

/** How long a link must wait before it may resume; 0 means go, and records this resume. */
export function claimUrlResume(nowMs = Date.now()): number {
  const wait = resumeWaitMs(lastStampMs(), nowMs);
  if (wait > 0) return wait;
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STAMP, String(nowMs));
  } catch {
    // An unwritable state dir costs the throttle, never the focus.
  }
  return 0;
}
