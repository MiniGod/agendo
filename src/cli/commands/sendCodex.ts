// The pane route's codex branch: deliver with read-back (see codexDelivery.ts)
// and say exactly how far it got. Split from send.ts, which is the pane route's
// decision-making; this is only its codex outcome and its wording.
import { SELF_CMD } from "../../launch/index.ts";
import { CODEX_TURN_START_MS, codexPaneIo, deliverToCodex, type CodexDelivery, type LiveTarget } from "../../runtime/tmux/index.ts";

/**
 * The slice of send.ts's `SendContext` this needs, spelled out here rather than
 * imported so the two modules don't import each other.
 */
interface CodexSendContext {
  token: string;
  target: LiveTarget | null;
  say: (line: string) => void;
  finish: (o: { ok: boolean; route: "pane" | null; reason?: string; extra?: Record<string, unknown> }, code: number) => Promise<never>;
}

/**
 * Type `prompt` into the codex pane behind `ctx` and finish with what happened.
 * `why` is the route explanation `send` already composed; `extra` the payload
 * fields it already knows.
 *
 * A failure exits 1 and says what is now on the screen, because the caller has
 * a decision to make that a bare "failed" would get wrong: a message left in the
 * box would go twice if simply re-sent. The one exception is a box agendo could
 * not read before typing — nothing was typed, so that is a refusal like the
 * others in `send`, exit 2.
 */
export async function sendToCodex(ctx: CodexSendContext, prompt: string, why: string, extra: Record<string, unknown>): Promise<never> {
  const target = ctx.target!; // non-null: the caller read this pane
  const d = await deliverToCodex(codexPaneIo(target.target), prompt);
  const fields = { ...extra, enters: d.enters, turnStarted: d.turnStarted, held: d.held };
  if (d.ok) {
    ctx.say(`▸ pasted into pane ${target.name}${why}, and codex took it${d.held ? " (held until its startup finishes, then it runs)" : ""}`);
    if (d.turnStarted === false) {
      console.error(`  note: codex took the message, but its pane didn't show a turn running within ${CODEX_TURN_START_MS / 1000}s — the turn may not have started.`);
    }
    return ctx.finish({ ok: true, route: "pane", extra: fields }, 0);
  }
  console.error(codexFailureMessage(ctx.token, d));
  const typed = d.reason !== "unreadable";
  return ctx.finish({ ok: false, route: typed ? "pane" : null, reason: d.reason, extra: { ...fields, composer: d.composer } }, typed ? 1 : 2);
}

/** What went wrong, what is on the screen now, and what NOT to do about it. */
export function codexFailureMessage(token: string, d: CodexDelivery): string {
  const box = d.composer ? ` It now reads: ${JSON.stringify(d.composer.length > 200 ? `${d.composer.slice(0, 200)}…` : d.composer)}.` : "";
  const look = `Look at the pane before retrying (\`${SELF_CMD} status ${token}\`, or attach to it)`;
  switch (d.reason) {
    case "unreadable":
      return `Not sending: couldn't read codex's input box, so nothing was typed. Re-check with \`${SELF_CMD} status ${token}\`.`;
    case "not-ingested":
      return `Not delivered: pasted into codex's pane, but agendo couldn't see the text arrive in its input box, so Enter was NOT pressed. Whatever did arrive is sitting there unsent. ${look}, or the message may go twice.`;
    case "not-submitted":
      return `Not delivered: the message is in codex's input box, but codex didn't take it after ${d.enters} Enter presses. It is still there, unsent. ${look}: press Enter yourself, or clear it before sending again.${box}`;
    case "draft-rewritten":
      return `Not delivered: after Enter, codex changed the message in its input box (a completion popup, most likely), so agendo stopped pressing keys. Nothing was submitted.${box} ${look}.`;
    default:
      return `Not confirmed: after Enter, codex's input box could no longer be read (a dialog may have opened), so agendo stopped pressing keys and can't say whether the message was taken. ${look}.`;
  }
}
