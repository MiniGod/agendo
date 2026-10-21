// Floors on how often agendo:// LINKS may act.
//
// Any web page can fire agendo:// links — in a loop, if the browser was told to
// "always" allow them, which in some browsers is a choice for every site at once.
// Two floors bound what that costs:
//
//  • RESUME: resuming starts an agent process, so a resume that came in through
//    a link has to wait `URL_RESUME_GAP_MS` after the previous one. A page
//    walking `?pr=1…N` wakes one session per 15s, not N at once.
//  • FOCUS: links at all are held to one per `URL_FOCUS_GAP_MS`, so a burst is
//    one link. A refused link is notified, but those notes have a floor of
//    their own (`claimRefusalNote`): a burst's refusals are at most one
//    notification per gap. The link let through stamps that floor too when it
//    notifies, so refusals behind it stay quiet; its own outcome — a real
//    failure — is always said.
//
// Neither stops a page from moving the terminal while the human types in it —
// one switch every two seconds is plenty for that. What stops it is in
// src/cli/focus/index.ts: a link never moves a client that was typed into in the
// last few seconds; its refusal shares the refusal-note floor above. `agendo
// focus` typed in a terminal is not throttled.
//
// Each claim is atomic: two links fired at once (frames, tabs) must not both read
// "no stamp yet" and both go. A `mkdir` lock serialises the read-and-stamp, and a
// link that finds the lock held is simply refused — a concurrent claim is exactly
// the burst a floor exists for. A state dir agendo cannot write refuses too —
// without a stamp there is no floor — but as an error, said once, not a wait.
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

/** What a claim came to: go, wait this long, or the floor cannot be kept at all. */
export type Claim = { go: true } | { waitMs: number } | { error: string };

const errText = (e: unknown) => (e as Error)?.message ?? String(e);

/**
 * Take the lock. Held by another claim: wait (a stale one is cleared for the NEXT
 * link, not taken over). Any other failure — no state dir, no permission — is an
 * error, not a wait: it will not clear by itself, and saying "try again" forever
 * would hide it.
 */
function lock(dir: string, lockPath: string, gapMs: number, nowMs: number): Claim {
  try {
    // Apart from the lock's own mkdir: a recursive mkdir over a FILE fails with
    // EEXIST too, which must read as the error it is, not as a held lock.
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { error: errText(e) };
  }
  try {
    mkdirSync(lockPath);
    return { go: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return { error: errText(e) };
    return clearIfStale(lockPath, gapMs, nowMs);
  }
}

/** A held lock: wait — after clearing it for the NEXT link when it is stale. */
function clearIfStale(lockPath: string, gapMs: number, nowMs: number): Claim {
  if (nowMs - (mtimeMs(lockPath) ?? nowMs) <= STALE_LOCK_MS) return { waitMs: gapMs };
  try {
    rmSync(lockPath, { recursive: true, force: true });
    return { waitMs: gapMs };
  } catch (e) {
    return { error: errText(e) };
  }
}

/** Read the stamp and, when the gap has passed, renew it. Runs under the lock. */
function stampIfDue(stamp: string, gapMs: number, nowMs: number): Claim {
  const wait = resumeWaitMs(mtimeMs(stamp), nowMs, gapMs);
  if (wait > 0) return { waitMs: wait };
  writeFileSync(stamp, String(nowMs));
  return { go: true };
}

/** Claim floor `name`: go (and record it), wait, or the error that keeps it from being kept. `dir` is injected for tests. */
export function claimFloor(name: string, gapMs: number, nowMs = Date.now(), dir = STATE_DIR): Claim {
  const lockPath = join(dir, `${name}.lock`);
  const locked = lock(dir, lockPath, gapMs, nowMs);
  if (!("go" in locked)) return locked;
  try {
    return stampIfDue(join(dir, `${name}.stamp`), gapMs, nowMs);
  } catch (e) {
    // A stamp that cannot be written cannot hold the floor: refuse rather than run unthrottled.
    return { error: errText(e) };
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

/** The resume floor (see the header). */
export function claimUrlResume(nowMs = Date.now()): Claim {
  return claimFloor("url-resume", URL_RESUME_GAP_MS, nowMs);
}

/** The focus floor (see the header). */
export function claimUrlFocus(nowMs = Date.now()): Claim {
  return claimFloor("url-focus", URL_FOCUS_GAP_MS, nowMs);
}

/** The floor on notifying refused links (see the header). */
export function claimRefusalNote(nowMs = Date.now()): Claim {
  return claimFloor("url-refused-note", URL_FOCUS_GAP_MS, nowMs);
}
