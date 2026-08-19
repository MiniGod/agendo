import { basename } from "path";
import { repoRootForCwd, type RepoInfo } from "../repos.ts";
import { formatResetTime } from "../usageLimit.ts";
import { V } from "./vocabState.ts";
import { AGENTS } from "../types.ts";
import type { CloneOutcome } from "../clone.ts";
import type { Readiness, SessionKind } from "../tmux.ts";
import type { AgentSession, PullRequest, SessionActivity, TaskItem } from "../types.ts";

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

const CI_GLYPH: Record<PullRequest["ci"], string> = {
  pass: "✓",
  fail: "✗",
  running: "●",
  queued: "⧗",
  expired: "⌛",
  conflict: "⚠",
  none: "",
};

function approvalsMet(pr: PullRequest): boolean {
  return pr.requiredCount > 0 && pr.approvedCount >= pr.requiredCount;
}

export function prBadge(pr: PullRequest): { text: string; color: string } {
  const ratio =
    pr.requiredCount > 0
      ? `${pr.approvedCount}/${pr.requiredCount}`
      : pr.approvedCount > 0
        ? `✓${pr.approvedCount}`
        : "·";
  const ci = CI_GLYPH[pr.ci] ? ` ${CI_GLYPH[pr.ci]}` : "";
  const draft = pr.isDraft ? " draft" : "";
  const bad = pr.rejections > 0 || pr.ci === "fail" || pr.ci === "conflict";
  const color =
    pr.status !== "active" ? "gray" : bad ? "red" : approvalsMet(pr) && pr.ci !== "running" ? "green" : "magenta";
  return { text: `${V.prPrefix}${pr.id} ${ratio}${ci}${draft}`, color };
}

// PR-view column cells: approval progress (X/Y) and CI / merge-gate status.
export function approvalCell(pr: PullRequest): Cell {
  if (pr.requiredCount === 0 && pr.approvedCount === 0) return { text: "—", color: "gray" };
  const color = pr.rejections > 0 ? "red" : approvalsMet(pr) ? "green" : "yellow";
  return { text: `✓ ${pr.approvedCount}/${pr.requiredCount}`, color };
}

export function ciCell(pr: PullRequest): Cell {
  switch (pr.ci) {
    case "pass": return { text: "✓ pass", color: "green" };
    case "fail": return { text: "✗ fail", color: "red" };
    case "running": return { text: "● running", color: "yellow" };
    case "queued": return { text: "⧗ queued", color: "yellow" };
    // Build result aged out (shown as "queued" by ADO). Leading glyph carries
    // the last known result; "expired" flags that it's stale and needs a re-run.
    case "expired":
      if (pr.ciExpiredResult === "pass") return { text: "✓ expired", color: "yellow" };
      if (pr.ciExpiredResult === "fail") return { text: "✗ expired", color: "red" };
      return { text: "⌛ expired", color: "gray" };
    case "conflict": return { text: "⚠ conflict", color: "red" };
    default: return { text: "— no CI", color: "gray" };
  }
}

export function fit(s: string, w: number): string {
  // Reserve a 1-column gap so truncated cells never touch the next column.
  const max = w - 1;
  const t = s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
  return t.padEnd(w);
}

export interface Cell { text: string; color?: string }

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
