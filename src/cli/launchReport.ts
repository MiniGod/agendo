// The report a `launch` prints, and the restore record it writes, once the
// session is up. Kept apart from the argv parsing and the launch itself so each
// piece can be read — and, for the pure ones, tested — on its own.

import { currentSessionName } from "../tmux.ts";
import { SELF_CMD, type GlobalLaunchResult, type GlobalLayout, type LaunchResult } from "../launch.ts";
import { recordLaunchedSession } from "../restore.ts";
import type { AgentSource } from "../types.ts";

/** The parsed flags the report reads: which kind of session, and for which agent. */
export interface LaunchKind {
  global: boolean;
  orchestrator: boolean;
  agent: AgentSource;
}

/** What the launch produced, once `runLaunch` has checked it produced a plan. */
export interface LandedSession {
  id?: string;
  cwd: string;
  tmuxName: string;
}

/**
 * The stderr line for a launch that landed in a worktree that already existed.
 * Always printed — reusing a directory is worth a sentence even when it is
 * exactly what was asked for — and upgraded to a `warning:` when there is
 * something in it the caller may not have expected: uncommitted entries, or a
 * branch other than the one the slug names (a `--name` adopt only; an explicit
 * `--worktree=<path>` has no expected branch). Either way the tree is used as
 * found: nothing in it is reset, stashed or checked out — those uncommitted
 * files are the work the launch exists to get back to (#37).
 */
export function adoptionNotice(a: NonNullable<LaunchResult["adopted"]>): string {
  const branch = a.branch === null ? "a detached HEAD" : `branch ${a.branch}`;
  const drifted = a.expectedBranch !== undefined && a.branch !== a.expectedBranch;
  const dirty = a.dirty === 1 ? "1 uncommitted change" : `${a.dirty} uncommitted changes`;
  const parts = [`adopting existing worktree ${a.path} on ${branch}`];
  if (drifted) parts.push(`(expected ${a.expectedBranch})`);
  parts.push(a.dirty ? `with ${dirty}` : "(clean)");
  const line = parts.join(" ");
  return drifted || a.dirty ? `warning: ${line} — left as found, nothing reset, stashed or checked out` : `▸ ${line}`;
}

/** How each resolved layout reads in the launch report. */
const LAYOUT_NOTE: Record<GlobalLayout, string> = {
  pane: "split pane beside the agendo TUI",
  window: "its own tmux window",
  session: "its own tmux session",
};

/** The kind of session a launch makes, as the report and the default title name it. */
export function sessionKind(a: Pick<LaunchKind, "global" | "orchestrator">): "global orchestrator" | "orchestrator" | "background" {
  if (a.global) return "global orchestrator";
  return a.orchestrator ? "orchestrator" : "background";
}

/**
 * Persist this background session into the restore snapshot right away. The CLI
 * runs as its own process and never goes through loadModel, so `captureRestore`
 * wouldn't see it until the menu's next full reload — and a brand-new session
 * has no on-disk log yet to attribute by, only the short id in its tmux name.
 * Recording it here (with the full id we just minted) makes the tab survive a
 * relaunch immediately; no-op if the window didn't land in the canonical session.
 *
 * Skipped for Codex, which mints its own id: there's nothing to resume by yet.
 * Its window is attributed by cwd instead, so the menu's next reload picks the
 * session up and `captureRestore` snapshots it from there.
 */
export function recordLaunch(a: LaunchKind, prompt: string, landed: LandedSession): void {
  if (!landed.id) return;
  recordLaunchedSession(
    {
      id: landed.id,
      cwd: landed.cwd,
      title: prompt || `${sessionKind(a)} session`,
      source: a.agent,
      // Claude is profile-scoped via CLAUDE_CONFIG_DIR; Copilot keeps all state
      // under ~/.copilot, so it carries no config dir.
      configDir: a.agent === "claude" ? process.env.CLAUDE_CONFIG_DIR : undefined,
    },
    landed.tmuxName,
    // Record into the restore bucket of the host session the window landed in
    // (the current tmux session), so a scoped launcher restores its own tabs.
    currentSessionName() ?? undefined,
  );
}

/**
 * The machine-readable next steps for the agent/human that launched it, one
 * line each. `status` is keyed by session id; codex assigns its own only once
 * the session starts, so send the caller to `list` to pick it up from there.
 */
export function launchSummary(a: LaunchKind, landed: LandedSession, globalRes: GlobalLaunchResult | null): string[] {
  const { id, cwd, tmuxName } = landed;
  const lines = [
    `▸ launched ${sessionKind(a)} session ${id ?? `— ${a.agent} assigns its own id`}`,
    `  window:  ${tmuxName}   (in ${cwd})`,
    id ? `  status:  ${SELF_CMD} status ${id}` : `  id:      ${SELF_CMD} list   (then: ${SELF_CMD} status <id>)`,
  ];
  if (globalRes) lines.push(`  layout:  ${LAYOUT_NOTE[globalRes.layout]}${globalRes.layoutNote ? ` — ${globalRes.layoutNote}` : ""}`);
  lines.push(`  attach:  open agendo and pick it (running → attach), or rerun with --attach`);
  return lines;
}
