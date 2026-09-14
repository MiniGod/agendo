// Minting a brand-new managed session: the id, the `cl-…` window name, the
// agent argv, and the orchestrator marker that lets a cold resume find its way
// back to the right instructions.
import { randomUUID } from "node:crypto";
import type { AgentSource } from "../shared/types.ts";
import { kindName, liveManagedPaths } from "../runtime/tmux/index.ts";
import { markOrchestratorSession, type OrchestratorRole } from "../orchestration/index.ts";
import { markOrchestratorCwd, clearOrchestratorCwd } from "../orchestration/cwdMarks.ts";
import { freshArgv, preassignsSessionId } from "./argv.ts";
import { openTarget, type OpenPlan } from "./open.ts";

/**
 * Open a kind-prefixed managed session for `agent` in `cwd`. The `cl-bg-`/
 * `cl-new-` prefix tells the human (and the UI badge) how it started. Background
 * sessions also get the autonomy flags so they run unattended — except
 * orchestrators, which need `unattended` as well (see `ManagedOptions`).
 * `forwardArgv` carries the allowlisted agent flags `agendo launch` accepted; the
 * TUI's own launch paths pass none.
 *
 * For agents that take a caller-chosen id we assign it up front (`--session-id`)
 * so the window name embeds it — that lets `openSession` find this exact window
 * on a later attach instead of spawning a duplicate, and the returned `id` is
 * the real, resumable session id. An orchestrator launch also records the minted
 * id AND its level, so a later cold resume can re-inject the instructions claude
 * itself doesn't remember — at the level it was launched at, so a global one
 * doesn't come back as a repo one that starts merging.
 *
 * Codex assigns its own id, so there is nothing to embed: the window gets an
 * id-LESS tagged name (`cl-bg-codex-…`, see `kindName`) and is attributed to its
 * session by working directory — the same route `cl-wi-…`/`cl-pr-…` take, and it
 * yields the genuine codex id once the session's rollout file lands on disk.
 * `id` is undefined in that case; callers must not present the uniquifier as a
 * session id. A Codex orchestrator is marked by that same cwd instead (see
 * `markOrchestratorCwd`), since there is no id yet to record it under.
 */
export interface ManagedOptions {
  /**
   * Run in orchestrator mode at this level (Claude or Codex — see `freshArgv`;
   * Copilot has no equivalent and is refused before this point). Absent ⇒ an
   * ordinary session.
   */
  orchestrator?: OrchestratorRole;
  /**
   * Give an ORCHESTRATOR the unattended autonomy flags too. Off by default: an
   * orchestrator's whole job is to spawn further sessions and merge into the main
   * checkout, so auto-approving its actions turns one compromised or confused
   * agent into unreviewed writes on the user's primary working tree. Ordinary
   * background sessions are unaffected — they stay autonomous in their own
   * throwaway worktree, which is what makes `agendo launch` useful at all.
   */
  unattended?: boolean;
  /** Allowlisted agent flags to forward verbatim (see `FORWARDABLE_LAUNCH_FLAGS`). */
  forwardArgv?: string[];
  /**
   * Opens the target instead of `openTarget`. Used by the global orchestrator,
   * which prefers a split pane beside the menu over a window of its own — and
   * which must not mint a session id for an attempt it then abandons, so the
   * layout decision is made before this function is called, not inside it.
   */
  open?: (name: string, cwd: string, argv: string[]) => OpenPlan;
}

// A single options object rather than trailing positionals: `orchestrator` and
// `forwardArgv` (string[]) sit next to each other, and swapping them at a call
// site type-checks under neither — but a bare boolean beside `orchestrator` would
// swap silently, turning an ordinary launch into an auto-approving orchestrator.
export function launchManaged(
  cwd: string,
  kind: "background" | "new",
  agent: AgentSource,
  prompt?: string,
  opts: ManagedOptions = {},
): { plan: OpenPlan; id?: string } {
  const { orchestrator, unattended = false, forwardArgv, open = openTarget } = opts;
  const preassigned = preassignsSessionId(agent);
  const uniquifier = randomUUID();
  const tmuxName = kindName(kind, uniquifier, preassigned ? undefined : agent);
  const sessionId = preassigned ? uniquifier : undefined;
  const argv = freshArgv(agent, {
    sessionId,
    prompt,
    // Orchestrators opt IN to autonomy; everything else keeps the old rule.
    autonomy: kind === "background" && (!orchestrator || unattended),
    orchestrator,
    forwardArgv,
  });
  // Mark by id when one was preassigned (Claude, Copilot); otherwise — Codex —
  // by cwd, the only thing known about the session before its rollout file
  // exists (see `markOrchestratorCwd`). An id never collides, but a cwd does — a
  // repo's main checkout can host an orchestrator today and an ordinary
  // `--no-worktree` Codex session tomorrow — so an ORDINARY id-less launch must
  // clear any STALE mark left by an EARLIER, no-longer-running orchestrator in
  // that same cwd, or that unrelated session's cold resume would inherit
  // orchestrator instructions that were never meant for it.
  //
  // "Stale" is checked by liveness, not just presence: an orchestrator's own cwd
  // is a directory a user can `cd` into and launch an ordinary session in WHILE
  // it is still running (a repo orchestrator's is its repo's own main checkout).
  // Clearing unconditionally would wipe a LIVE orchestrator's only record of
  // itself — harmless while its window stays up, but silent on the next crash:
  // a `resume` that re-derives the role from this marker would come back as a
  // plain session with no orchestrator framing. So the clear only fires when
  // nothing is live at `cwd` right now, mirroring `liveGlobalOrchestrator`'s own
  // liveness check.
  if (orchestrator) {
    if (sessionId) markOrchestratorSession(sessionId, orchestrator);
    else markOrchestratorCwd(cwd, orchestrator);
  } else if (!sessionId && !liveManagedPaths().some((t) => t.cwd === cwd)) {
    clearOrchestratorCwd(cwd);
  }
  return { plan: open(tmuxName, cwd, argv), id: sessionId };
}

/**
 * Open a manual ("new session") flow session in an already-resolved `cwd`.
 * `orchestrator` runs it in orchestrator mode (Claude or Codex — see
 * `freshArgv`); only `"repo"` reaches here, since the global level picks no repo
 * and no worktree and so has its own entry point. The minted id (or, for Codex,
 * the cwd) is remembered by `launchManaged`, so the restore snapshot picks the
 * orchestrator framing back up via `resumeArgv` without extra bookkeeping here.
 *
 * This is the TUI's path, and `kind: "new"` carries no autonomy flags at all — a
 * session the user started from the menu keeps its normal approval prompts.
 */
export function launchNewSession(
  cwd: string,
  agent: AgentSource = "claude",
  orchestrator?: OrchestratorRole,
): OpenPlan {
  return launchManaged(cwd, "new", agent, undefined, { orchestrator }).plan;
}
