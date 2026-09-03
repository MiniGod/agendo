// `agendo status <id>` — one session's state, plus the same recent-activity
// summary the menu shows, so an agent that launched a background session can
// poll it.
//
// `branchSync` is INJECTED rather than imported. src/gitrefs.ts reads a
// checkout's ref files, which is cheap once and ruinous on the TUI's 2s rescan
// timer, so exactly one module in src/ is allowed to name it: the one-shot CLI
// entrypoint. e2e/cli.spec.ts pins that by whitelisting importers by filename,
// and test/gitrefsReach.test.ts pins the invariant behind it.

import {
  capturePaneState, liveTargetForShortId, liveTargets, 
  paneBackgroundAgents, paneReadiness, paneResumeDialogActive, paneShells, sessionName,
  shortId, stripAnsi,
  type LiveTarget,
  type Readiness,
} from "../tmux.ts";
import { formatResetTime, paneResetAt } from "../usageLimit.ts";
import { SELF_CMD } from "../launch.ts";
import { SessionIndex, loadActivity } from "../sessions.ts";
import { findPeer } from "../peer.ts";
import { durationLabel, idleSeconds, isStalled, resolveStalledAfterMs, shortAge } from "../idle.ts";
import { scopeFilter, scopeNote, type SessionScope } from "../scope.ts";
import { refreshLiveTmux } from "../model.ts";
import { resumeDialogChoice } from "../config.ts";
import { linkLine, linkVocab } from "../output.ts";
import type { SessionLink } from "../model/types.ts";
import type { AgentSession, BranchSync, BranchSyncReader, WorkflowDetails, WorkflowRef, WorkflowStatus } from "../types.ts";
import { loadWorkflowDetails, workflowStatus } from "../workflows.ts";
import { flushWarnings } from "./warnings.ts";
import { readyCell, rowCompactionPercent, timeAgo } from "./cells.ts";
import { resolveSessionLink } from "./links.ts";
import { STATUS_GLYPH, WF_GLYPH } from "./glyphs.ts";

/**
 * Resolve a session by id-or-tmux-name and print its state + recent activity
 * (the same summary the menu surfaces). A just-launched session may not have
 * written its log yet — if so we still report it as running from its live tmux
 * window. `token` may be a full session id, a short id, or a `cl-…-<id>` name.
 *
 * `withUrls` additionally resolves the session's linked PR / work item from the
 * backend and prints their full URLs (see `resolveSessionLink`).
 */
// As in runOpen: a link with no resolvable URL reads as absent, never as a
// partial link a human might paste.
function usableLink<T extends { url?: string }>(l: T | undefined): T | undefined {
  return l?.url ? l : undefined;
}

export function usableLinks(link: SessionLink | undefined): { pr: SessionLink["pr"]; workItem: SessionLink["workItem"] } {
  return { pr: usableLink(link?.pr), workItem: usableLink(link?.workItem) };
}

// Full, clickable links for whatever this session is working on. Vertical
// output, so a long URL costs nothing here (unlike the `list` table).
async function printLinks(s: AgentSession): Promise<void> {
  const resolved = await resolveSessionLink(s, "status");
  const V = linkVocab(resolved.provider);
  const { pr, workItem } = usableLinks(resolved.link);
  if (resolved.error) {
    console.log(`  links:  (unavailable — ${resolved.error})`);
  } else if (!pr && !workItem) {
    console.log(`  links:  (no linked PR or ${V.noun})`);
  } else {
    if (pr) console.log(linkLine("pr", `${V.prPrefix}${pr.id}`, pr.url));
    if (workItem) console.log(linkLine(V.abbrev, `#${workItem.id}`, workItem.url));
  }
}

// The pane was captured once, up front (the stall qualifier above needed it),
// so this reuses that snapshot rather than re-reading the same pane.
function printPane(pane: NonNullable<ReturnType<typeof capturePaneState>>,
  readiness: Readiness | null,
  resumeDialog: boolean,
  resumeChoice: string): void {
  const { raw } = pane;
  // Compaction rides on the readiness word itself ("compacting 42%") rather than
  // getting a detail line like `limit:` below, because there is nothing to say
  // beyond the number and `list` prints it the same way — one formatter, one
  // reading, so the two commands can't disagree about how far a pane has got.
  console.log(`  ready:  ${readyCell(readiness, null, rowCompactionPercent(readiness, raw))}`);
  // Reported ready (nothing is waiting on a decision about the work), but the
  // pane is parked on claude's own resume dialog — say so, since `send` will
  // answer it rather than paste into it.
  if (resumeDialog) {
    // The choice may have come from a config agendo had to ignore; that was
    // already reported by the single drain above, which is why there is no
    // second flush here.
    console.log(`  resume: claude's resume dialog is open — \`${SELF_CMD} send\` answers it (${resumeChoice}) before delivering`);
  }
  if (readiness === "limited") {
    const resetAt = paneResetAt(stripAnsi(raw));
    console.log(
      // Both forms: the ISO instant for a machine reading `status` output, and
      // the same local clock `list` and the menu show, so a human doesn't have
      // to convert UTC in their head to match up the two commands.
      `  limit:  usage limit reached${
        resetAt !== null
          ? ` — resets at ${new Date(resetAt).toISOString()} (${formatResetTime(resetAt)})`
          : " — no reset time parsed (cannot auto-resume)"
      }`,
    );
  }
  const shells = paneShells(raw);
  if (shells > 0) console.log(`  shells: ${shells} background shell${shells > 1 ? "s" : ""} running (e.g. a monitor)`);
}

