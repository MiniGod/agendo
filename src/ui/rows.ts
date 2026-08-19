import { basename } from "path";
import { isRunning, itemKey, prKey, type LoadedModel } from "../model.ts";
import { sessionName } from "../tmux.ts";
import { convertTarget } from "./convert.ts";
import { homeShort, sessionRepo, timeAgo, type Activity, type Cell } from "./format.ts";
import { prTarget, prOpen, wiTarget, wiOpen, type FreshTarget, type OpenTargets } from "./targets.ts";
import { itemMatches, prMatches, sessionMatches } from "./search.ts";
import { V } from "./vocabState.ts";
import type {
  ActionLine,
  AgentSession,
  LinkedPR,
  PRWithSessions,
  PullRequest,
  ReviewPRWithSessions,
  TaskItem,
  WorkItem,
} from "../types.ts";

// The activity cache is keyed by session *identity* (same log wherever the
// session appears, so it loads once). Expansion is keyed by the *row* instead:
// a session can appear in more than one place at once (e.g. "Running now" and
// "All sessions"), and expanding one row must not expand its twin. The `sx:`
// prefix keeps these out of the way of the `wi:`/`pr:` keys in `expanded`.
export const sessionId = (s: AgentSession) => `${s.source}:${s.id}`;
export const sessionExpandKey = (rowKey: string) => `sx:${rowKey}`;

// ── row model for keyboard navigation (list mode) ─────────────────────────────
export type Row =
  | { kind: "header"; label: string; sub?: string }
  | { kind: "spacer" }
  | { kind: "item"; item: WorkItem; expanded: boolean; running: number; open: OpenTargets }
  | { kind: "pr"; pr: PRWithSessions; expanded: boolean; running: number; contextCell?: Cell; open: OpenTargets }
  | { kind: "session"; key: string; session: AgentSession; running: boolean; expanded: boolean; open?: OpenTargets; timeField?: "lastUsed" | "created"; showLink?: boolean; placeholder?: boolean }
  | { kind: "sessmeta"; key: string; label: string; value: string }
  | { kind: "sessprompt"; key: string; prompt: string }
  | { kind: "task"; key: string; task: TaskItem }
  | { kind: "action"; key: string; action: ActionLine }
  | { kind: "sessnote"; key: string; text: string }
  | { kind: "fresh"; key: string; target: FreshTarget }
  | { kind: "newsess" }
  | { kind: "toggle"; id: string; label: string; count: number; open: boolean; sub?: string; indent?: number };

export const SELECTABLE = new Set(["item", "pr", "session", "fresh", "toggle", "newsess"]);

// ── shared row builders ─────────────────────────────────────────────────────
// Labeled context lines shown under an expanded session — one [label, value]
// pair per line, so they read cleanly instead of crowding a single row. Two of
// them double as action hints: the profile line advertises the move action
// (press `m`, Claude only — Copilot has no profile), and the final line the
// cross-agent "continue" action (press `c`).
export function sessionMeta(s: AgentSession): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ["dir", homeShort(s.cwd)],
    ["repo", sessionRepo(s)],
  ];
  if (s.branch) out.push(["branch", s.branch]);
  if (s.source === "claude" && s.configDir)
    out.push(["profile", `${basename(s.configDir)}  ·  press m → move to another profile`]);
  const dest = convertTarget(s.source);
  if (dest) out.push(["continue", `press c → convert & resume in ${dest}`]);
  return out;
}

