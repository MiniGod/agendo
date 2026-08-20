import { SELF_CMD, notRunningHint } from "../launch.ts";
import {
  capturePaneState, liveTargetForShortId, paneReadiness, paneResumeDialogActive, sendResume, shortId, stripAnsi,
} from "../tmux.ts";
import { paneResetAt } from "../usageLimit.ts";

/**
 * Send the resume keystrokes (`<esc>continue<enter>`) to a session sitting at
 * its usage limit. Refuses unless the pane still reads "limited" (so a session
 * that already recovered isn't clobbered), overridable with `--force`.
 */
export async function runUnblock(token: string | undefined, force: boolean): Promise<void> {
  if (!token) {
    console.error(`usage: ${SELF_CMD} unblock <id> [--force]`);
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const target = liveTargetForShortId(sid);
  if (!target) {
    console.error(`Session ${token} is not running (no live tmux window to unblock).`);
    console.error(notRunningHint(token, "then unblock it"));
    process.exit(1);
  }
  const { raw, cursor } = capturePaneState(target);
  const readiness = paneReadiness(raw, cursor);
  // The resume keystrokes lead with Escape, which on claude's own resume dialog
  // is its "Esc to cancel" — it would cancel the resume rather than unblock
  // anything. Refused even with --force: there is no reading of `unblock` under
  // which cancelling a resume is what the user meant. (The pane can still LOOK
  // limited here — the previous run's notice is replayed above the dialog.)
  if (paneResumeDialogActive(raw)) {
    console.error(
      `Not unblocking: the session is sitting on claude's resume dialog, and the resume keystrokes ` +
        `lead with Escape — which would cancel it. Use \`${SELF_CMD} send ${token} "<prompt>"\`, which answers the dialog.`,
    );
    process.exit(2);
  }
  if (readiness !== "limited" && !force) {
    console.error(`Not unblocking: session looks "${readiness}", not limited. Pass --force to send anyway.`);
    process.exit(2);
  }
  sendResume(target);
  const resetAt = readiness === "limited" ? paneResetAt(stripAnsi(raw)) : null;
  console.log(
    `▸ unblocked ${target}${readiness !== "limited" ? ` (forced; was "${readiness}")` : resetAt !== null ? ` (reset was ${new Date(resetAt).toISOString()})` : ""}`,
  );
}
