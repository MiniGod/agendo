import { resumeDialogChoice } from "../config.ts";
import { type BranchSync, branchSync } from "../gitrefs.ts";
import { durationLabel, idleSeconds, isStalled, resolveStalledAfterMs, shortAge } from "../idle.ts";
import { SELF_CMD } from "../launch.ts";
import { refreshLiveTmux } from "../model.ts";
import { linkLine, linkVocab } from "../output.ts";
import { findPeer } from "../peer.ts";
import { type SessionScope, scopeFilter, scopeNote } from "../scope.ts";
import { SessionIndex, loadActivity } from "../sessions.ts";
import {
  capturePaneState, liveTargetForShortId, liveTargets, paneReadiness, paneResumeDialogActive, paneShells,
  sessionName, shortId, stripAnsi,
} from "../tmux.ts";
import type { WorkflowStatus } from "../types.ts";
import { formatResetTime, paneResetAt } from "../usageLimit.ts";
import { loadWorkflowDetails, workflowStatus } from "../workflows.ts";
import { readyCell, rowCompactionPercent, timeAgo } from "./cells.ts";
import { resolveSessionLink } from "./links.ts";
import { flushWarnings } from "./warnings.ts";

/** CLI glyphs for the three task states (plain ASCII markers stay greppable). */
const STATUS_GLYPH: Record<string, string> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

/** CLI glyphs for workflow run states, matching the task-glyph style. */
const WF_GLYPH: Record<WorkflowStatus, string> = {
  running: "[~]",
  completed: "[x]",
  failed: "[!]",
  stopped: "[-]",
  interrupted: "[?]",
};

/**
 * Resolve a session by id-or-tmux-name and print its state + recent activity
 * (the same summary the menu surfaces). A just-launched session may not have
 * written its log yet — if so we still report it as running from its live tmux
 * window. `token` may be a full session id, a short id, or a `cl-…-<id>` name.
 *
 * `withUrls` additionally resolves the session's linked PR / work item from the
 * backend and prints their full URLs (see `resolveSessionLink`).
 */
