// The Sessions view's `K`: kill every extra orchestrator the ⚠ line names, in
// one go, over exactly the path the list's `x` takes — `inspectEnd` unforced to
// decide what to ask, and again on `y` before `performEnd`, which is all
// `endSession` is — so a batch can never end
// something one `x` on its row would have refused. There is no force variant:
// an extra orchestrator mid-turn, holding an open question or running agents is
// skipped and named, and the user can still `X` its row.
//
// What it asks about comes from the pinned block (`OrchestratorPins.killable`),
// which holds the repo scope's open extras and never its primary. Which one is
// primary can change while the question is up — using one tab bumps its
// last-used, waking a paused one makes it running — so `y` reads the repo again,
// fresh from disk and tmux, and leaves alone whichever one is primary NOW.
import { refreshLiveTmux } from "../../app/model/index.ts";
import { inspectEnd, performEnd, refused, type EndOutcome, type EndPlan, type Inspection } from "../../app/sessionEnd/index.ts";
import { orchestratorFacts, pendingOrchestrator } from "../../launch/existingOrchestrator.ts";
import { liveManagedPaths } from "../../runtime/tmux/index.ts";
import { flatTitle, repoOrchestratorStatuses, type OrchestratorCandidate } from "../../orchestration/repoOrchestrator.ts";
import { SessionIndex } from "../../sessions/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import type { KeyContext, Mode } from "../keys/context.ts";
import { keySeq } from "../keys/keySeq.ts";
import { extras, staleList, type OrchestratorPins } from "../models/orchestratorPins.ts";
import { endInFlight, exclusively, WAIT } from "./sessionEnd.ts";

/** What ending a batch touches: no row and no cursor — the targets come from the pinned block. */
type BatchCtx = Pick<KeyContext, "setNotice" | "setMode" | "reload">;
export type StaleKillCtx = BatchCtx & Pick<KeyContext, "pins">;

/** One extra orchestrator `x` would not kill, and why (`notKilled`). */
export interface Skipped {
  id: string;
  title: string;
  why: string;
}

/**
 * `orch-old (session looks "busy")` — one that was not killed, short enough
 * that several share the one notice row: its title flattened and capped as the
 * ⚠ line shows it (a Codex title can be a whole first prompt), and the reason
 * alone rather than `outcomeNotice`'s whole sentence.
 */
export function notKilled(o: Exclude<EndOutcome, { kind: "done" }>, title: string): string {
  const why = o.kind === "refused" ? o.reason : o.kind === "notRunning" ? "not running any more" : "already paused";
  return `${flatTitle(title)} (${why})`;
}

/** Why `K` has nothing to do here, or null when it does. */
export function staleKillRefusal(pins: OrchestratorPins | null): string | null {
  if (!pins?.repoScope || !pins.killRoot) return "K kills a repo's extra orchestrators — scope agendo to one repo to use it.";
  if (pins.killBlocked) return pins.killBlocked;
  return pins.killable.length ? null : "No extra orchestrator with a window open in this repo — nothing to kill.";
}

/** `K`: check each extra orchestrator the way `x` would, then ask before killing the ones that passed. */
export function killStale(ctx: StaleKillCtx): void {
  const why = endInFlight() ? WAIT : staleKillRefusal(ctx.pins);
  if (why || !ctx.pins?.killRoot) return ctx.setNotice(why);
  const { killable: targets, killRoot: root, killLookAlikes: lookAlikes } = ctx.pins;
  ctx.setNotice(`⟳ checking ${extras(targets.length, lookAlikes)}…`);
  const seq = keySeq();
  void exclusively(() => askToKillStale(ctx, { root, lookAlikes }, targets, seq));
}

async function inspectAll(targets: readonly OrchestratorCandidate[]): Promise<Inspection[]> {
  const out: Inspection[] = [];
  // One at a time, as `x` would be pressed: each is a tmux read of its own pane.
  for (const c of targets) out.push(await inspectEnd(c.session.id, "close", false));
  return out;
}

/** The repo a batch is for, and whether what it kills are look-alikes rather than extras. */
export interface StaleRepo {
  root: string;
  lookAlikes: boolean;
}

