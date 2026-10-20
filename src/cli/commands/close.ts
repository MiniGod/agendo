import { SELF_CMD } from "../../launch/index.ts";
import {
  endSession, type AlreadyPaused, type EndAction, type Ended, type FoundSession, type NotRunning, type Refusal,
} from "../../app/sessionEnd/index.ts";
import type { Readiness } from "../../runtime/tmux/index.ts";

/**
 * `agendo close <id>` / `agendo pause <id>`: end a running session — kill the
 * tmux target it lives in, a window in a host session, a pane, or the whole
 * session when the agent was launched outside tmux — and, for a pause, leave a
 * restore placeholder in its tab. The guards and the kill live in
 * src/app/sessionEnd/, shared with the list's `x`/`X`/`p` keys; this is the CLI's
 * reading of their verdict: stdout on success, stderr and an exit code on a
 * refusal (2 — "I could, but I won't", which `--force` overrides) or an error
 * (1).
 *
 * WHAT IT DOES NOT TOUCH — this is a guarantee of the command, not a hope.
 * Nothing under a worktree is read, moved or removed: the worktree, its branch
 * and every commit in it survive, and the session's transcript stays on disk so
 * `agendo resume <id>` restarts it.
 */
export async function runClose(token: string | undefined, force: boolean, verb = "close"): Promise<void> {
  if (!token) usageExit(verb);
  const action = verbAction(verb);
  report(await endSession(token, action, force), action);
}

/** `pause` pauses; `close` and its aliases (`kill`, `stop`) close. */
export function verbAction(verb: string): EndAction {
  return verb === "pause" ? "pause" : "close";
}

function report(outcome: Refusal | NotRunning | AlreadyPaused | Ended, action: EndAction): void {
  if (outcome.kind === "refused") return refuse(outcome);
  if (outcome.kind === "notRunning") return reportNotRunning(outcome.found, action);
  if (outcome.kind === "alreadyPaused") return reportAlreadyPaused(outcome.found, outcome.target);
  if (outcome.action === "pause") return reportPaused(outcome.target, outcome.found, outcome.readiness);
  reportClosed(outcome.target, outcome.found, outcome.placeholder, outcome.readiness);
}

export function usageExit(verb: string): never {
  console.error(`usage: ${SELF_CMD} ${verb} <id> [--force]`);
  process.exit(1);
}

/** A refusal or an error: its message, the pane tail that explains it, and its exit code. */
export function refuse(r: Refusal): never {
  console.error(r.message);
  if (r.screen) {
    console.error(`\n  current screen (tail):`);
    for (const l of r.screen) console.error(`    ${l}`);
  }
  process.exit(r.code);
}

/**
 * Already closed / never started. The desired end state holds, so this is a
 * success — `close` is idempotent for the scripts and agents driving it. The
 * caller may have expected a live session here, though; an indexed one can
 * still be brought back (an unindexed id has nothing to resume).
 */
export function reportNotRunning(found: Pick<FoundSession, "s" | "label">, verb = "close"): void {
  console.log(`○ session ${found.label} is not running — nothing to ${verb}.`);
  if (found.s) console.log(`  resume:  ${SELF_CMD} resume ${found.label}   (its worktree, branch and commits are intact)`);
}

/** A pause of a tab that is already the paused placeholder: also a success. */
export function reportAlreadyPaused(found: Pick<FoundSession, "label">, target: string): void {
  console.log(`⏸ session ${found.label} is already paused (${target}) — nothing to do.`);
  console.log(`  resume:  ${SELF_CMD} resume ${found.label}`);
}

/** What the closed line says the target was, when it was not simply idle. */
export function closedSuffix(placeholder: boolean, readiness: Readiness | null): string {
  if (placeholder) return " (unopened restore tab)";
  return readiness && readiness !== "ready" ? ` (was "${readiness}")` : "";
}

/**
 * Only an indexed session can be resumed by id — one whose transcript hasn't
 * landed yet has nothing for `resume` to find (that's why it took the
 * window-name path to get here in the first place).
 */
export function reportClosed(target: string, found: Pick<FoundSession, "s" | "label">, placeholder: boolean, readiness: Readiness | null): void {
  console.log(`▸ closed ${target}${closedSuffix(placeholder, readiness)}`);
  console.log(`  kept:    worktree, branch and commits are untouched${found.s ? ` in ${found.s.cwd}` : ""}`);
  if (found.s) console.log(`  resume:  ${SELF_CMD} resume ${found.label}`);
}

/** A pause only ever succeeds for an indexed session (it needs a transcript to resume). */
export function reportPaused(target: string, found: Pick<FoundSession, "s" | "label">, readiness: Readiness | null): void {
  console.log(`⏸ paused ${target}${closedSuffix(false, readiness)} — its tab waits for a keypress`);
  console.log(`  kept:    worktree, branch and commits are untouched${found.s ? ` in ${found.s.cwd}` : ""}`);
  console.log(`  resume:  ${SELF_CMD} resume ${found.label}   (or press a key in its tab)`);
}
