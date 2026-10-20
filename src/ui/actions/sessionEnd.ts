// The list's `p` (pause), `x` (kill) and `X` (force-kill) on the hovered session,
// over the same guards and kill as `agendo pause` / `agendo close`
// (src/app/sessionEnd/). What is decided here is only what the user is told and
// asked: which rows the keys mean nothing on, the y/n question a kill puts up
// first, and the one-line notice each outcome becomes.
//
// Never touches a worktree, a branch or a transcript — that is the cleanup
// view's job, not this one's; the shared core guarantees it.
import {
  endSession, inspectEnd, performEnd, refused, type EndOutcome, type EndPlan, type Inspection, type Refusal,
} from "../../app/sessionEnd/index.ts";
import { sessionName } from "../../runtime/tmux/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import type { Row } from "../models/rows.ts";
import type { KeyContext, Mode } from "../keys/context.ts";
import { keySeq } from "../keys/keySeq.ts";

export type EndCtx = Pick<KeyContext, "rows" | "cursor" | "setNotice" | "setMode" | "reload" | "model">;

/**
 * One check or end at a time. The TUI keeps taking keys while tmux is asked: a
 * second `x` landing mid-kill would inspect a window that is half gone, and one
 * landing mid-check would race the first to put its question up.
 */
let inFlight = false;
const WAIT = "Still working on the last one — a moment.";

/** How a non-session row is named in the notice that says why the key did nothing. */
export function rowLabel(row: Row | undefined): string {
  if (row?.kind === "item") return "a work item";
  if (row?.kind === "pr") return "a pull request";
  return "not a session";
}

/**
 * Whether the row's session sits as a dormant restore placeholder. Asked of the
 * model rather than the row: only some row builders carry the flag (a search
 * result does not), while the model's set is what every one of them reads.
 */
export function isPaused(ctx: Pick<EndCtx, "model">, s: AgentSession): boolean {
  return ctx.model?.livePlaceholders.has(sessionName(s)) ?? false;
}

/**
 * Why `p` / `x` does nothing on this row, or null when it should go ahead. A
 * paused tab can be closed for good but not paused again; an idle session has
 * nothing to end at all.
 */
export function rowRefusal(row: Row | undefined, verb: "pause" | "kill", paused = false): string | null {
  if (row?.kind !== "session") return `${verb === "pause" ? "p pauses" : "x kills"} a running session — this row is ${rowLabel(row)}.`;
  if (row.running) return null;
  return idleRefusal(row.session.title, verb, paused || row.placeholder === true);
}

function idleRefusal(title: string, verb: "pause" | "kill", paused: boolean): string | null {
  if (!paused) return `${title} isn't running — nothing to ${verb}.`;
  return verb === "pause" ? `${title} is already paused — enter wakes it.` : null;
}

/** The one-line notice an outcome becomes. `force` only changes what a refusal suggests next. */
export function outcomeNotice(o: EndOutcome, title: string, verb: "pause" | "kill", force = false): string {
  if (o.kind === "refused") return refusedNotice(o, force, verb);
  if (o.kind === "notRunning") return `${title} isn't running any more — nothing to end.`;
  if (o.kind === "alreadyPaused") return `${title} is already paused — enter wakes it.`;
  if (o.action === "pause") return `⏸ paused ${title} — enter (or any key in its tab) wakes it.`;
  if (o.placeholder) return `✕ closed ${title}'s paused tab — worktree, branch and transcript kept.`;
  return `✕ killed ${title} — worktree, branch and transcript kept.`;
}

/**
 * A refusal as a notice. Only the in-flight refusal carries the pane's screen,
 * so only it is called work in flight — an ambiguous window or an unread pane
 * is refused for its own reason, which the notice already names.
 */
function refusedNotice(r: Refusal, force: boolean, verb: "pause" | "kill"): string {
  if (r.halfway) return `Paused only halfway: ${r.reason} — enter on its row resumes it.`;
  const head = `Not ${verb === "pause" ? "paused" : "killed"}: ${r.reason}`;
  if (r.code === 1 || force) return `${head}.`;
  if (verb === "kill") return `${head}. X force-kills (asks first).`;
  return r.screen ? `${head} — work is in flight.` : `${head}.`;
}

/**
 * The y/n question a kill asks, from what inspecting it found — or null when
 * the inspection already settled it and there is only a notice to show. A
 * plain `x` inspects unforced, so it only ever asks about a plan every guard
 * passed; `X` inspects forced, and its question names every refusal it would
 * be forcing past — on a paused tab too — or says there is none.
 */
export function killQuestion(i: Inspection, title: string, force: boolean): string | null {
  return i.kind === "plan" ? planQuestion(i, title, force) : null;
}