// The tally after the status word: agents done, when it started, when it last did anything.
export function workflowBits(w: WorkflowRef, wst: WorkflowStatus, d: WorkflowDetails): string[] {
  const bits = [`${d.agentsDone}/${d.agentsStarted} agents done`];
  if (w.launchedAt) bits.push(`started ${timeAgo(w.launchedAt)}`);
  if (wst === "running" && d.lastActivity) bits.push(`active ${timeAgo(d.lastActivity)}`);
  return bits;
}

// The one-line summary, cut at 120 unless --full asked for the whole of it.
export function workflowDescription(w: WorkflowRef, d: WorkflowDetails, full: boolean): string | null {
  const desc = w.summary ?? d.description;
  if (!desc) return null;
  return full ? desc : desc.slice(0, 120);
}

// Alphabetical: the tally is built concurrently, so insertion order is
// nondeterministic — sort for stable output.
export function workflowAgents(modelCounts: Record<string, number>): string {
  return Object.entries(modelCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, n]) => (n > 1 ? `${m} ×${n}` : m))
    .join(", ");
}

export function workflowPhases(phases: NonNullable<WorkflowDetails["phases"]>): string {
  return phases.map((p) => (p.model ? `${p.title} (${p.model})` : p.title)).join(" → ");
}

// One workflow run: its line, then what is known about it, indented under it.
async function printWorkflow(w: WorkflowRef, running: boolean, full: boolean): Promise<void> {
  const wst = workflowStatus(w, running);
  const d = await loadWorkflowDetails(w);
  console.log(`    ${WF_GLYPH[wst]} ${w.name} — ${wst} · ${workflowBits(w, wst, d).join(" · ")}`);
  const desc = workflowDescription(w, d, full);
  if (desc) console.log(`        ${desc}`);
  if (d.phases?.length) console.log(`        phases: ${workflowPhases(d.phases)}`);
  if (d.modelCounts) console.log(`        agents: ${workflowAgents(d.modelCounts)}`);
  console.log(`        run: ${w.runId}${full && w.transcriptDir ? `\n        transcripts: ${w.transcriptDir}` : ""}`);
}

// Workflow-tool runs this session launched (refs come from the cached
// transcript parse; per-run detail is read here, on demand).
async function printWorkflows(s: AgentSession, running: boolean, full: boolean): Promise<void> {
  console.log(`\n  workflows:`);
  for (const w of s.workflows ?? []) await printWorkflow(w, running, full);
}

// Resolve the token to one on-disk session, or exit having said why.
//
// Kept out of runStatus because it is the only part that can end the command
// early, and it has three separate exits: no token at all, a live window too
// young to have a transcript, and nothing found.
async function resolveStatusTarget(
  token: string | undefined,
  scope: SessionScope | null,
): Promise<{ s: AgentSession; index: SessionIndex }> {
if (!token) {
  console.error(
    `usage: ${SELF_CMD} status <id> [--full] [--urls] [--path <dir>] [--repo <name>] [--stalled-after <dur>]`,
  );
  process.exit(1);
}
const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
const index = await SessionIndex.build();
const inScope = scopeFilter(scope);
const s = index.all.find((x) => (x.id === token || shortId(x.id) === sid) && inScope(x));
if (!s) {
  // The live-window fallback below answers for a session too young to have a
  // transcript — but a bare tmux target carries no cwd we can hold against the
  // scope, so under an explicit scope we decline rather than answer for a
  // session that may well be in another repo.
  const live = scope ? null : liveTargetForShortId(sid);
  if (live) {
    console.log(`● running (${live.name}) — no activity logged yet; it may still be starting.`);
    process.exit(0);
  }
  console.error(`No session found for "${token}"${scopeNote(scope)}.`);
  process.exit(1);
}
  return { s, index };
}

type Activity = Awaited<ReturnType<typeof loadActivity>>;
type Peer = Awaited<ReturnType<typeof findPeer>>;
type Pane = ReturnType<typeof capturePaneState>;