export async function runStatus(
  token: string | undefined,
  full: boolean,
  scope: SessionScope | null,
  withUrls = false,
  stalledAfterMs?: number,
): Promise<void> {
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
      console.log(`● running (${live}) — no activity logged yet; it may still be starting.`);
      process.exit(0);
    }
    console.error(`No session found for "${token}"${scopeNote(scope)}.`);
    process.exit(1);
  }
  // Resolve the window through the full reconciliation, NOT liveTargetForShortId
  // alone: a session launched from a work item / PR runs in a `cl-wi-…`/`cl-pr-…`
  // window, which that helper doesn't match. Getting this wrong would report a
  // perfectly attachable session as "running outside agendo".
  const target = refreshLiveTmux(index.all).liveWindows.get(sessionName(s)) ?? liveTargetForShortId(shortId(s.id));
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
  const peer = !target && s.source === "claude" ? await findPeer((id) => id === s.id) : null;
  const external = !!peer;
  const running = !!target || liveTargets().has(sessionName(s)) || external;
  const act = await loadActivity(s, { full });
  // The pane is captured up front (rather than inside the `if (target)` block
  // below) because the stall qualifier needs readiness — a session that is
  // mid-turn is never stalled, however old its transcript looks — and it prints
  // above the readiness line.
  const pane = target ? capturePaneState(target) : null;
  const readiness = pane ? paneReadiness(pane.raw, pane.cursor) : null;
  // A pane parked on claude's own resume dialog reads as `ready` but hasn't run
  // yet, so its idle age belongs to the PREVIOUS run — never a stall (idle.ts).
  // Same signal `wait --json` reports as `resumeDialog`, not a second guess.
  const resumeDialog = pane ? paneResumeDialogActive(pane.raw) : false;
  const idle = idleSeconds(s.lastUsed);
  const thresholdMs = resolveStalledAfterMs(stalledAfterMs);
  // A peer with no window arrives here as running-but-`readiness: null`, which
  // isStalled already declines to judge (a live session we have no pane evidence
  // for). That is the right answer for a different reason than the one it
  // documents: the registry's own `status` is not the settled/busy test `wait`
  // uses, so treating it as one would let a stall verdict rest on a signal the
  // rest of agendo doesn't share.
  const stalled = isStalled({ running, readiness, resumeDialog, idleSeconds: idle }, thresholdMs);
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
  console.log(`${external ? "◆ running" : running ? "● running" : "○ idle"}  [${s.source}] ${s.title}`);
  console.log(`  id:     ${s.id}`);
  console.log(`  dir:    ${s.cwd}`);
  if (s.branch) console.log(`  branch: ${s.branch}`);
  console.log(`  last:   ${s.lastUsed.toISOString()}`);
  if (peer) {
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
  console.log(`  idle:   ${shortAge(idle)} (${idle}s since its last recorded activity)`);
  if (stalled) {
    console.log(`          ⚠ stalled: live and not busy, but nothing has happened for ${shortAge(idle)}`);
    console.log(`          (threshold ${durationLabel(thresholdMs)}). agendo cannot tell "finished" from "fell over" — read`);
    console.log(`          the final response below to judge.`);
  }
  // Unpushed-work state, read straight from the checkout's .git refs (no `git`
  // process, no fetch — see src/gitrefs.ts). Silent when it can't be determined.
  const sync = branchSync(s.cwd);
  if (sync) console.log(`  work:   ${describeSync(sync)}`);
  // `○ idle` says the tmux window is gone, not that the session is. Say what to do
  // about it here, where the caller is already looking — the `resume:` slot is free
  // in exactly this case (the running form of the line reports the resume DIALOG).
  if (!running) {
    console.log(`  resume: ${SELF_CMD} resume ${shortId(s.id)}   (brings it back; worktree, branch and commits are intact)`);
  }
  // Full, clickable links for whatever this session is working on. Vertical
  // output, so a long URL costs nothing here (unlike the `list` table).
  if (withUrls) {
    const resolved = await resolveSessionLink(s, "status");
    const V = linkVocab(resolved.provider);
    // As in runOpen: a link with no resolvable URL reads as absent, never as a
    // partial link a human might paste.
    const pr = resolved.link?.pr?.url ? resolved.link.pr : undefined;
    const workItem = resolved.link?.workItem?.url ? resolved.link.workItem : undefined;
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
  if (pane) {
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
  if (act.lastPrompt) console.log(`\n  last prompt: ${act.lastPrompt}`);
  // Task checklist, if the agent kept one. A plain glyph per status keeps it
  // greppable in plain-text CLI output.
  if (act.tasks && act.tasks.length) {
    console.log(`\n  tasks:`);
    for (const t of act.tasks) console.log(`    ${STATUS_GLYPH[t.status]} ${t.label}`);
  }
  // Workflow-tool runs this session launched (refs come from the cached
  // transcript parse; per-run detail is read here, on demand).
  if (s.workflows?.length) {
    console.log(`\n  workflows:`);
    for (const w of s.workflows) {
      const wst = workflowStatus(w, running);
      const d = await loadWorkflowDetails(w);
      const bits = [`${d.agentsDone}/${d.agentsStarted} agents done`];
      if (w.launchedAt) bits.push(`started ${timeAgo(w.launchedAt)}`);
      if (wst === "running" && d.lastActivity) bits.push(`active ${timeAgo(d.lastActivity)}`);
      console.log(`    ${WF_GLYPH[wst]} ${w.name} — ${wst} · ${bits.join(" · ")}`);
      const desc = w.summary ?? d.description;
      if (desc) console.log(`        ${full ? desc : desc.slice(0, 120)}`);
      if (d.phases?.length) {
        console.log(`        phases: ${d.phases.map((p) => (p.model ? `${p.title} (${p.model})` : p.title)).join(" → ")}`);
      }
      if (d.modelCounts) {
        // Alphabetical: the tally is built concurrently, so insertion order is
        // nondeterministic — sort for stable output.
        const models = Object.entries(d.modelCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([m, n]) => (n > 1 ? `${m} ×${n}` : m))
          .join(", ");
        console.log(`        agents: ${models}`);
      }
      console.log(`        run: ${w.runId}${full && w.transcriptDir ? `\n        transcripts: ${w.transcriptDir}` : ""}`);
    }
  }
  if (act.actions.length) {
    console.log(`\n  recent activity:`);
    for (const a of act.actions) console.log(`    ${a.verb}${a.detail ? `  ${a.detail}` : ""}`);
  } else {
    console.log(`\n  (no recent activity)`);
  }
  // The FULL final response, always untruncated — the key orchestrator read.
  if (act.finalResponse) console.log(`\n  final response:\n${indent(act.finalResponse)}`);
}

/**
 * One line describing a checkout's local-vs-tracked state for `status`. It names
 * the LIVE HEAD branch (the `branch:` line above it is the transcript-recorded
 * one, which can be stale), and says where the answer came from — the comparison
 * is deliberately fetch-free, against the tracking ref as this clone last saw it.
 * When the branch has no configured upstream the wording stays hedged rather
 * than asserting the work was never pushed.
 */
function describeSync(sync: BranchSync): string {
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