// Push a session row plus, when it's expanded, its activity sub-rows (the last
// prompt and recent actions, or a loading/empty/error note). `expanded` is the
// raw key-set; `activity` is the lazy cache keyed by session identity. `open`
// carries the parent work item / PR browser targets (a session inherits its
// parent's) so the `o` action works on a session row too.
function pushSession(
  rows: Row[],
  s: AgentSession,
  key: string,
  live: Set<string>,
  expanded: Set<string>,
  activity: Map<string, Activity>,
  open?: OpenTargets,
  timeField: "lastUsed" | "created" = "lastUsed",
  showLink = false,
  placeholder = false,
) {
  const isOpen = expanded.has(sessionExpandKey(key));
  rows.push({ kind: "session", key, session: s, running: isRunning(s, live), expanded: isOpen, open, timeField, showLink, placeholder });
  if (!isOpen) return;
  // Structural context (dir / repo / branch / profile), one labeled line each —
  // known synchronously, so it shows immediately even while activity loads.
  for (const [label, value] of sessionMeta(s))
    rows.push({ kind: "sessmeta", key: `${key}:meta:${label}`, label, value });
  const act = activity.get(sessionId(s));
  if (act === undefined || act === "loading") {
    rows.push({ kind: "sessnote", key: `${key}:note`, text: "loading activity…" });
    return;
  }
  if (act === "error") {
    rows.push({ kind: "sessnote", key: `${key}:note`, text: "couldn't read session log" });
    return;
  }
  if (act.lastPrompt) rows.push({ kind: "sessprompt", key: `${key}:prompt`, prompt: act.lastPrompt });
  // The task checklist (Claude only) sits above the action stream so it reads as
  // the session's overall plan rather than another recent-action line.
  if (act.tasks?.length) act.tasks.forEach((t, i) => rows.push({ kind: "task", key: `${key}:t${i}`, task: t }));
  if (act.actions.length === 0) {
    // Tasks alone are still worth showing; only note "empty" when nothing at all.
    if (!act.tasks?.length) rows.push({ kind: "sessnote", key: `${key}:note`, text: "no recent activity" });
    return;
  }
  act.actions.forEach((a, i) => rows.push({ kind: "action", key: `${key}:a${i}`, action: a }));
}

function pushSessions(
  rows: Row[],
  sessions: AgentSession[],
  live: Set<string>,
  target: FreshTarget,
  prefix: string,
  expanded: Set<string>,
  activity: Map<string, Activity>,
  open?: OpenTargets,
) {
  for (const s of sessions) pushSession(rows, s, `${prefix}:${s.source}:${s.id}`, live, expanded, activity, open);
  rows.push({ kind: "fresh", key: `${prefix}:fresh`, target });
}

function pushItem(
  rows: Row[],
  item: WorkItem,
  expanded: Set<string>,
  live: Set<string>,
  activity: Map<string, Activity>,
  inScope: (cwd: string) => boolean,
) {
  const isOpen = expanded.has(`wi:${itemKey(item)}`);
  // Path scoping filters the session LIST (and its running count), but keeps the
  // work-item row — items are backend-scoped and may have no in-scope sessions.
  const sessions = item.sessions.filter((s) => inScope(s.cwd));
  const running = sessions.filter((s) => isRunning(s, live)).length;
  const open = wiOpen(item);
  rows.push({ kind: "item", item, expanded: isOpen, running, open });
  if (isOpen) pushSessions(rows, sessions, live, wiTarget(item), `wi${itemKey(item)}`, expanded, activity, open);
}

function pushPr(
  rows: Row[],
  pr: PRWithSessions,
  expanded: Set<string>,
  live: Set<string>,
  activity: Map<string, Activity>,
  inScope: (cwd: string) => boolean,
  contextCell?: Cell,
) {
  const isOpen = expanded.has(`pr:${prKey(pr)}`);
  const sessions = pr.sessions.filter((s) => inScope(s.cwd));
  const running = sessions.filter((s) => isRunning(s, live)).length;
  const open = prOpen(pr);
  rows.push({ kind: "pr", pr, expanded: isOpen, running, contextCell, open });
  if (isOpen) pushSessions(rows, sessions, live, prTarget(pr), `pr${prKey(pr)}`, expanded, activity, open);
}