function planQuestion(i: EndPlan, title: string, force: boolean): string {
  const act = i.placeholder ? `close ${title}'s paused tab for good` : `kill ${title}`;
  // A paused tab has nothing in flight to name; only a refusal it is forced past is.
  if (!force || (i.placeholder && !i.waived.length)) return `${act[0].toUpperCase()}${act.slice(1)}?`;
  return `${i.waived.length ? i.waived.join("; ") : "Nothing in flight"} — force ${act}?`;
}

function hoveredRefusal(ctx: Pick<EndCtx, "model">, row: Row | undefined, verb: "pause" | "kill"): string | null {
  return rowRefusal(row, verb, row?.kind === "session" && isPaused(ctx, row.session));
}

/** Hold the one-at-a-time guard for the length of `work`. */
async function exclusively(work: () => Promise<void>): Promise<void> {
  inFlight = true;
  try {
    await work();
  } finally {
    inFlight = false;
  }
}

/** Run one end, tell the user how it went, and reload so the row shows it. */
async function settle(ctx: EndCtx, title: string, verb: "pause" | "kill", run: () => Promise<EndOutcome>, force = false): Promise<void> {
  await exclusively(async () => {
    try {
      ctx.setNotice(outcomeNotice(await run(), title, verb, force));
    } catch (e) {
      ctx.setNotice(`Could not end ${title}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  ctx.reload();
}

/** `p`: pause the hovered session. Safe by default — no force, and no question to ask. */
export function pauseHovered(ctx: EndCtx): void {
  const row = ctx.rows[ctx.cursor];
  const why = inFlight ? WAIT : hoveredRefusal(ctx, row, "pause");
  if (why || row?.kind !== "session") return ctx.setNotice(why);
  const s = row.session;
  ctx.setNotice(`⟳ pausing ${s.title}…`);
  void settle(ctx, s.title, "pause", () => endSession(s.id, "pause", false));
}

/** `x` / `X`: inspect the hovered session, then ask before killing it (or say why not). */
export function killHovered(ctx: EndCtx, force: boolean): void {
  const row = ctx.rows[ctx.cursor];
  const why = inFlight ? WAIT : hoveredRefusal(ctx, row, "kill");
  if (why || row?.kind !== "session") return ctx.setNotice(why);
  const s = row.session;
  ctx.setNotice(`⟳ checking ${s.title}…`);
  const seq = keySeq();
  void exclusively(() => askToKill(ctx, s, force, seq));
}

async function askToKill(ctx: EndCtx, s: AgentSession, force: boolean, seq: number): Promise<void> {
  let inspection: Inspection;
  try {
    inspection = await inspectEnd(s.id, "close", force);
  } catch (e) {
    return ctx.setNotice(`Could not check ${s.title}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const step = askStep(inspection, s, force, keySeq() !== seq);
  ctx.setNotice(step.notice);
  if (step.mode) ctx.setMode(step.mode);
}

/**
 * What an inspection becomes once it is back: a notice, or the y/n. `keysMoved`
 * is whether any key was dispatched since the `x` — the user moved on, to search
 * (which is not a mode of its own, so the mode can't tell), a picker, another
 * row. A y/n put up then would take their next keystroke as its answer, so it
 * is not asked.
 */
export function askStep(i: Inspection, s: AgentSession, force: boolean, keysMoved: boolean): { notice: string | null; mode?: Mode } {
  if (i.kind !== "plan") return { notice: outcomeNotice(i, s.title, "kill") };
  if (keysMoved) return { notice: `Not asked: keys were pressed while ${s.title} was checked — ${force ? "X" : "x"} asks again.` };
  return { notice: null, mode: { kind: "confirmEnd", session: s, force, prompt: planQuestion(i, s.title, force), waived: i.waived } };
}

/**
 * `X`'s kill. The guards run again, forced, and the kill goes ahead only if
 * every refusal it now forces past was named in the question the user said `y`
 * to. Anything new — a turn started while the question was up — is refused, and
 * `X` asks again with it named.
 */
export async function forceKill(s: AgentSession, asked: readonly string[]): Promise<EndOutcome> {
  const i = await inspectEnd(s.id, "close", true);
  if (i.kind !== "plan") return i;
  const fresh = i.waived.filter((r) => !asked.includes(r));
  if (!fresh.length) return performEnd(i);
  const why = `${fresh.join("; ")}, which changed since you were asked — X asks again`;
  return refused(2, why, why);
}

/**
 * `y` on the question: kill it. The guards run AGAIN rather than trusting the
 * inspection that put the question up — a session idle then may be mid-turn by
 * now: a plain `x` must still refuse it, and `X` must not force past anything
 * its question did not name.
 */
export function confirmKill(ctx: EndCtx, s: AgentSession, force: boolean, asked: readonly string[]): void {
  ctx.setMode({ kind: "list" });
  ctx.setNotice(`⟳ killing ${s.title}…`);
  void settle(ctx, s.title, "kill", () => (force ? forceKill(s, asked) : endSession(s.id, "close", false)), force);
}
