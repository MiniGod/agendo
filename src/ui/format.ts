import { basename } from "path";
import { repoRootForCwd, type RepoInfo } from "../repos.ts";
import { formatResetTime } from "../usageLimit.ts";
import { AGENTS } from "../types.ts";
import type { CloneOutcome } from "../clone.ts";
import type { Readiness, SessionKind } from "../tmux.ts";
import type { AgentSession, SessionActivity, TaskItem } from "../types.ts";
import type { Cell } from "./format/columns.ts";

// Two pieces live in src/ui/format/: columns.ts (the cell, and fitting text
// into terminal columns) and approvals.ts (PR approval and CI state). This file
// stays the one import path for all of it — eight modules under src/ui/ and
// src/cli/ plus test/format.test.ts name it — so the re-exports below keep the
// surface it had before.
export type { Cell } from "./format/columns.ts";
export { fit, padCell } from "./format/columns.ts";
export type { ApprovalCounts } from "./format/approvals.ts";
export { approvalCell, approvalInline, ciCell, prBadge } from "./format/approvals.ts";

// ── small helpers ─────────────────────────────────────────────────────────────

export function timeAgo(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Compact gap since the previous action ("+12s", "+3m", …); blank for the first.
export function fmtDelta(ms?: number): string {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  if (s <= 0) return "+0s";
  if (s < 60) return `+${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `+${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `+${h}h`;
  return `+${Math.round(h / 24)}d`;
}

export function verbStyle(verb: string): { color: string } {
  switch (verb) {
    case "Write":
    case "Create":
      return { color: "green" };
    case "Edit":
      return { color: "yellow" };
    case "Bash":
    case "Agent":
      return { color: "cyan" };
    case "Claude":
    case "Copilot":
    case "Codex":
      return { color: "white" };
    case "Thinking":
      return { color: "magenta" };
    case "AskUser":
      return { color: "yellow" };
    default:
      return { color: "gray" };
  }
}


// Repo a session belongs to, for compact display. Copilot stores
// "org/project/repo"; Claude sessions derive it from the worktree's main repo
// root (repoRootForCwd is cached, so this is cheap to call during render).
export function sessionRepo(s: AgentSession): string {
  if (s.repository) return s.repository.split("/").pop() || s.repository;
  return basename(repoRootForCwd(s.cwd));
}

// Per-agent session counts for the repo picker ("12 claude, 3 codex"). Agents
// with no sessions in the repo are omitted, so the line stays short as more
// agents are supported rather than padding out zeros for all of them.
export function repoBreakdown(r: RepoInfo): string {
  return AGENTS.filter((a) => r[a] > 0).map((a) => `${r[a]} ${a}`).join(", ");
}

// Relativize a path to ~ for display (no truncation — the row truncates it).
export function homeShort(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");
}

// Why a clone failed, phrased for someone who can act on it. agendo never
// handles credentials itself, so an auth failure is always "your git couldn't do
// this" — say that, then quote git verbatim underneath. Two lines rather than
// one long one: git's own words are the half that identifies the actual problem,
// and they must not be the half a terminal truncates.
const CLONE_HINTS: Record<string, string> = {
  // A consequence of agendo's own BatchMode — ssh would normally *ask*. Says
  // what to do rather than what went wrong, because the fix is one command.
  hostkey:
    "Unknown SSH host — agendo runs git non-interactively, so it can't accept a new " +
    "host key for you. Run `ssh -T <host>` once, accept it, then try again.",
  auth:
    "Authentication — agendo uses your existing git credentials; check your SSH agent, " +
    "or `gh auth setup-git` / `az repos` for HTTPS.",
  // Never phrased as "check your credentials" alone: a 404 is what GitHub also
  // returns for a private repo you can't see, so both readings stay on screen.
  missing:
    "Not found — check the URL, or (if it's private) that your git has access to it.",
};

export function cloneError(res: CloneOutcome): string[] {
  const detail = res.error ?? "git clone failed";
  const hint = res.failure ? CLONE_HINTS[res.failure] : undefined;
  return hint ? [hint, detail] : [detail];
}

export type Activity = SessionActivity | "loading" | "error";

// A running session's live pane snapshot: input readiness + how many background
// shells (e.g. a monitor loop) it has going. Polled together from one capture.
export interface PaneState { readiness: Readiness; shells: number; resetAt?: number | null; compactionPercent?: number | null }

export function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("progress")) return "yellow";
  if (s.includes("review")) return "cyan";
  if (s.includes("ready")) return "green";
  if (s.includes("hold")) return "gray";
  return "white";
}
export function agentCell(running: number, total: number): Cell {
  if (total === 0) return { text: "—", color: "gray" };
  if (running > 0) return { text: `● ${running}/${total}`, color: "green" };
  return { text: `${total} sess`, color: "gray" };
}

// Short badge marking how a running session was launched, for at-a-glance
// context (background = agent-spawned; new = launched manually from the menu).
export const KIND_BADGE: Partial<Record<SessionKind, string>> = { background: "bg", new: "new" };

// How a running session's input pane reads right now, as a colored trailing tag.
// `busy` = mid-turn; `compacting` = rewriting its own context, blocked but making
// progress; `dialog` = waiting on a prompt/choice (wants you); `ready` = idle and
// attachable. `undefined` (not yet sampled / unknown) keeps the plain
// "running → attach" so a row never looks stalled before the first poll lands.
//
// `compacting` used to fall through to that default and render as the green
// "running → attach", i.e. a blocked session looked idle and attachable — the one
// state the CLI's readiness column reported and the menu did not.
export function runningStatus(r: Readiness | undefined): { label: string; color: string } {
  switch (r) {
    case "ready": return { label: "ready → attach", color: "green" };
    case "busy": return { label: "busy…", color: "yellow" };
    case "compacting": return { label: "compacting…", color: "yellow" };
    case "queued": return { label: "queued", color: "cyan" };
    case "dialog": return { label: "needs input", color: "magenta" };
    case "limited": return { label: "usage limit", color: "red" };
    default: return { label: "running → attach", color: "green" };
  }
}

// Trailing detail for a compacting row: how far the progress bar has got. Absent
// when the pane isn't drawing one yet — the bar appears a beat after the verb line,
// and " · 0%" would be a claim we can't make from a screen that hasn't said it.
export function compactionSuffix(percent: number | null | undefined): string {
  return percent == null ? "" : ` · ${percent}%`;
}

// Trailing detail for a usage-limited row: the reset time (local clock) when we
// could parse one, else a note that we can't (and so won't auto-resume).
export function limitSuffix(resetAt: number | null | undefined): string {
  if (resetAt == null) return " · no reset time";
  // The same clock `agendo list` prints: one formatter, one locale rule, so the
  // menu and the CLI can't disagree (unpadded hour, 24h vs 12h per the locale).
  const t = formatResetTime(resetAt);
  return resetAt <= Date.now() ? ` · reset passed ${t}` : ` · resets ${t}`;
}

// The three task states are distinguished by both glyph and color so progress
// reads at a glance (and stays legible without color).
export const TASK_STYLE: Record<TaskItem["status"], { glyph: string; color: string; dim: boolean }> = {
  completed: { glyph: "✔", color: "green", dim: true },
  in_progress: { glyph: "◐", color: "yellow", dim: false },
  pending: { glyph: "☐", color: "gray", dim: true },
};