// ── per-view row models ─────────────────────────────────────────────────────
// Every row renders as exactly one terminal line (blank separators are explicit
// "spacer" rows), so the viewport windowing in App is an exact 1 row = 1 line.
export function buildItemsRows(
  model: LoadedModel,
  expanded: Set<string>,
  toggles: Set<string>,
  activity: Map<string, Activity>,
  query: string,
  inScope: (cwd: string) => boolean,
): Row[] {
  const rows: Row[] = [];
  const live = model.liveTmux;

  // Search mode: a single flat, fuzzy-filtered list across all sections (primary
  // / secondary / linked via PRs), de-duped by work item id.
  const q = query.trim();
  if (q) {
    const seen = new Set<string>();
    const matches = [...model.current, ...model.other, ...model.prLinked].filter((it) => {
      if (seen.has(itemKey(it)) || !itemMatches(it, q)) return false;
      seen.add(itemKey(it));
      return true;
    });
    rows.push({ kind: "header", label: "▌ Search results", sub: `(${matches.length}) — "${q}"` });
    if (matches.length === 0) {
      rows.push({ kind: "header", label: `  (no matching ${V.itemsTab.toLowerCase()})` });
      return rows;
    }
    matches.forEach((it) => pushItem(rows, it, expanded, live, activity, inScope));
    return rows;
  }

  rows.push({
    kind: "header",
    label: `▌ ${V.primaryHeader}`,
    sub: V.primaryShowsIteration ? model.currentIterationName ?? undefined : undefined,
  });
  if (model.current.length === 0) rows.push({ kind: "header", label: `  ${V.primaryEmpty}` });
  model.current.forEach((it) => pushItem(rows, it, expanded, live, activity, inScope));

  rows.push({ kind: "spacer" });
  const otherOpen = toggles.has("other");
  rows.push({ kind: "toggle", id: "other", label: V.secondaryToggle, count: model.other.length, open: otherOpen });
  if (otherOpen) model.other.forEach((it) => pushItem(rows, it, expanded, live, activity, inScope));

  if (model.prLinked.length > 0) {
    rows.push({ kind: "spacer" });
    rows.push({ kind: "header", label: "▌ Linked via your PRs", sub: "not assigned to you" });
    model.prLinked.forEach((it) => pushItem(rows, it, expanded, live, activity, inScope));
  }

  return rows;
}

export type PrSort = "created" | "updated";
export type SessionSort = "created" | "updated";

function sessionSortTime(s: AgentSession, sort: SessionSort): number {
  const d = sort === "created" ? (s.createdAt ?? s.lastUsed) : s.lastUsed;
  return d.getTime();
}
function sortSessions(sessions: AgentSession[], sort: SessionSort): AgentSession[] {
  return [...sessions].sort((a, b) => sessionSortTime(b, sort) - sessionSortTime(a, sort));
}

// Active PRs first (drafts always sink to the bottom), then newest-first by the
// chosen date (creation or last-update).
function sortPrs<T extends PullRequest>(prs: T[], sort: PrSort): T[] {
  return [...prs].sort((a, b) => {
    if (a.isDraft !== b.isDraft) return Number(a.isDraft) - Number(b.isDraft);
    const da = sort === "updated" ? a.updatedDate : a.createdDate;
    const db = sort === "updated" ? b.updatedDate : b.createdDate;
    return db - da;
  });
}

// Render a list of PRs as collapsible per-repo subgroups (collapsed by default),
// each sorted (drafts last). Used when repo grouping (g) is on.
function pushPrsByRepo<T extends PRWithSessions>(
  rows: Row[],
  prs: T[],
  expanded: Set<string>,
  toggles: Set<string>,
  live: Set<string>,
  activity: Map<string, Activity>,
  sectionKey: string,
  sort: PrSort,
  inScope: (cwd: string) => boolean,
  contextCellFor?: (pr: T) => Cell | undefined,
) {
  const byRepo = new Map<string, T[]>();
  for (const pr of prs) {
    const repo = pr.repositoryName || "(unknown repo)";
    const arr = byRepo.get(repo);
    if (arr) arr.push(pr);
    else byRepo.set(repo, [pr]);
  }
  // Busiest repo first, then alphabetical.
  const repos = [...byRepo.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );
  for (const [repo, list] of repos) {
    const id = `prgrp:${sectionKey}:${repo}`;
    const open = toggles.has(id);
    const active = list.filter((p) => !p.isDraft).length;
    rows.push({ kind: "toggle", id, label: repo, count: list.length, open, indent: 2, sub: `${active} active` });
    if (open) for (const pr of sortPrs(list, sort)) pushPr(rows, pr, expanded, live, activity, inScope, contextCellFor?.(pr));
  }
}