async function askToKillStale(ctx: StaleKillCtx, repo: StaleRepo, targets: readonly OrchestratorCandidate[], seq: number): Promise<void> {
  let inspections: Inspection[];
  try {
    inspections = await inspectAll(targets);
  } catch (e) {
    return ctx.setNotice(`Could not check the ${repo.lookAlikes ? "orchestrator look-alikes" : "extra orchestrators"}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const step = staleAskStep(repo, targets, inspections, keySeq() !== seq);
  ctx.setNotice(step.notice);
  if (step.mode) ctx.setMode(step.mode);
}

/**
 * What the inspections become: the y/n naming the ones that passed and the ones
 * skipped, or — when none passed, or keys moved on meanwhile (see `askStep`) —
 * only a notice.
 */
export function staleAskStep(
  repo: StaleRepo,
  targets: readonly OrchestratorCandidate[],
  inspections: readonly Inspection[],
  keysMoved: boolean,
): { notice: string | null; mode?: Mode } {
  const kill: OrchestratorCandidate[] = [];
  const skipped: Skipped[] = [];
  targets.forEach((c, i) => {
    const insp = inspections[i];
    if (insp.kind === "plan") kill.push(c);
    else skipped.push({ id: c.session.id, title: c.session.title, why: notKilled(insp, c.session.title) });
  });
  if (!kill.length) return { notice: `None killed: ${skipped.map((s) => s.why).join(", ")}.` };
  if (keysMoved) return { notice: "Not asked: keys were pressed while they were checked — K asks again." };
  const prompt = staleQuestion(kill, repo.lookAlikes);
  return { notice: null, mode: { kind: "confirmEndStale", ...repo, sessions: kill.map((c) => c.session), prompt, skipped } };
}

/** `Kill 2 extra orchestrators — a (⏸ paused), b (● running)?` */
export function staleQuestion(kill: readonly OrchestratorCandidate[], lookAlikes = false): string {
  return `Kill ${extras(kill.length, lookAlikes)} — ${staleList(kill)}?`;
}

/** The notice the batch ends on: what was killed, then what was not and why. */
export function staleOutcomeNotice(
  results: readonly { s: AgentSession; o: EndOutcome }[],
  skipped: readonly Skipped[] = [],
  lookAlikes = false,
): string {
  const done: string[] = [];
  const rest: string[] = [];
  for (const { s, o } of results) {
    if (o.kind === "done") done.push(flatTitle(s.title));
    else rest.push(notKilled(o, s.title));
  }
  rest.push(...skipped.map((s) => s.why));
  const tail = rest.length ? ` Not killed: ${rest.join(", ")}.` : "";
  if (!done.length) return `None killed: ${rest.join(", ")}.`;
  return `✕ killed ${extras(done.length, lookAlikes)}: ${done.join(", ")} — worktrees, branches, transcripts kept.${tail}`;
}

/** What `O`/`G` would open in a repo right now: its primary session, or that one is starting (no session yet). */
export interface PrimaryNow {
  primary: string | null;
  starting: boolean;
}

/**
 * `PrimaryNow` for `root`, read fresh — not from the model the question was
 * built on. A STARTING orchestrator has no session to compare ids with, and its
 * window can be attributed to a look-alike in the same checkout (a Codex
 * window's name carries no id until its rollout lands — see
 * `pendingOrchestrator`), so ending that look-alike could end the new window.
 */
export async function primaryNow(root: string): Promise<PrimaryNow> {
  const index = await SessionIndex.build();
  const t = refreshLiveTmux(index.all);
  const facts = orchestratorFacts({ live: t.live, placeholders: t.livePlaceholders, windows: t.liveWindows, placeholderWindows: t.placeholderWindows });
  const primary = repoOrchestratorStatuses([root], index.all, facts)[0].primary?.session.id ?? null;
  return { primary, starting: primary === null && pendingOrchestrator(root, liveManagedPaths(), facts) !== null };
}

/** Perform an inspected end, unless the session has become the primary since the question went up. */
export function endExtra(s: AgentSession, plan: EndPlan, now: PrimaryNow): EndOutcome {
  if (s.id !== now.primary) return performEnd(plan);
  const why = "it is now the one O/G opens";
  return refused(1, why, why);
}

const STARTED = "an orchestrator started in this repo meanwhile — K again once it is up.";

/**
 * The notice for a batch that stopped because an orchestrator began starting
 * partway through: what was killed before that and what was skipped before the
 * question, then one line for the rest — not the same reason once per session left.
 */
export function stoppedNotice(results: readonly { s: AgentSession; o: EndOutcome }[], skipped: readonly Skipped[], lookAlikes: boolean): string {
  const before = results.length || skipped.length ? staleOutcomeNotice(results, skipped, lookAlikes) : "None killed.";
  return `${before} Stopped: ${STARTED}`;
}

/**
 * End each in turn — `endSession`'s own two halves, `inspectEnd` then
 * `performEnd`, with the primary re-read BETWEEN them, so the gap nothing checks
 * is only the kill itself, not the index rebuild the inspection does. Stops
 * outright once one is starting (see `primaryNow`).
 */
async function endAll(repo: StaleRepo, sessions: readonly AgentSession[], results: { s: AgentSession; o: EndOutcome }[]): Promise<boolean> {
  for (const s of sessions) {
    const i = await inspectEnd(s.id, "close", false);
    if (i.kind !== "plan") {
      results.push({ s, o: i });
      continue;
    }
    const now = await primaryNow(repo.root);
    if (now.starting) return false;
    results.push({ s, o: endExtra(s, i, now) });
  }
  return true;
}

/**
 * `y` on the question: end each one through `x`'s own unforced inspection, which
 * re-runs every guard — one that started a turn while the question was up is
 * refused, not killed — and skip whichever one is primary at that moment
 * (`primaryNow`, read again before EACH end, so one woken mid-batch is caught).
 */
export function confirmKillStale(ctx: BatchCtx, repo: StaleRepo, sessions: readonly AgentSession[], skipped: readonly Skipped[]): void {
  ctx.setMode({ kind: "list" });
  ctx.setNotice(`⟳ killing ${extras(sessions.length, repo.lookAlikes)}…`);
  void exclusively(async () => {
    const results: { s: AgentSession; o: EndOutcome }[] = [];
    try {
      const finished = await endAll(repo, sessions, results);
      ctx.setNotice(finished ? staleOutcomeNotice(results, skipped, repo.lookAlikes) : stoppedNotice(results, skipped, repo.lookAlikes));
    } catch (e) {
      const soFar = results.length ? `${staleOutcomeNotice(results, [], repo.lookAlikes)} ` : "";
      ctx.setNotice(`${soFar}Could not finish: ${e instanceof Error ? e.message : String(e)}`);
    }
  }).then(() => ctx.reload());
}