/** Where the session is running, if anywhere: its window, or a peer outside agendo. */
interface LiveFacts {
  target: LiveTarget | null | undefined;
  peer: Peer;
  external: boolean;
  running: boolean;
}

/** What one capture of the session's pane says. All null/false/0 without a window. */
interface PaneFacts {
  pane: Pane | null;
  readiness: Readiness | null;
  resumeDialog: boolean;
  backgroundAgents: number;
}

// Resolve the window through the full reconciliation, NOT liveTargetForShortId
// alone: a session launched from a work item / PR runs in a `cl-wi-…`/`cl-pr-…`
// window, which that helper doesn't match. Getting this wrong would report a
// perfectly attachable session as "running outside agendo".
//
// A claude running outside agendo has no window here but is very much alive;
// report it as running (◆) rather than idle, and say why it can't be attached.
// Only consulted when no window was found — with a window in hand the registry
// adds nothing, and the scan would be pure cost on the common path.
//
// Deliberately NOT gated on `peerSocket`: that switch turns off SPEAKING an
// undocumented protocol, and this reads a registry file. Gating it would make
// a live session disappear from `status` — and make `resume` stop refusing to
// put a second claude on a transcript that already has one — which is the
// opposite of the caution the switch is for.
async function liveFacts(s: AgentSession, index: SessionIndex): Promise<LiveFacts> {
  const target = refreshLiveTmux(index.all).liveWindows.get(sessionName(s)) ?? liveTargetForShortId(shortId(s.id));
  const peer = !target && s.source === "claude" ? await findPeer((id) => id === s.id) : null;
  const external = !!peer;
  const running = !!target || liveTargets().has(sessionName(s)) || external;
  return { target, peer, external, running };
}

// The pane is captured up front (rather than where it prints) because the
// stall qualifier needs readiness — a session that is mid-turn is never
// stalled, however old its transcript looks — and it prints above the
// readiness line.
//
// A pane parked on claude's own resume dialog reads as `ready` but hasn't run
// yet, so its idle age belongs to the PREVIOUS run — never a stall (idle.ts).
// Same signal `wait --json` reports as `resumeDialog`, not a second guess.
// Everything reads off the ONE capture.
export function paneFacts(target: LiveTarget | null | undefined): PaneFacts {
  const pane = target ? capturePaneState(target.target) : null;
  if (!pane) return { pane, readiness: null, resumeDialog: false, backgroundAgents: 0 };
  return {
    pane,
    readiness: paneReadiness(pane.raw, pane.cursor),
    resumeDialog: paneResumeDialogActive(pane.raw),
    backgroundAgents: paneBackgroundAgents(pane.raw),
  };
}

// The first block: what the session is, and whether it is live.
function printHeader(s: AgentSession, live: LiveFacts): void {
  console.log(`${live.external ? "◆ running" : live.running ? "● running" : "○ idle"}  [${s.source}] ${s.title}`);
  console.log(`  id:     ${s.id}`);
  console.log(`  dir:    ${s.cwd}`);
  if (s.branch) console.log(`  branch: ${s.branch}`);
  console.log(`  last:   ${s.lastUsed.toISOString()}`);
}

// A peer outside agendo: its own state, and where it is.
function printPeer(peer: NonNullable<Peer>): void {
  console.log(`  state:  ${peer.status ?? "running"}${peer.waitingFor ? ` (${peer.waitingFor})` : ""}`);
  // Don't claim "no window" on the registry's authority alone. The peer reports
  // the pane it runs in, and a window agendo failed to ATTRIBUTE (an id-less
  // `cl-wi-…` whose cwd matched a newer sibling session) is not the same thing
  // as no window at all — saying so would send the user looking for a terminal
  // that doesn't exist. Report what the session itself says.
  console.log(
    peer.tmux
      ? `  where:  pid ${peer.pid}, tmux ${peer.tmux} — not attributed to an agendo window; \`${SELF_CMD} send\` reaches it`
      : `  where:  pid ${peer.pid}, no tmux pane — \`${SELF_CMD} send\` reaches it, attach does not`,
  );
}

// How long since anything happened, and the stall verdict when there is one.
function printIdle(idle: number, stalled: boolean, thresholdMs: number): void {
  console.log(`  idle:   ${shortAge(idle)} (${idle}s since its last recorded activity)`);
  if (stalled) {
    console.log(`          ⚠ stalled: live and not busy, but nothing has happened for ${shortAge(idle)}`);
    console.log(`          (threshold ${durationLabel(thresholdMs)}). agendo cannot tell "finished" from "fell over" — read`);
    console.log(`          the final response below to judge.`);
  }
}

// Task checklist, if the agent kept one. A plain glyph per status keeps it
// greppable in plain-text CLI output.
function printTasks(tasks: Activity["tasks"]): void {
  if (!tasks?.length) return;
  console.log(`\n  tasks:`);
  for (const t of tasks) console.log(`    ${STATUS_GLYPH[t.status]} ${t.label}`);
}