export function buildPrsRows(
  model: LoadedModel,
  expanded: Set<string>,
  toggles: Set<string>,
  grouped: boolean,
  sort: PrSort,
  activity: Map<string, Activity>,
  query: string,
  inScope: (cwd: string) => boolean,
): Row[] {
  const rows: Row[] = [];
  const live = model.liveTmux;
  const linkedCtx = (pr: LinkedPR): Cell => ({ text: `#${pr.workItemId} ${pr.workItemType}`, color: "gray" });
  const reviewCtx = (pr: ReviewPRWithSessions): Cell => ({ text: pr.reviewReason, color: "cyan" });

  // Search mode: a single flat, fuzzy-filtered list across all sections (linked /
  // awaiting review / orphan), de-duped by PR id. Each PR keeps the context cell
  // of the first section it appears in (linked → work item, review → reason).
  const q = query.trim();
  if (q) {
    const seen = new Set<string>();
    const ctxFor = (pr: PullRequest): Cell | undefined =>
      "workItemId" in pr
        ? linkedCtx(pr as LinkedPR)
        : "reviewReason" in pr
          ? reviewCtx(pr as ReviewPRWithSessions)
          : undefined;
    const matches = sortPrs(
      [...model.linkedPrs, ...model.reviewPrs, ...model.orphanPrs].filter((pr) => {
        if (seen.has(prKey(pr)) || !prMatches(pr, q)) return false;
        seen.add(prKey(pr));
        return true;
      }),
      sort,
    );
    rows.push({ kind: "header", label: "▌ Search results", sub: `(${matches.length}) — "${q}"` });
    if (matches.length === 0) {
      rows.push({ kind: "header", label: "  (no matching PRs)" });
      return rows;
    }
    matches.forEach((pr) => pushPr(rows, pr, expanded, live, activity, inScope, ctxFor(pr)));
    return rows;
  }

  // ── PRs on your work items / issues ──
  rows.push({ kind: "header", label: `▌ ${V.linkedHeader}` });
  if (model.linkedPrs.length === 0) rows.push({ kind: "header", label: `  ${V.linkedEmpty}` });
  else if (grouped) pushPrsByRepo(rows, model.linkedPrs, expanded, toggles, live, activity, "linked", sort, inScope, linkedCtx);
  else sortPrs(model.linkedPrs, sort).forEach((pr) => pushPr(rows, pr, expanded, live, activity, inScope, linkedCtx(pr)));

  // ── Awaiting your review ──
  rows.push({ kind: "spacer" });
  rows.push({ kind: "header", label: "▌ Awaiting your review", sub: V.reviewSub });
  if (model.reviewPrs.length === 0) {
    rows.push({ kind: "header", label: `  ${V.reviewEmpty}` });
  } else if (grouped) {
    pushPrsByRepo(rows, model.reviewPrs, expanded, toggles, live, activity, "review", sort, inScope, reviewCtx);
  } else {
    // Active PRs up top (sorted); drafts (sorted) tucked into a collapsed group.
    const sorted = sortPrs(model.reviewPrs, sort);
    sorted.filter((p) => !p.isDraft).forEach((pr) => pushPr(rows, pr, expanded, live, activity, inScope, reviewCtx(pr)));
    const drafts = sorted.filter((p) => p.isDraft);
    if (drafts.length) {
      const open = toggles.has("review-drafts");
      rows.push({ kind: "toggle", id: "review-drafts", label: "Drafts", count: drafts.length, open, indent: 2 });
      if (open) drafts.forEach((pr) => pushPr(rows, pr, expanded, live, activity, inScope, reviewCtx(pr)));
    }
  }

  // ── PRs without a work item / issue ──
  rows.push({ kind: "spacer" });
  rows.push({ kind: "header", label: `▌ ${V.orphanHeader}` });
  if (model.orphanPrs.length === 0) rows.push({ kind: "header", label: `  ${V.orphanEmpty}` });
  else if (grouped) pushPrsByRepo(rows, model.orphanPrs, expanded, toggles, live, activity, "orphan", sort, inScope);
  else sortPrs(model.orphanPrs, sort).forEach((pr) => pushPr(rows, pr, expanded, live, activity, inScope));

  return rows;
}

