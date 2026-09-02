// What a session row in the list says, before any of it is painted. The
// component in components.tsx renders these parts and nothing else; every
// decision — which glyph, which badge, which trailing tags — is here, where a
// unit test can reach the states the e2e fixtures never show at once.
import type { SessionKind } from "../tmux.ts";
import type { AgentSession } from "../types.ts";
import { compactionSuffix, KIND_BADGE, limitSuffix, runningStatus, timeAgo, type PaneState } from "./format.ts";
import type { OpenTargets } from "./targets.ts";

export interface SessionRowInput {
  session: AgentSession;
  running: boolean;
  kind?: SessionKind;
  pane?: PaneState;
  expanded: boolean;
  timeField?: "lastUsed" | "created";
  open?: OpenTargets;
  showLink?: boolean;
  placeholder?: boolean;
}

export interface SessionRowParts {
  caret: string;
  glyph: string;
  /** The status color when the session is running, gray otherwise. */
  glyphColor: string;
  source: string;
  badge: string | null;
  title: string;
  link: string | null;
  time: string;
  /** The running-state tag with its readiness detail, e.g. `  (compacting… · 42%)`. */
  status: { text: string; color: string } | null;
  shells: string | null;
  restored: boolean;
}

export function sessionRowParts(p: SessionRowInput): SessionRowParts {
  const { session, running, pane } = p;
  const status = running ? statusTag(pane) : null;
  return {
    caret: p.expanded ? "▾ " : "▸ ",
    glyph: statusGlyph(running, p.placeholder),
    glyphColor: status ? status.color : "gray",
    source: `[${session.source}] `,
    badge: kindBadge(p.kind),
    title: session.title.replace(/\s+/g, " ").slice(0, 50),
    link: p.showLink ? linkBadge(p.open) : null,
    time: `  ${timeAgo(displayTimeOf(session, p.timeField ?? "lastUsed"))}`,
    status,
    shells: shellsLabel(running, pane),
    restored: p.placeholder === true,
  };
}

/** Live, a dormant restore placeholder, or idle. */
export function statusGlyph(running: boolean, placeholder: boolean | undefined): string {
  if (running) return "● ";
  return placeholder ? "⏸ " : "○ ";
}

export function kindBadge(kind: SessionKind | undefined): string | null {
  const badge = kind ? KIND_BADGE[kind] : undefined;
  return badge ? `{${badge}} ` : null;
}

/** The time the row sorts by: creation when asked for and known, else last use. */
export function displayTimeOf(session: Pick<AgentSession, "createdAt" | "lastUsed">, timeField: "lastUsed" | "created"): Date {
  return timeField === "created" ? (session.createdAt ?? session.lastUsed) : session.lastUsed;
}

/** The running tag, with the reset time of a limited pane or the progress of a compacting one. */
export function statusTag(pane: PaneState | undefined): { text: string; color: string } {
  const { label, color } = runningStatus(pane?.readiness);
  return { text: `  (${label}${readinessDetail(pane)})`, color };
}

export function readinessDetail(pane: PaneState | undefined): string {
  if (pane?.readiness === "limited") return limitSuffix(pane.resetAt);
  if (pane?.readiness === "compacting") return compactionSuffix(pane.compactionPercent);
  return "";
}

/** How many shells the running session has open, when any; nothing for an idle one. */
export function shellsLabel(running: boolean, pane: PaneState | undefined): string | null {
  if (!running) return null;
  const shells = pane?.shells ?? 0;
  if (shells === 0) return null;
  return `  ⛁ ${shells} shell${shells > 1 ? "s" : ""}`;
}

// The PR / work item a session links back to, as a compact one-line badge
// (e.g. `!76896 → WI 234309`, or just one side when only one is known).
export function linkBadge(open: OpenTargets | undefined): string | null {
  if (!open) return null;
  const parts: string[] = [];
  if (open.pr) parts.push(`!${open.pr.id}`);
  if (open.workItem) parts.push(`WI ${open.workItem.id}`);
  return parts.length ? parts.join(" → ") : null;
}