function printActions(actions: Activity["actions"]): void {
  if (!actions.length) {
    console.log(`\n  (no recent activity)`);
    return;
  }
  console.log(`\n  recent activity:`);
  for (const a of actions) console.log(`    ${a.verb}${a.detail ? `  ${a.detail}` : ""}`);
}

// The transcript's side of the report: prompt, tasks, workflows, actions, and
// the FULL final response, always untruncated — the key orchestrator read.
async function printActivity(s: AgentSession, act: Activity, running: boolean, full: boolean): Promise<void> {
  if (act.lastPrompt) console.log(`\n  last prompt: ${act.lastPrompt}`);
  printTasks(act.tasks);
  if (s.workflows?.length) await printWorkflows(s, running, full);
  printActions(act.actions);
  if (act.finalResponse) console.log(`\n  final response:\n${indent(act.finalResponse)}`);
}

export async function runStatus(
  readBranchSync: BranchSyncReader,
  token: string | undefined,
  full: boolean,
  scope: SessionScope | null,
  withUrls = false,
  stalledAfterMs?: number,
): Promise<void> {
  const { s, index } = await resolveStatusTarget(token, scope);
  const live = await liveFacts(s, index);
  const { running, peer } = live;
  const act = await loadActivity(s, { full });
  const { pane, readiness, resumeDialog, backgroundAgents } = paneFacts(live.target);
  const idle = idleSeconds(s.lastUsed);
  const thresholdMs = resolveStalledAfterMs(stalledAfterMs);
  // A peer with no window arrives here as running-but-`readiness: null`, which
  // isStalled already declines to judge (a live session we have no pane evidence
  // for). That is the right answer for a different reason than the one it
  // documents: the registry's own `status` is not the settled/busy test `wait`
  // uses, so treating it as one would let a stall verdict rest on a signal the
  // rest of agendo doesn't share.
  const stalled = isStalled({ running, readiness, resumeDialog, backgroundAgents, idleSeconds: idle }, thresholdMs);
  // Both config-derived values are resolved BEFORE the single drain below: the
  // stall threshold here, and the resume choice the dialog line prints further
  // down. A malformed config.json queues its complaint once per read, and
  // `takeWarnings` dedupes only against the not-yet-drained batch — so draining
  // between the two reads would print the identical line twice. One read each,
  // one drain, one message.
  const resumeChoice = resumeDialogChoice();
  // …and the drain has to happen here rather than inside the resume-dialog branch
  // (where it used to live): a corrupt config falls back to the default threshold
  // on EVERY status, and would otherwise print a stall verdict — or withhold one —
  // that the user has no way to explain.
  flushWarnings("status");
  printHeader(s, live);
  if (peer) printPeer(peer);
  printIdle(idle, stalled, thresholdMs);
  // Unpushed-work state, read straight from the checkout's .git refs (no `git`
  // process, no fetch — see src/gitrefs.ts). Silent when it can't be determined.
  const sync = readBranchSync(s.cwd);
  if (sync) console.log(`  work:   ${describeSync(sync)}`);
  // `○ idle` says the tmux window is gone, not that the session is. Say what to do
  // about it here, where the caller is already looking — the `resume:` slot is free
  // in exactly this case (the running form of the line reports the resume DIALOG).
  if (!running) {
    console.log(`  resume: ${SELF_CMD} resume ${shortId(s.id)}   (brings it back; worktree, branch and commits are intact)`);
  }
  if (withUrls) await printLinks(s);
  if (pane) printPane(pane, readiness, resumeDialog, resumeChoice);
  await printActivity(s, act, running, full);
}

/**
 * One line describing a checkout's local-vs-tracked state for `status`. It names
 * the LIVE HEAD branch (the `branch:` line above it is the transcript-recorded
 * one, which can be stale), and says where the answer came from — the comparison
 * is deliberately fetch-free, against the tracking ref as this clone last saw it.
 * When the branch has no configured upstream the wording stays hedged rather
 * than asserting the work was never pushed.
 */
export function describeSync(sync: BranchSync): string {
  const where = "(from .git refs, no fetch)";
  const head = `HEAD on ${sync.branch}`;
  if (!sync.unpushed) return `${head} — matches ${sync.upstream} ${where}`;
  if (sync.hasRemoteRef) return `${head} — differs from ${sync.upstream}: unpushed or diverged ${where}`;
  return sync.upstreamConfigured
    ? `${head} — nothing at ${sync.upstream} yet: never pushed ${where}`
    : `${head} — no ${sync.upstream} ref and no configured upstream: unpushed, or tracking another remote ${where}`;
}

/** Indent every line of a block by four spaces for the status output. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}