export function buildSessionsRows(
  model: LoadedModel,
  toggles: Set<string>,
  grouped: boolean,
  expanded: Set<string>,
  activity: Map<string, Activity>,
  sort: SessionSort,
  query: string,
  inScope: (cwd: string) => boolean,
): Row[] {
  const rows: Row[] = [];
  const live = model.liveTmux;
  const timeField = sort === "created" ? "created" : "lastUsed";
  // The PR / work item this session links back to (Sessions view shows it and
  // `o` opens it). Other views nest sessions under their parent, so they don't.
  const linkOf = (s: AgentSession) => model.sessionLinks.get(`${s.source}:${s.id}`);
  // A session with a live-but-dormant restore placeholder window (idle bash
  // awaiting a keypress) — shown as restored-but-unopened, not running.
  const isPlaceholder = (s: AgentSession) => model.livePlaceholders.has(sessionName(s));

  // Apply the path scope up front: filter each group's sessions and drop groups
  // that end up empty. Everything below reads `groups` instead of the raw model,
  // so the running section, flat list, and per-repo groups all scope uniformly.
  const groups = model.sessionGroups
    .map((g) => ({ ...g, sessions: g.sessions.filter((s) => inScope(s.cwd)) }))
    .filter((g) => g.sessions.length > 0);

  const q = query.trim();

  if (!q) rows.push({ kind: "newsess" });

  if (groups.length === 0) {
    rows.push({ kind: "header", label: "  (no local sessions found)" });
    return rows;
  }

  // Search mode: a single flat, fuzzy-filtered list across all repos (grouping
  // and the running section are suppressed so results read top-to-bottom).
  if (q) {
    const matches = sortSessions(
      groups.flatMap((g) => g.sessions).filter((s) => sessionMatches(s, q)),
      sort,
    );
    rows.push({ kind: "header", label: "▌ Search results", sub: `(${matches.length}) — "${q}"` });
    if (matches.length === 0) {
      rows.push({ kind: "header", label: "  (no matching sessions)" });
      return rows;
    }
    for (const s of matches) pushSession(rows, s, `sess:${s.source}:${s.id}`, live, expanded, activity, linkOf(s), timeField, true);
    return rows;
  }

  // Running section (above the lists, always expanded): every open tmux
  // window/session across all repos, sorted by active sort, so you can jump
  // straight to it. Includes dormant restore placeholders — an open window is
  // "running now" semantically; they're badged ⏸ so they read as open-but-not-
  // yet-resumed. Additive — these also appear in the grouped/flat lists below.
  const openWindows = sortSessions(
    groups.flatMap((g) => g.sessions).filter((s) => isRunning(s, live) || isPlaceholder(s)),
    sort,
  );
  if (openWindows.length > 0) {
    rows.push({ kind: "header", label: "▌ Running now", sub: `(${openWindows.length}) — enter to attach` });
    for (const s of openWindows) pushSession(rows, s, `run:${s.source}:${s.id}`, live, expanded, activity, linkOf(s), timeField, true, isPlaceholder(s));
    rows.push({ kind: "spacer" });
  }

  if (!grouped) {
    // Flat: every session across all repos, sorted by active sort.
    const all = sortSessions(groups.flatMap((g) => g.sessions), sort);
    rows.push({ kind: "header", label: "▌ All sessions", sub: `(${all.length})` });
    for (const s of all) pushSession(rows, s, `sess:${s.source}:${s.id}`, live, expanded, activity, linkOf(s), timeField, true, isPlaceholder(s));
    return rows;
  }

  // Grouped by repo: collapsible, collapsed by default (empty `toggles`).
  groups.forEach((g, gi) => {
    if (gi > 0) rows.push({ kind: "spacer" });
    const id = `grp:${g.root}`;
    const open = toggles.has(id);
    // Sort a copy so we never mutate g.sessions (shared reference).
    const sorted = sortSessions(g.sessions, sort);
    rows.push({ kind: "toggle", id, label: g.name, count: sorted.length, open, sub: timeAgo(new Date(sessionSortTime(sorted[0], sort))) });
    if (open) {
      for (const s of sorted) pushSession(rows, s, `sess:${s.source}:${s.id}`, live, expanded, activity, linkOf(s), timeField, true, isPlaceholder(s));
    }
  });

  return rows;
}
