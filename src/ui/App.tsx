import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { execFile } from "child_process";
import { loadModel, isRunning, refreshLiveTmux, itemKey, prKey, type LoadedModel } from "../model.ts";
import { loadActivity } from "../sessions.ts";
import { openSession, launchFresh, launchNewSession, freshName, prFreshName, runInline, type OpenPlan } from "../launch.ts";
import { sessionName, capturePane, sendResume, paneReadiness, paneResumeSafe, paneShells, stripAnsi, type SessionKind, type Readiness } from "../tmux.ts";
import { parseResetTime, shouldAutoResume, RESET_LOOKBACK_MS } from "../usageLimit.ts";
import { openUrl } from "../browser.ts";
import { createWorktree, checkoutWorktree, defaultBranch, worktreeDirName } from "../worktree.ts";
import { loadState, saveState } from "../config.ts";
import { repoRootForCwd, ensureRepoAtTop, type RepoInfo } from "../repos.ts";
import { isUnderRoot } from "../context.ts";
import { vocab, type Vocab } from "../vocab.ts";
import { detectProviders, resolveInitialProvider, detectRepoProvider, getProvider, PROVIDER_INFO } from "../provider.ts";
import { basename } from "path";
import type {
  ActionLine,
  AgentSession,
  AgentSource,
  Identity,
  LinkedPR,
  PRWithSessions,
  ProviderName,
  PullRequest,
  ReviewPRWithSessions,
  SessionActivity,
  TaskItem,
  TeamMember,
  WorkItem,
} from "../types.ts";

const POLL_MS = 1000;
const LIVE_POLL_MS = 2000; // background tmux-liveness refresh (no network)
// How often to re-read running sessions' panes for input readiness. Each tick
// captures one pane per running session (cheap tmux calls), so keep it modest.
const READINESS_MS = 1500;

// Provider-specific terminology for the current model. Set once per render from
// `model.provider` (see App), before any row-building runs — so the module-level
// render helpers below can read it without threading it through every call. Safe
// because rendering is synchronous and the launcher menu is a single instance.
let V: Vocab = vocab("ado");

// ── small helpers ─────────────────────────────────────────────────────────────

// The external session converter (Claude ↔ Copilot), run via npx. It rewrites a
// session's transcript into the other agent's on-disk format and prints the new
// session id; we then resume that session. Run with `--json` for a machine-
// readable result. See the gist for the full conversion logic.
const CONVERT_GIST = "gist:MiniGod/41cc0ab2f52f1577b55b8a0e362fd669";

/** Result of a successful conversion (subset of the converter's JSON output). */
interface ConvertResult {
  /** New session id in the destination agent. */
  id: string;
  /** Working directory of the new session (only emitted for copilot→claude). */
  cwd?: string;
}

/**
 * Convert a session to the other agent via the external converter and resolve
 * with its JSON result. We tolerate npm/npx chatter on stdout by scanning for
 * the last line that parses as a JSON object, and surface a converter-reported
 * `{ "error": … }` as a rejection.
 */
function runConvert(
  direction: "claude-to-copilot" | "copilot-to-claude",
  sessionId: string,
): Promise<ConvertResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "npx",
      [CONVERT_GIST, direction, sessionId, "--json"],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180_000 },
      (err, stdout, stderr) => {
        const line = (stdout || "")
          .split("\n")
          .map((l) => l.trim())
          .reverse()
          .find((l) => l.startsWith("{"));
        if (line) {
          try {
            const obj = JSON.parse(line);
            if (obj?.error) return reject(new Error(String(obj.error)));
            if (obj?.id) return resolve(obj as ConvertResult);
          } catch {
            // fall through to the error path below
          }
        }
        reject(new Error((stderr || "").trim() || err?.message || "converter produced no result"));
      },
    );
  });
}

function timeAgo(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Compact gap since the previous action ("+12s", "+3m", …); blank for the first.
function fmtDelta(ms?: number): string {
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

function verbStyle(verb: string): { color: string } {
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
      return { color: "white" };
    case "Thinking":
      return { color: "magenta" };
    case "AskUser":
      return { color: "yellow" };
    default:
      return { color: "gray" };
  }
}

// Cheap structural equality check to skip re-renders when the log hasn't changed.
// "loading"/"error"/undefined are never equal so any state transition always fires.
function sameTasks(a: TaskItem[] | undefined, b: TaskItem[] | undefined): boolean {
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  if (!a || !b) return true;
  for (let i = 0; i < a.length; i++) {
    if (a[i].label !== b[i].label || a[i].status !== b[i].status) return false;
  }
  return true;
}

function sameActivity(a: Activity | undefined, b: Activity | undefined): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a.lastPrompt !== b.lastPrompt) return false;
  if (!sameTasks(a.tasks, b.tasks)) return false;
  if (a.actions.length !== b.actions.length) return false;
  if (a.actions.length === 0) return true;
  // Compare both ends of the (capped) rolling window: when the list is pinned at
  // ACTIVITY_LIMIT, new appends shift the head off even if the tail looks stable,
  // so checking only the last action could miss a change and freeze the display.
  const fa = a.actions[0];
  const fb = b.actions[0];
  if (fa.timestamp.getTime() !== fb.timestamp.getTime() || fa.verb !== fb.verb || fa.detail !== fb.detail) return false;
  const la = a.actions[a.actions.length - 1];
  const lb = b.actions[b.actions.length - 1];
  return la.timestamp.getTime() === lb.timestamp.getTime() && la.verb === lb.verb && la.detail === lb.detail;
}

// Set equality, order-independent: same size + every member of `a` is in `b`.
// Gates the liveness poll's setState so an unchanged tmux state is a no-op.
function sameLiveTmux(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// The activity cache is keyed by session *identity* (same log wherever the
// session appears, so it loads once). Expansion is keyed by the *row* instead:
// a session can appear in more than one place at once (e.g. "Running now" and
// "All sessions"), and expanding one row must not expand its twin. The `sx:`
// prefix keeps these out of the way of the `wi:`/`pr:` keys in `expanded`.
const sessionId = (s: AgentSession) => `${s.source}:${s.id}`;
const sessionExpandKey = (rowKey: string) => `sx:${rowKey}`;

// Repo a session belongs to, for compact display. Copilot stores
// "org/project/repo"; Claude sessions derive it from the worktree's main repo
// root (repoRootForCwd is cached, so this is cheap to call during render).
function sessionRepo(s: AgentSession): string {
  if (s.repository) return s.repository.split("/").pop() || s.repository;
  return basename(repoRootForCwd(s.cwd));
}

// Subsequence fuzzy match: every (non-space) character of the query must appear
// in `text`, in order, but not necessarily contiguously. Case-insensitive.
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return true;
  const t = text.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Does a session match the Sessions-view search query? Matches against the
// fields a user would search by: title, repo and branch.
function sessionMatches(s: AgentSession, query: string): boolean {
  return fuzzyMatch(query, `${s.title} ${sessionRepo(s)} ${s.branch ?? ""}`);
}

// Does a work item match the search query? Matches against id (with and without
// the leading #), title, type, state and board column. The model carries no
// description / acceptance criteria, so those are not searchable.
function itemMatches(it: WorkItem, query: string): boolean {
  return fuzzyMatch(query, `#${it.id} ${it.title} ${it.type} ${it.state} ${it.boardColumn ?? ""}`);
}

// Does a PR match the search query? Matches against id (with and without the
// leading !), title, branch and repo, plus the linked work item title / review
// reason when present (those vary by which section the PR came from).
function prMatches(pr: PullRequest, query: string): boolean {
  const p = pr as Partial<LinkedPR> & Partial<ReviewPRWithSessions>;
  const extra = [p.workItemTitle, p.reviewReason].filter(Boolean).join(" ");
  return fuzzyMatch(query, `!${pr.id} ${pr.title} ${pr.branch} ${pr.repositoryName ?? ""} ${extra}`);
}

// Relativize a path to ~ for display (no truncation — the row truncates it).
function homeShort(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");
}

// Labeled context lines shown under an expanded session — one [label, value]
// pair per line, so they read cleanly instead of crowding a single row. The
// final line advertises the cross-agent "continue" action (press `c`).
function sessionMeta(s: AgentSession): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ["dir", homeShort(s.cwd)],
    ["repo", sessionRepo(s)],
  ];
  if (s.branch) out.push(["branch", s.branch]);
  if (s.source === "claude" && s.configDir) out.push(["profile", basename(s.configDir)]);
  out.push(["continue", `press c → convert & resume in ${otherAgent(s.source)}`]);
  return out;
}

/** The agent a session would be converted to (the one it isn't). */
function otherAgent(source: AgentSource): AgentSource {
  return source === "claude" ? "copilot" : "claude";
}

type Activity = SessionActivity | "loading" | "error";

// A running session's live pane snapshot: input readiness + how many background
// shells (e.g. a monitor loop) it has going. Polled together from one capture.
interface PaneState { readiness: Readiness; shells: number; resetAt?: number | null }

function stateColor(state: string): string {
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

function prBadge(pr: PullRequest): { text: string; color: string } {
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
function approvalCell(pr: PullRequest): Cell {
  if (pr.requiredCount === 0 && pr.approvedCount === 0) return { text: "—", color: "gray" };
  const color = pr.rejections > 0 ? "red" : approvalsMet(pr) ? "green" : "yellow";
  return { text: `✓ ${pr.approvedCount}/${pr.requiredCount}`, color };
}

function ciCell(pr: PullRequest): Cell {
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

// A target for the fresh-session flow — derived from either a work item or a PR.
// Work items create a NEW branch off origin/HEAD (so we prompt for its name);
// PRs check out the PR's EXISTING branch from origin (no prompt — there's no new
// branch to name).
interface FreshTarget {
  tmuxName: string;
  title: string;
  /** Repo name to pre-select (skips the picker) — e.g. the PR's repository. */
  preferRepo?: string;
  /** "new" → prompt for a new branch; "pr" → check out prBranch from origin; "free" → arbitrary session. */
  kind: "new" | "pr" | "free";
  /** New-branch default name (kind "new"). */
  defaultBranch: string;
  /** The PR's source branch to check out (kind "pr"). */
  prBranch?: string;
}
function wiTarget(item: WorkItem): FreshTarget {
  return {
    kind: "new",
    // Scope the tmux name by repo on GitHub (issue numbers collide across repos).
    tmuxName: freshName(item.id, V.repoScopedFresh ? item.project : undefined),
    defaultBranch: defaultBranch(item.id, item.title),
    title: `#${item.id} — ${item.title}`,
  };
}
function prTarget(pr: PRWithSessions): FreshTarget {
  return {
    kind: "pr",
    tmuxName: prFreshName(pr.id, V.repoScopedFresh ? pr.repositoryId : undefined),
    defaultBranch: pr.branch,
    prBranch: pr.branch,
    title: `PR ${V.prPrefix}${pr.id} — ${pr.title}`,
    preferRepo: pr.repositoryName,
  };
}
function freeTarget(): FreshTarget {
  return { kind: "free", tmuxName: "", defaultBranch: "", title: "New session" };
}

// What the "open in browser" (o) dialog can open for a given row. A row may
// offer the PR, the work item, or both — sessions inherit their parent's.
interface OpenTargets {
  pr?: { id: number; url: string };
  workItem?: { id: number; url: string };
}
function wiOpen(item: WorkItem): OpenTargets {
  const primary = item.prs[0];
  return {
    workItem: { id: item.id, url: item.url },
    ...(primary ? { pr: { id: primary.id, url: primary.url } } : {}),
  };
}
function prOpen(pr: PRWithSessions): OpenTargets {
  const linked = pr as Partial<LinkedPR>;
  return {
    pr: { id: pr.id, url: pr.url },
    ...(linked.workItemId != null && linked.workItemUrl
      ? { workItem: { id: linked.workItemId, url: linked.workItemUrl } }
      : {}),
  };
}

// ── row model for keyboard navigation (list mode) ─────────────────────────────
type Row =
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

const SELECTABLE = new Set(["item", "pr", "session", "fresh", "toggle", "newsess"]);

// ── shared row builders ─────────────────────────────────────────────────────
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
function buildItemsRows(
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

type PrSort = "created" | "updated";
type SessionSort = "created" | "updated";

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

function buildPrsRows(
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

function buildSessionsRows(
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

// ── column layout ─────────────────────────────────────────────────────────────
// Rows are rendered as a single Text with each cell padded/truncated to a fixed
// width, so columns line up and the selection highlight stays continuous.
// Items and PRs share the leading column widths. The PR view adds a narrow
// sort-time column (created/updated — whichever sort is active) before AGENT,
// so its title/context columns are a touch narrower to make room.
const ITEM_WIDTHS = [11, 11, 13, 46, 22, 11];
const PR_WIDTHS = [11, 11, 13, 42, 18, 8, 11];
const HEADERS_ITEMS = ["  ID", "TYPE", "STATE", "TITLE", "PR", "AGENT"];
// PR headers are built per render: the sort-time column's label is the active sort.
function prHeaders(sort: PrSort): string[] {
  return ["  ID", "APPROVE", "CI / MERGE", "TITLE", "CONTEXT", sort.toUpperCase(), "AGENT"];
}

function fit(s: string, w: number): string {
  // Reserve a 1-column gap so truncated cells never touch the next column.
  const max = w - 1;
  const t = s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
  return t.padEnd(w);
}

interface Cell { text: string; color?: string }

function ColRow({ cells, widths, selected }: { cells: Cell[]; widths: number[]; selected: boolean }) {
  // wrap="truncate" keeps each row on one line in narrow terminals, so the
  // viewport windowing (1 row = 1 line) stays accurate instead of overflowing.
  return (
    <Text wrap="truncate" backgroundColor={selected ? "cyan" : undefined}>
      {cells.map((c, i) => (
        <Text key={i} color={selected ? "black" : c.color}>{fit(c.text, widths[i])}</Text>
      ))}
    </Text>
  );
}

function ColumnHeader({ headers, widths }: { headers: string[]; widths: number[] }) {
  return <Text wrap="truncate" dimColor>{headers.map((h, i) => fit(h, widths[i])).join("")}</Text>;
}

function agentCell(running: number, total: number): Cell {
  if (total === 0) return { text: "—", color: "gray" };
  if (running > 0) return { text: `● ${running}/${total}`, color: "green" };
  return { text: `${total} sess`, color: "gray" };
}

function ItemRow({
  item,
  expanded,
  running,
  selected,
}: { item: WorkItem; expanded: boolean; running: number; selected: boolean }) {
  const caret = expanded ? "▾" : "▸";
  const primary = item.prs[0];
  const prCell: Cell = primary
    ? {
        text: prBadge(primary).text + (item.prs.length > 1 ? ` +${item.prs.length - 1}` : ""),
        color: prBadge(primary).color,
      }
    : { text: "—", color: "gray" };
  const cells: Cell[] = [
    { text: `${caret} #${item.id}`, color: "gray" },
    { text: item.type, color: "gray" },
    { text: item.state, color: stateColor(item.state) },
    { text: item.title },
    prCell,
    agentCell(running, item.sessions.length),
  ];
  return <Box><ColRow cells={cells} widths={ITEM_WIDTHS} selected={selected} /></Box>;
}

function PrRow({
  pr,
  expanded,
  running,
  selected,
  contextCell,
  sort,
}: { pr: PRWithSessions; expanded: boolean; running: number; selected: boolean; contextCell?: Cell; sort: PrSort }) {
  const caret = expanded ? "▾" : "▸";
  // The sort-time column tracks the active sort: created vs last-updated time.
  const tNum = sort === "updated" ? pr.updatedDate : pr.createdDate;
  const cells: Cell[] = [
    { text: `${caret} ${V.prPrefix}${pr.id}`, color: prBadge(pr).color },
    approvalCell(pr),
    pr.isDraft ? { text: "draft", color: "gray" } : ciCell(pr),
    { text: pr.title },
    contextCell ?? { text: `${pr.repositoryName ?? ""}:${pr.branch}`.replace(/^:/, ""), color: "gray" },
    { text: tNum ? timeAgo(new Date(tNum)) : "—", color: "gray" },
    agentCell(running, pr.sessions.length),
  ];
  return <Box><ColRow cells={cells} widths={PR_WIDTHS} selected={selected} /></Box>;
}

// Short badge marking how a running session was launched, for at-a-glance
// context (background = agent-spawned; new = launched manually from the menu).
const KIND_BADGE: Partial<Record<SessionKind, string>> = { background: "bg", new: "new" };

// How a running session's input pane reads right now, as a colored trailing tag.
// `busy` = mid-turn; `dialog` = waiting on a prompt/choice (wants you); `ready` =
// idle and attachable. `undefined` (not yet sampled / unknown) keeps the plain
// "running → attach" so a row never looks stalled before the first poll lands.
function runningStatus(r: Readiness | undefined): { label: string; color: string } {
  switch (r) {
    case "ready": return { label: "ready → attach", color: "green" };
    case "busy": return { label: "busy…", color: "yellow" };
    case "queued": return { label: "queued", color: "cyan" };
    case "dialog": return { label: "needs input", color: "magenta" };
    case "limited": return { label: "usage limit", color: "red" };
    default: return { label: "running → attach", color: "green" };
  }
}

// Trailing detail for a usage-limited row: the reset time (local clock) when we
// could parse one, else a note that we can't (and so won't auto-resume).
function limitSuffix(resetAt: number | null | undefined): string {
  if (resetAt == null) return " · no reset time";
  const t = new Date(resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return resetAt <= Date.now() ? ` · reset passed ${t}` : ` · resets ${t}`;
}

// The PR / work item a session links back to, as a compact one-line badge
// (e.g. `!76896 → WI 234309`, or just one side when only one is known).
function linkBadge(open: OpenTargets | undefined): string | null {
  if (!open) return null;
  const parts: string[] = [];
  if (open.pr) parts.push(`!${open.pr.id}`);
  if (open.workItem) parts.push(`WI ${open.workItem.id}`);
  return parts.length ? parts.join(" → ") : null;
}

function SessionRow({
  session,
  running,
  kind,
  pane,
  expanded,
  selected,
  timeField = "lastUsed",
  open,
  showLink,
  placeholder,
}: { session: AgentSession; running: boolean; kind?: SessionKind; pane?: PaneState; expanded: boolean; selected: boolean; timeField?: "lastUsed" | "created"; open?: OpenTargets; showLink?: boolean; placeholder?: boolean }) {
  const caret = expanded ? "▾ " : "▸ ";
  const displayTime = timeField === "created" ? (session.createdAt ?? session.lastUsed) : session.lastUsed;
  const badge = kind ? KIND_BADGE[kind] : undefined;
  const status = running ? runningStatus(pane?.readiness) : null;
  const shells = running ? pane?.shells ?? 0 : 0;
  const link = showLink ? linkBadge(open) : null;
  return (
    <Box marginLeft={4}>
      <Text wrap="truncate" color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
        <Text color={selected ? "black" : "gray"}>{caret}</Text>
        <Text color={selected ? "black" : status ? status.color : "gray"}>{running ? "● " : placeholder ? "⏸ " : "○ "}</Text>
        <Text dimColor={!selected}>{`[${session.source}] `}</Text>
        {badge ? <Text color={selected ? "black" : "cyan"}>{`{${badge}} `}</Text> : null}
        <Text>{session.title.replace(/\s+/g, " ").slice(0, 50)}</Text>
        {link ? <Text color={selected ? "black" : "magenta"}>{`  ${link}`}</Text> : null}
        <Text dimColor={!selected}>{`  ${timeAgo(displayTime)}`}</Text>
        {status ? <Text color={selected ? "black" : status.color}>{`  (${status.label}${pane?.readiness === "limited" ? limitSuffix(pane.resetAt) : ""})`}</Text> : null}
        {shells > 0 ? <Text color={selected ? "black" : "blue"}>{`  ⛁ ${shells} shell${shells > 1 ? "s" : ""}`}</Text> : null}
        {placeholder ? <Text color={selected ? "black" : "gray"} dimColor={!selected}>{"  restored · press to resume"}</Text> : null}
      </Text>
    </Box>
  );
}

// A single activity line under an expanded session: relative time + the gap
// since the previous action, then a colored verb and a one-line detail.
function ActionRow({ action }: { action: ActionLine }) {
  const { color } = verbStyle(action.verb);
  return (
    <Box marginLeft={6}>
      <Text wrap="truncate">
        <Text color="gray">{timeAgo(action.timestamp).padStart(8)}</Text>
        <Text color="gray" dimColor>{("  " + fmtDelta(action.deltaMs)).padEnd(8)}</Text>
        <Text color={color}>{action.verb.slice(0, 9).padEnd(10)}</Text>
        <Text dimColor>{action.detail.replace(/\s+/g, " ")}</Text>
      </Text>
    </Box>
  );
}

// A single task-checklist line under an expanded session: a status checkbox and
// the item text. The three states are distinguished by both glyph and color so
// progress reads at a glance (and stays legible without color).
const TASK_STYLE: Record<TaskItem["status"], { glyph: string; color: string; dim: boolean }> = {
  completed: { glyph: "✔", color: "green", dim: true },
  in_progress: { glyph: "◐", color: "yellow", dim: false },
  pending: { glyph: "☐", color: "gray", dim: true },
};

function TaskRow({ task }: { task: TaskItem }) {
  const style = TASK_STYLE[task.status] ?? TASK_STYLE.pending;
  return (
    <Box marginLeft={6}>
      <Text wrap="truncate">
        <Text color={style.color}>{`${style.glyph} `}</Text>
        <Text color={task.status === "in_progress" ? "yellow" : undefined} dimColor={style.dim} bold={task.status === "in_progress"}>
          {task.label.replace(/\s+/g, " ")}
        </Text>
      </Text>
    </Box>
  );
}

// ── top-level views & fresh-session flow state ────────────────────────────────
type View = "items" | "prs" | "sessions";

type Mode =
  | { kind: "list" }
  | { kind: "settings"; cursor: number }
  // `fromSettings` routes the picker back to the Settings page (not the list)
  // on cancel, so Settings acts as a hub you drill into and return to.
  | { kind: "provider"; cursor: number; fromSettings?: boolean }
  | { kind: "identity"; cursor: number; fromSettings?: boolean }
  | { kind: "agent"; target: FreshTarget; cursor: number }
  | { kind: "repo"; target: FreshTarget; agent: AgentSource; cursor: number }
  | { kind: "wtchoice"; target: FreshTarget; agent: AgentSource; repo: RepoInfo; cursor: number }
  | { kind: "branch"; target: FreshTarget; agent: AgentSource; repo: RepoInfo; value: string; cursor: number; worktree: boolean }
  | { kind: "open"; targets: OpenTargets; title: string };

/** Agents offered by the fresh-session picker, in display order. */
const AGENT_CHOICES: { source: AgentSource; label: string; desc: string }[] = [
  { source: "claude", label: "Claude", desc: "claude --session-id …" },
  { source: "copilot", label: "Copilot", desc: "copilot --session-id …" },
];

// ── main app ──────────────────────────────────────────────────────────────────
/**
 * `filterRoot` scopes the launcher to sessions under a path (null = the global
 * launcher, bare `agendo`). `hostSession` is the tmux host session the menu runs
 * in — passed to loadModel so restore snapshots the right session's tabs. The
 * `a` key toggles the runtime scoped↔global view (see `globalView`).
 */
export default function App({
  onOpen,
  filterRoot = null,
  hostSession,
}: {
  onOpen: (plan: OpenPlan) => void;
  filterRoot?: string | null;
  hostSession?: string;
}) {
  const { exit } = useApp();
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toggles, setToggles] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>("items");
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [scrollTop, setScrollTop] = useState(0);
  const [grouped, setGrouped] = useState(true); // Sessions view: group by repo
  // Path-scope toggle: when a filterRoot exists, `a` flips between the scoped
  // view (sessions under the root) and the global view (every session). Bare
  // `agendo` has no root, so it's always effectively global.
  const [globalView, setGlobalView] = useState(false);
  const [prsGrouped, setPrsGrouped] = useState(false); // PRs view: repo subgroups
  const [prSort, setPrSort] = useState<PrSort>("created"); // PRs view: sort order
  const [sessionSort, setSessionSort] = useState<SessionSort>("updated"); // Sessions view: sort order
  // Fuzzy search (works on every list view: sessions, PRs, work items).
  // `searchFocus` is the three-state mode:
  //   null    — not searching
  //   "input" — the text box is focused; keystrokes edit the query
  //   "list"  — a query is active but the results list is focused for navigation
  // `search` holds the query text plus a caret position for in-place editing.
  const [searchFocus, setSearchFocus] = useState<"input" | "list" | null>(null);
  const [search, setSearch] = useState<{ text: string; cursor: number }>({ text: "", cursor: 0 });
  const [activity, setActivity] = useState<Map<string, Activity>>(new Map());
  // Live pane snapshot (input readiness + background-shell count) per running
  // session, by canonical name. Polled on a short timer independent of the
  // ADO-backed model reload.
  const [panes, setPanes] = useState<Map<string, PaneState>>(new Map());
  // Auto-resume a session once its usage-limit window reopens (default OFF,
  // toggled on the Settings page). Persisted in LauncherState.
  const [autoResume, setAutoResume] = useState<boolean>(() => loadState().autoResumeOnUsageLimit ?? false);
  // Which backend the launcher talks to. Resolved from the persisted choice if
  // its CLI is still installed, else the first installed one (see provider.ts).
  // `available` is probed once at mount and drives the provider picker.
  const [available] = useState<Set<ProviderName>>(() => detectProviders());
  // When scoped to a path context, a github.com git remote there forces the
  // GitHub backend, overriding the persisted default (which may be ADO). Bare
  // launchers (no filterRoot) never force — they keep the persisted choice.
  const [provider, setProvider] = useState<ProviderName>(() =>
    resolveInitialProvider(loadState().provider, filterRoot ? detectRepoProvider(filterRoot) : null),
  );
  // Per-backend auth status for the Settings page: absent ⇒ not yet probed,
  // "checking" ⇒ probe in flight, boolean ⇒ result. Refreshed each time the
  // Settings page opens (auth can change out from under us between opens).
  const [authStatus, setAuthStatus] = useState<Map<ProviderName, "checking" | boolean>>(new Map());
  // Persisted "who am I / filter" state (Work items & PRs views only).
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const s = loadState();
    return s.identityId
      ? { id: s.identityId, displayName: s.identityName ?? "?", uniqueName: s.identityUniqueName ?? "" }
      : null;
  });
  const [reloadKey, setReloadKey] = useState(0);
  const { stdout } = useStdout();

  // Reload whenever the backend, identity, or a manual refresh changes.
  useEffect(() => {
    setError(null);
    setModel(null);
    let cancelled = false;
    loadModel({ provider, identity, hostSession })
      .then((m) => !cancelled && setModel(m))
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [provider, identity, reloadKey]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  // Probe each backend's auth status whenever the Settings page opens. Not-
  // installed backends resolve to false immediately (no CLI to ask); installed
  // ones show "checking" until their async probe lands.
  useEffect(() => {
    if (mode.kind !== "settings") return;
    let cancelled = false;
    for (const info of PROVIDER_INFO) {
      if (!available.has(info.name)) {
        setAuthStatus((m) => new Map(m).set(info.name, false));
        continue;
      }
      setAuthStatus((m) => new Map(m).set(info.name, "checking"));
      getProvider(info.name)
        .checkAuth()
        .then((ok) => !cancelled && setAuthStatus((m) => new Map(m).set(info.name, ok)))
        .catch(() => !cancelled && setAuthStatus((m) => new Map(m).set(info.name, false)));
    }
    return () => {
      cancelled = true;
    };
  }, [mode.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const persist = (next: { provider?: ProviderName; identity?: Identity | null; autoResume?: boolean }) => {
    const p = next.provider !== undefined ? next.provider : provider;
    const id = next.identity !== undefined ? next.identity : identity;
    const ar = next.autoResume !== undefined ? next.autoResume : autoResume;
    saveState({
      provider: p,
      identityId: id?.id,
      identityName: id?.displayName,
      identityUniqueName: id?.uniqueName,
      autoResumeOnUsageLimit: ar,
    });
  };

  // Re-run the data load (bumping the key the load effect depends on). Used by
  // the inline `open` (to refresh running badges) and the `r` refresh key.
  const reload = () => setReloadKey((k) => k + 1);

  // Lazily parse a session's recent activity the first time it's expanded, then
  // cache it (keyed by session identity). A ref dedupes in-flight requests so
  // it's safe to call on every expand/collapse — it fetches each session once.
  const requested = useRef<Set<string>>(new Set());
  // Live-poll timers: one setInterval per expanded session identity.
  const watchers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());
  // Mirror `model` into a ref so the mount-only liveness interval reads the
  // current sessions without a stale closure and without re-arming the timer.
  const modelRef = useRef<LoadedModel | null>(null);
  // Mirror the setting into a ref so the readiness poll's interval closure reads
  // the current value without re-arming the timer.
  const autoResumeRef = useRef(autoResume);
  useEffect(() => { autoResumeRef.current = autoResume; }, [autoResume]);
  // Per-limited-session bookkeeping for auto-resume, keyed by canonical name:
  //   • limitWindows — the frozen reset instant for the current limit window
  //     (null when no reset time was parseable, so we know not to auto-resume);
  //   • resumeFired  — the reset instant we've already sent `continue` for, so a
  //     single window fires at most once. Both are cleared when a session leaves
  //     the limited state, so its next limit window starts fresh.
  const limitWindows = useRef<Map<string, number | null>>(new Map());
  const resumeFired = useRef<Map<string, number>>(new Map());
  const ensureActivity = (s: AgentSession) => {
    const id = sessionId(s);
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setActivity((p) => new Map(p).set(id, "loading"));
    loadActivity(s)
      .then((a) => setActivity((p) => new Map(p).set(id, a)))
      .catch(() => setActivity((p) => new Map(p).set(id, "error")));
  };

  // Point the render helpers at the right provider vocabulary before anything
  // builds rows or renders chrome this pass (see the module-level `V`).
  if (model) V = vocab(model.provider);

  // The actionable rows of the Settings page, in display order. Kept in one
  // place so the input handler (cursor / enter) and the renderer stay in lockstep.
  const settingsItems: Array<"provider" | "identity" | "autoResume"> = ["provider", "identity", "autoResume"];
  const providerLabel = PROVIDER_INFO.find((p) => p.name === provider)?.label ?? provider;

  // Whether the path filter is active right now (a root exists and the global
  // toggle is off), and the predicate that decides if a session cwd is in scope.
  // Applied as a pure display overlay — tmux reconciliation stays global, so
  // window→session attribution is never gated by the filter.
  const scoped = !!filterRoot && !globalView;
  const inScope = useMemo<(cwd: string) => boolean>(
    () => (scoped ? (cwd: string) => isUnderRoot(cwd, filterRoot!) : () => true),
    [scoped, filterRoot],
  );
  // Repos offered by the fresh-session picker, scoped the same way: a repo is in
  // scope if its root is under the filter root (parent-folder case) or the filter
  // root is under it (inside-a-repo case).
  const scopedRepos = useMemo<RepoInfo[]>(() => {
    if (!model) return [];
    if (!scoped) return model.repos;
    const inScopeRepos = model.repos.filter(
      (r) => isUnderRoot(r.root, filterRoot!) || isUnderRoot(filterRoot!, r.root),
    );
    // Always offer the scoped folder itself as the top choice, even with zero
    // sessions — resolve it to its git root so worktrees land correctly.
    return ensureRepoAtTop(inScopeRepos, repoRootForCwd(filterRoot!));
  }, [model, scoped, filterRoot]);

  const rows = useMemo(() => {
    if (!model) return [];
    if (view === "prs") return buildPrsRows(model, expanded, toggles, prsGrouped, prSort, activity, search.text, inScope);
    if (view === "sessions") return buildSessionsRows(model, toggles, grouped, expanded, activity, sessionSort, search.text, inScope);
    return buildItemsRows(model, expanded, toggles, activity, search.text, inScope);
  }, [model, view, expanded, toggles, grouped, prsGrouped, prSort, sessionSort, activity, search.text, inScope]);
  const selectableIdx = useMemo(
    () => rows.map((r, i) => (SELECTABLE.has(r.kind) ? i : -1)).filter((i) => i >= 0),
    [rows],
  );

  // The identity-switcher roster: the team's members, with the authenticated
  // user guaranteed present (in case they aren't on the configured team).
  const roster = useMemo<TeamMember[]>(() => {
    if (!model) return [];
    const list = [...model.teamMembers];
    if (!list.some((m) => m.id === model.me.id)) list.unshift(model.me);
    return list;
  }, [model]);

  useEffect(() => {
    if (selectableIdx.length === 0) return;
    if (!selectableIdx.includes(cursor)) setCursor(selectableIdx[0]);
  }, [selectableIdx, cursor]);

  // Derive the set of session identities that are currently expanded (and have a
  // log to poll), plus a lookup map and a stable string key for the effect dep.
  const openSessionInfo = useMemo(() => {
    const ids = new Set<string>();
    const lookup = new Map<string, AgentSession>();
    for (const r of rows) {
      if (r.kind === "session" && r.expanded && r.session.logPath) {
        const id = sessionId(r.session);
        ids.add(id);
        lookup.set(id, r.session);
      }
    }
    const key = [...ids].sort().join(",");
    return { openSessionIds: ids, sessionLookup: lookup, key };
  }, [rows]);

  // Reconcile live-poll timers whenever the set of open sessions changes.
  useEffect(() => {
    const { openSessionIds, sessionLookup } = openSessionInfo;
    // Start a timer for each newly-opened session.
    for (const id of openSessionIds) {
      if (watchers.current.has(id)) continue;
      const s = sessionLookup.get(id);
      if (!s) continue;
      const handle = setInterval(async () => {
        if (inFlight.current.has(id)) return;
        inFlight.current.add(id);
        try {
          const a = await loadActivity(s);
          if (!watchers.current.has(id)) return; // timer cleared mid-read
          setActivity((p) => {
            const prev = p.get(id);
            if (sameActivity(prev, a)) return p;
            const next = new Map(p);
            next.set(id, a);
            return next;
          });
        } catch {
          // leave last good data on error
        } finally {
          inFlight.current.delete(id);
        }
      }, POLL_MS);
      watchers.current.set(id, handle);
    }
    // Clear timers for sessions that are no longer open.
    for (const id of watchers.current.keys()) {
      if (!openSessionIds.has(id)) {
        clearInterval(watchers.current.get(id));
        watchers.current.delete(id);
      }
    }
  }, [openSessionInfo.key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leak-proof teardown: clear all timers when the component unmounts.
  useEffect(() => {
    return () => {
      for (const t of watchers.current.values()) clearInterval(t);
      watchers.current.clear();
    };
  }, []);

  // Background tmux-liveness poll: recompute running/live state every
  // LIVE_POLL_MS so badges update without a manual `r` (which makes slow ADO
  // calls). LIVENESS ONLY — no network, no session re-scan; updates liveTmux/
  // liveKinds/liveWindows on the model the app already has so the readiness poll
  // sees sessions started since the last full reload. Mount-only: reads `model`
  // via modelRef.
  useEffect(() => {
    const handle = setInterval(() => {
      const m = modelRef.current;
      if (!m || m.sessionGroups.length === 0) return; // no model yet (full reload), or nothing to attribute
      const fresh = refreshLiveTmux(m.sessionGroups.flatMap((g) => g.sessions));
      setModel((prev) =>
        prev &&
        (!sameLiveTmux(prev.liveTmux, fresh.live) ||
          !sameLiveTmux(prev.livePlaceholders, fresh.livePlaceholders))
          ? {
              ...prev,
              liveTmux: fresh.live,
              liveKinds: fresh.liveKinds,
              liveWindows: fresh.liveWindows,
              livePlaceholders: fresh.livePlaceholders,
            }
          : prev,
      );
    }, LIVE_POLL_MS);
    return () => clearInterval(handle);
  }, []);

  // Poll input readiness for every running session by reading its tmux pane.
  // Re-armed whenever the model reloads (the live-window set may have changed);
  // captures are synchronous and only over running sessions, so no overlap.
  useEffect(() => {
    const windows = model?.liveWindows;
    if (!windows || windows.size === 0) {
      setPanes((p) => (p.size === 0 ? p : new Map()));
      // No live windows to attribute to — drop all auto-resume bookkeeping so a
      // relaunched session can't inherit a stale (possibly past) reset instant.
      limitWindows.current.clear();
      resumeFired.current.clear();
      return;
    }
    const sample = () => {
      // Capture each pane once (outside the state updater, which must stay pure)
      // and derive readiness, shell count, and — when limited — the reset time
      // from the same snapshot. Auto-resume is folded in here so it rides the
      // same cadence and the same fresh capture.
      const next = new Map<string, PaneState>();
      for (const [canon, win] of windows) {
        const raw = capturePane(win);
        const readiness = paneReadiness(raw);
        let resetAt: number | null | undefined;
        if (readiness === "limited") {
          // Freeze the reset instant on first *successful* parse of this limit
          // window: a bare "3pm" parses as the next 3pm, which would jump to
          // tomorrow the moment the clock passes it — freezing keeps a stable
          // target to fire on. Re-parse while still null (a first capture can
          // race the TUI paint and miss the reset line) so a transient miss
          // doesn't permanently disable auto-resume for the window.
          const frozen = limitWindows.current.get(canon);
          if (frozen != null) resetAt = frozen;
          else {
            resetAt = parseResetTime(stripAnsi(raw), new Date(), RESET_LOOKBACK_MS);
            limitWindows.current.set(canon, resetAt ?? null);
          }
          // Auto-resume: once the frozen reset has passed (plus grace) and we
          // haven't already fired for it, re-verify the pane is STILL safely
          // limited — empty input box, no open dialog (guarding the sample→act
          // gap and never clobbering a draft/dialog) — then send `continue`.
          if (autoResumeRef.current) {
            const fired = resumeFired.current.get(canon) ?? null;
            if (shouldAutoResume({ enabled: true, readiness, resetAt: resetAt ?? null, now: Date.now(), firedFor: fired })) {
              if (paneResumeSafe(capturePane(win))) {
                sendResume(win);
                resumeFired.current.set(canon, resetAt as number); // non-null per shouldAutoResume
              }
            }
          }
        } else if (readiness !== "busy" && readiness !== "unknown") {
          // Definitively recovered (ready / queued / dialog / compacting): drop
          // the frozen window + fire record so a *future* limit window starts
          // fresh. We deliberately keep them through "busy" (the generation our
          // own `continue` kicks off) and "unknown" (a transient blank capture),
          // so a single flicker can't wipe the fire-once guard and re-fire.
          limitWindows.current.delete(canon);
          resumeFired.current.delete(canon);
        }
        next.set(canon, { readiness, shells: paneShells(raw), resetAt });
      }
      // A window that vanished between reloads leaves stale bookkeeping; prune it.
      for (const canon of [...limitWindows.current.keys()]) if (!windows.has(canon)) limitWindows.current.delete(canon);
      for (const canon of [...resumeFired.current.keys()]) if (!windows.has(canon)) resumeFired.current.delete(canon);
      setPanes((prev) => {
        const same =
          prev.size === next.size &&
          [...next].every(
            ([k, v]) => prev.get(k)?.readiness === v.readiness && prev.get(k)?.shells === v.shells && prev.get(k)?.resetAt === v.resetAt,
          );
        return same ? prev : next;
      });
    };
    sample(); // paint without waiting a full interval
    const handle = setInterval(sample, READINESS_MS);
    return () => clearInterval(handle);
  }, [model]);

  // ── viewport windowing ──
  // Render only a slice of rows so the list never overflows the terminal (which
  // breaks Ink's redraw and scrolls the cursor off-screen). One row = one line.
  // Reserve lines for the tab strip, hint, scroll indicators, column header
  // (items/prs only) and an occasional notice line.
  const termRows = stdout?.rows ?? 24;
  // Non-sessions views also reserve a line for the "viewing as / filter" status.
  // The search box (shown while a search is active) takes one extra line, and a
  // path-scoped launcher shows one scope line.
  const pageSize = Math.max(
    3,
    termRows - (view === "sessions" ? 6 : 8) - (searchFocus ? 1 : 0) - (filterRoot ? 1 : 0),
  );
  useEffect(() => {
    setScrollTop((prev) => {
      let next = prev;
      if (cursor < next) next = cursor;
      else if (cursor >= next + pageSize) next = cursor - pageSize + 1;
      const maxTop = Math.max(0, rows.length - pageSize);
      return Math.min(Math.max(0, next), maxTop);
    });
  }, [cursor, pageSize, rows.length]);
  const visible = rows.slice(scrollTop, scrollTop + pageSize);
  const moreAbove = scrollTop;
  const moreBelow = Math.max(0, rows.length - (scrollTop + pageSize));

  const move = (dir: 1 | -1) => {
    if (selectableIdx.length === 0) return;
    const pos = selectableIdx.indexOf(cursor);
    setCursor(selectableIdx[(pos + dir + selectableIdx.length) % selectableIdx.length]);
  };

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const toggleSection = (id: string) =>
    setToggles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  // ── sessions search helpers ──
  const clearSearch = () => {
    setSearchFocus(null);
    setSearch({ text: "", cursor: 0 });
  };
  // Edit the query text + caret together so batched keystrokes each apply
  // against the latest value instead of a stale snapshot.
  const editSearch = (fn: (text: string, cursor: number) => { text?: string; cursor: number }) =>
    setSearch((s) => {
      const r = fn(s.text, s.cursor);
      return { text: r.text ?? s.text, cursor: r.cursor };
    });

  const switchView = (v: View) => {
    setView(v);
    setCursor(0);
    clearSearch();
  };

  // Open the Settings page (backend, identity, filters, auth status).
  const enterSettings = () => {
    setNotice(null);
    setMode({ kind: "settings", cursor: 0 });
  };

  // Open the backend picker (Azure DevOps ↔ GitHub), cursor on the current one.
  const enterProvider = (fromSettings = false) => {
    setNotice(null);
    const idx = Math.max(0, PROVIDER_INFO.findIndex((p) => p.name === provider));
    setMode({ kind: "provider", cursor: idx, fromSettings });
  };

  // Open the identity picker, cursor on the current identity.
  const enterIdentity = (fromSettings = false) => {
    if (!model) return;
    const curId = (identity ?? model.me).id;
    const idx = Math.max(0, roster.findIndex((m) => m.id === curId));
    setMode({ kind: "identity", cursor: idx, fromSettings });
  };

  // Switch backend — only to an installed one. Clears the (provider-specific)
  // identity override so the new backend's own "me" is used, resets scroll/search,
  // and persists the choice. Picking an uninstalled backend just surfaces its
  // auth hint (back on `fallback`); picking the current one is a no-op. A real
  // switch always lands on the list so you see the new backend's data reload.
  const applyProvider = (name: ProviderName, fallback: Mode) => {
    const info = PROVIDER_INFO.find((p) => p.name === name);
    if (!available.has(name)) {
      setMode(fallback);
      setNotice(`${info?.label ?? name} unavailable — ${info?.authHint ?? "CLI not installed"}`);
      return;
    }
    if (name === provider) {
      setMode(fallback);
      return;
    }
    setProvider(name);
    setIdentity(null); // ADO identity ids are meaningless on GitHub and vice-versa
    persist({ provider: name, identity: null });
    setCursor(0);
    clearSearch();
    setMode({ kind: "list" });
  };

  // Every fresh flow starts by choosing the agent (Claude or Copilot); once
  // picked, `proceedFresh` runs the original repo/branch/checkout routing.
  const enterFresh = (target: FreshTarget) => {
    setNotice(null);
    setMode({ kind: "agent", target, cursor: 0 });
  };

  const enterNewSession = () => {
    setNotice(null);
    if (!model || scopedRepos.length === 0) {
      setNotice(
        scoped
          ? "No repos under this path — press a to widen to all repos, or open a session here first."
          : "No known repos yet — open or resume a session in a repo first.",
      );
      return;
    }
    setMode({ kind: "agent", target: freeTarget(), cursor: 0 });
  };

  // After the agent is chosen, resolve where to run: PRs check out their branch
  // as soon as the repo is known; work items prompt for a new branch name.
  const proceedFresh = (target: FreshTarget, agent: AgentSource) => {
    const repo = target.preferRepo ? model?.repos.find((r) => r.name === target.preferRepo) : undefined;
    if (target.kind === "pr") {
      if (repo) return startCheckout(target, repo, agent);
      return setMode({ kind: "repo", target, agent, cursor: 0 });
    }
    if (repo) setMode({ kind: "branch", target, agent, repo, value: target.defaultBranch, cursor: target.defaultBranch.length, worktree: true });
    else setMode({ kind: "repo", target, agent, cursor: 0 });
  };

  // Open a prepared plan. Outside tmux we unmount and let index.tsx attach;
  // inside tmux we switch to the agent's window but keep the menu mounted in its
  // own window, then refresh so running badges are current when you switch back.
  const open = (plan: OpenPlan) => {
    if (plan.mode === "handover") {
      onOpen(plan);
      exit();
      return;
    }
    runInline(plan);
    setNotice(`▸ ${plan.alreadyRunning ? "switched to" : "opened"} ${plan.tmuxName} — switch back to this window for more`);
    reload();
  };

  // Work item / free session: create a branch+worktree or launch in main repo directly.
  const startFresh = (target: FreshTarget, repo: RepoInfo, name: string, worktree: boolean, agent: AgentSource) => {
    // A manual "new session" assigns its own session id (so it gets a canonical,
    // attachable `cl-new-<id>` window); work-item / PR launches keep their
    // item-named target. Both run the chosen agent in the resolved directory.
    const launch = (cwd: string) =>
      open(target.kind === "free" ? launchNewSession(cwd, agent) : launchFresh(cwd, target.tmuxName, agent));
    if (worktree) {
      setBusy(`Creating worktree ${name.trim()} in ${repo.name}…`);
      const res = createWorktree(repo.root, name.trim());
      if (res.error) {
        setBusy(null);
        setMode({ kind: "list" });
        setNotice(`Worktree failed: ${res.error}`);
        return;
      }
      setBusy(null);
      setMode({ kind: "list" });
      launch(res.path);
    } else {
      setMode({ kind: "list" });
      launch(repo.root);
    }
  };

  const openInBrowser = (target: { id: number; url: string }, label: string) => {
    setNotice(`Opening ${label} in browser…`);
    openUrl(target.url, (e) => setNotice(`Couldn't open browser: ${e.message}`));
    setMode({ kind: "list" });
  };

  // PR: check out the PR's existing branch from origin (never a new branch).
  const startCheckout = (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => {
    const branch = target.prBranch ?? target.defaultBranch;
    setBusy(`Checking out ${branch} in ${repo.name}…`);
    const res = checkoutWorktree(repo.root, branch);
    if (res.error) {
      setBusy(null);
      setMode({ kind: "list" });
      setNotice(`Worktree failed: ${res.error}`);
      return;
    }
    setBusy(null);
    setMode({ kind: "list" });
    open(launchFresh(res.path, target.tmuxName, agent));
  };

  // Convert a session's transcript into the other agent's format (via the
  // external converter) and resume the resulting session. Claude→Copilot keeps
  // the source cwd (the converter copies it but omits it from JSON); Copilot→
  // Claude takes the cwd the converter reports. The new claude session lands in
  // the default ~/.claude config dir (where the converter writes), so no
  // configDir override is needed for resume.
  const continueInOtherAgent = async (s: AgentSession) => {
    const dest = otherAgent(s.source);
    const direction = s.source === "claude" ? "claude-to-copilot" : "copilot-to-claude";
    setNotice(null);
    setBusy(`Converting session to ${dest} (npx converter)…`);
    try {
      const res = await runConvert(direction, s.id);
      const converted: AgentSession = {
        id: res.id,
        source: dest,
        cwd: res.cwd ?? s.cwd,
        branch: s.branch,
        repository: dest === "copilot" ? s.repository : undefined,
        title: s.title,
        lastUsed: new Date(),
      };
      setBusy(null);
      setMode({ kind: "list" });
      open(openSession(converted));
    } catch (e: any) {
      setBusy(null);
      setMode({ kind: "list" });
      setNotice(`Convert to ${dest} failed: ${e?.message ?? e}`);
    }
  };

  useInput((input, key) => {
    // ── open-in-browser dialog (p = PR, i = issue, esc/q = cancel) ──
    if (mode.kind === "open") {
      if (key.escape || input === "q") return setMode({ kind: "list" });
      if (input === "p" && mode.targets.pr) return openInBrowser(mode.targets.pr, `PR ${V.prPrefix}${mode.targets.pr.id}`);
      if (input === "i" && mode.targets.workItem) return openInBrowser(mode.targets.workItem, `#${mode.targets.workItem.id}`);
      if (key.ctrl && input === "c") exit();
      return;
    }

    // ── fuzzy search (sessions / PRs / work items) ───────────────────────────
    // A search owns one query shared by two focus states. These blocks sit ahead
    // of the global q/esc handlers but ONLY handle the keys that differ while
    // searching — caret editing and focus changes. Every real list action (o, g,
    // s, n, enter, arrows, expand) is left to fall through to its single handler
    // below; it is never reimplemented here. All three list views search the same
    // way, so these blocks gate on `searchFocus` (set only while searching) rather
    // than a specific view.

    // Shared: esc cancels the search from either focus; ctrl-c still quits.
    if (mode.kind === "list" && searchFocus) {
      if (key.ctrl && input === "c") { exit(); return; }
      if (key.escape) { clearSearch(); setCursor(0); return; }
    }

    // INPUT focused: keystrokes edit the query. ←/→ move the caret (the list is
    // not focused while typing); ↓ hands focus to the results; enter/tab fall
    // through (resume the top match / switch view); everything else is swallowed.
    if (mode.kind === "list" && searchFocus === "input") {
      if (key.downArrow) {
        if (selectableIdx.length > 0) { setSearchFocus("list"); setCursor(selectableIdx[0]); }
        return;
      }
      if (key.upArrow) return; // single-line input — nothing above
      if (key.leftArrow) return editSearch((_v, c) => ({ cursor: Math.max(0, c - 1) }));
      if (key.rightArrow) return editSearch((v, c) => ({ cursor: Math.min(v.length, c + 1) }));
      if (key.ctrl && input === "a") return editSearch(() => ({ cursor: 0 }));
      if (key.ctrl && input === "e") return editSearch((v) => ({ cursor: v.length }));
      // Delete the previous word: Ctrl+Backspace (^H → key.backspace in Ink),
      // Alt/Meta+Backspace, or Ctrl+W.
      if (key.backspace || (key.meta && key.delete) || (key.ctrl && input === "w")) {
        setCursor(0);
        return editSearch((v, c) => {
          let i = c;
          while (i > 0 && /\s/.test(v[i - 1]!)) i--;
          while (i > 0 && !/\s/.test(v[i - 1]!)) i--;
          return { text: v.slice(0, i) + v.slice(c), cursor: i };
        });
      }
      // Delete the previous character: plain Backspace (\x7f → key.delete in Ink).
      if (key.delete || input === "\x7f") {
        setCursor(0);
        return editSearch((v, c) => (c === 0 ? { cursor: 0 } : { text: v.slice(0, c - 1) + v.slice(c), cursor: c - 1 }));
      }
      if (input && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
        setCursor(0);
        return editSearch((v, c) => ({ text: v.slice(0, c) + input + v.slice(c), cursor: c + input.length }));
      }
      // With an empty query there is no top match to resume, so swallow enter
      // rather than act on the (hidden) list selection. With a query it falls
      // through to resume the top result; tab falls through to switch view.
      if (key.return && !search.text.trim()) return;
      // enter (resume top match) and tab (switch view) fall through; swallow the rest
      if (!(key.return || key.tab)) return;
    }

    // LIST focused (query active): only the search-specific keys are handled
    // here — `q` cancels, `/` re-focuses the input, and ↑ on the first result
    // hands focus back to the input. Everything else falls through to the normal
    // list handlers (o, g, s, n, enter, arrows, expand) below — not duplicated.
    if (mode.kind === "list" && searchFocus === "list") {
      if (input === "q") { clearSearch(); setCursor(0); return; }
      if (input === "/") { setSearchFocus("input"); return; }
      if ((key.upArrow || input === "k") && cursor === selectableIdx[0]) { setSearchFocus("input"); return; }
    }

    if (mode.kind !== "branch" && (input === "q" || (key.ctrl && input === "c"))) {
      exit();
      return;
    }
    if (mode.kind === "list" && key.escape) {
      exit();
      return;
    }

    // ── agent picker (first step of every fresh flow) ──
    if (mode.kind === "agent") {
      const len = AGENT_CHOICES.length;
      if (key.escape) return setMode({ kind: "list" });
      if (key.upArrow || input === "k")
        return setMode((p) => (p.kind === "agent" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
      if (key.downArrow || input === "j")
        return setMode((p) => (p.kind === "agent" ? { ...p, cursor: (p.cursor + 1) % len } : p));
      if (key.return) return proceedFresh(mode.target, AGENT_CHOICES[mode.cursor].source);
      return;
    }

    // ── repo picker ──
    if (mode.kind === "repo") {
      const repos = scopedRepos;
      const len = repos.length || 1;
      if (key.escape) return setMode({ kind: "agent", target: mode.target, cursor: 0 });
      if (key.upArrow || input === "k")
        return setMode((p) => (p.kind === "repo" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
      if (key.downArrow || input === "j")
        return setMode((p) => (p.kind === "repo" ? { ...p, cursor: (p.cursor + 1) % len } : p));
      if (key.return && repos[mode.cursor]) {
        const repo = repos[mode.cursor];
        if (mode.target.kind === "pr") return startCheckout(mode.target, repo, mode.agent);
        if (mode.target.kind === "free") return setMode({ kind: "wtchoice", target: mode.target, agent: mode.agent, repo, cursor: 0 });
        return setMode({
          kind: "branch",
          target: mode.target,
          agent: mode.agent,
          repo,
          value: mode.target.defaultBranch,
          cursor: mode.target.defaultBranch.length,
          worktree: true,
        });
      }
      return;
    }

    // ── worktree-vs-main choice (free sessions only) ──
    if (mode.kind === "wtchoice") {
      if (key.escape) return setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 });
      if (key.upArrow || input === "k")
        return setMode((p) => (p.kind === "wtchoice" ? { ...p, cursor: (p.cursor - 1 + 2) % 2 } : p));
      if (key.downArrow || input === "j")
        return setMode((p) => (p.kind === "wtchoice" ? { ...p, cursor: (p.cursor + 1) % 2 } : p));
      if (key.return) {
        return setMode({
          kind: "branch",
          target: mode.target,
          agent: mode.agent,
          repo: mode.repo,
          value: "",
          cursor: 0,
          worktree: mode.cursor === 0,
        });
      }
      return;
    }

    // ── new-branch / session name prompt — editable, with a movable cursor ──
    if (mode.kind === "branch") {
      if (key.escape) {
        if (mode.target.kind === "free") return setMode({ kind: "wtchoice", target: mode.target, agent: mode.agent, repo: mode.repo, cursor: mode.worktree ? 0 : 1 });
        return setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 });
      }
      if (key.return) {
        if (mode.value.trim()) startFresh(mode.target, mode.repo, mode.value, mode.worktree, mode.agent);
        return;
      }
      // Functional updates so batched keystrokes (e.g. two Lefts in one chunk)
      // each apply against the latest value/cursor instead of a stale snapshot.
      const edit = (fn: (v: string, c: number) => { value?: string; cursor: number }) =>
        setMode((p) => {
          if (p.kind !== "branch") return p;
          const r = fn(p.value, p.cursor);
          return { ...p, value: r.value ?? p.value, cursor: r.cursor };
        });
      if (key.leftArrow) return edit((v, c) => ({ cursor: Math.max(0, c - 1) }));
      if (key.rightArrow) return edit((v, c) => ({ cursor: Math.min(v.length, c + 1) }));
      // Ctrl-A / Ctrl-E jump to start / end (terminals rarely send Home/End cleanly).
      if (key.ctrl && input === "a") return edit(() => ({ cursor: 0 }));
      if (key.ctrl && input === "e") return edit((v) => ({ cursor: v.length }));
      // Backspace (and Delete, which many terminals send for Backspace) removes
      // the character before the cursor.
      if (key.backspace || key.delete || input === "\x7f" || input === "\b")
        return edit((v, c) => (c === 0 ? { cursor: 0 } : { value: v.slice(0, c - 1) + v.slice(c), cursor: c - 1 }));
      if (input && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input))
        return edit((v, c) => ({ value: v.slice(0, c) + input + v.slice(c), cursor: c + input.length }));
      return;
    }

    // ── settings page ──
    if (mode.kind === "settings") {
      const len = settingsItems.length;
      if (key.escape) return setMode({ kind: "list" });
      if (key.upArrow || input === "k")
        return setMode((p) => (p.kind === "settings" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
      if (key.downArrow || input === "j")
        return setMode((p) => (p.kind === "settings" ? { ...p, cursor: (p.cursor + 1) % len } : p));
      if (key.return || input === " ") {
        const item = settingsItems[mode.cursor];
        if (item === "provider") return enterProvider(true);
        if (item === "identity") return enterIdentity(true);
        if (item === "autoResume") {
          setAutoResume((v) => {
            const nv = !v;
            persist({ autoResume: nv });
            return nv;
          });
          return;
        }
      }
      return;
    }

    // ── backend picker ──
    if (mode.kind === "provider") {
      const back: Mode = mode.fromSettings ? { kind: "settings", cursor: 0 } : { kind: "list" };
      const len = PROVIDER_INFO.length;
      if (key.escape) return setMode(back);
      if (key.upArrow || input === "k")
        return setMode((p) => (p.kind === "provider" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
      if (key.downArrow || input === "j")
        return setMode((p) => (p.kind === "provider" ? { ...p, cursor: (p.cursor + 1) % len } : p));
      if (key.return) return applyProvider(PROVIDER_INFO[mode.cursor].name, back);
      return;
    }

    // ── identity picker ──
    if (mode.kind === "identity") {
      const back: Mode = mode.fromSettings ? { kind: "settings", cursor: 0 } : { kind: "list" };
      if (key.escape) return setMode(back);
      const len = roster.length;
      if (len === 0) return;
      // Functional updates so rapidly-arriving keys (batched in one stdin chunk)
      // each advance the cursor instead of all reading the same stale value.
      if (key.upArrow || input === "k")
        return setMode((p) => (p.kind === "identity" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
      if (key.downArrow || input === "j")
        return setMode((p) => (p.kind === "identity" ? { ...p, cursor: (p.cursor + 1) % len } : p));
      if (key.return) {
        const picked = roster[mode.cursor];
        if (picked) {
          // Selecting the authenticated user clears the override so the launcher
          // tracks whoever is logged in via az.
          const next = model && picked.id === model.me.id ? null : picked;
          setIdentity(next);
          persist({ identity: next });
          setCursor(0);
        }
        // A picked identity reloads the data, so always land on the list.
        return setMode({ kind: "list" });
      }
      return;
    }

    // ── list mode ──
    // view switching (Tab forward, Shift-Tab back)
    if (key.tab) {
      const order: View[] = ["items", "prs", "sessions"];
      const dir = key.shift ? -1 : 1;
      const next = order[(order.indexOf(view) + dir + order.length) % order.length];
      return switchView(next);
    }
    if (input === "1") return switchView("items");
    if (input === "2") return switchView("prs");
    if (input === "3") return switchView("sessions");

    // toggle path scope ↔ global (only when the launcher is scoped to a path;
    // bare `agendo` is already global, so there's nothing to toggle). `a` = "all".
    if (input === "a" && filterRoot) {
      setCursor(0);
      return setGlobalView((v) => !v);
    }

    // toggle repo grouping (Sessions: whole view · PRs: subgroups per section)
    if (input === "g" && (view === "sessions" || view === "prs")) {
      setCursor(0);
      if (view === "sessions") return setGrouped((v) => !v);
      return setPrsGrouped((v) => !v);
    }

    // new arbitrary session (sessions view only)
    if (input === "n" && view === "sessions") { enterNewSession(); return; }

    // focus the fuzzy-search input (all list views)
    if (input === "/") { setSearchFocus("input"); return; }

    // toggle PR sort order (created ↔ last updated); drafts stay at the bottom
    if (input === "s" && view === "prs") {
      setCursor(0);
      return setPrSort((s) => (s === "created" ? "updated" : "created"));
    }

    // toggle session sort order (updated ↔ created)
    if (input === "s" && view === "sessions") {
      setCursor(0);
      return setSessionSort((s) => (s === "updated" ? "created" : "updated"));
    }

    // open the Settings page (backend · identity · filters · auth status)
    if (input === ",") { enterSettings(); return; }

    // quick shortcut (also in Settings): switch who you are — Work items & PRs only
    if (input === "u") { enterIdentity(); return; }

    if (input === "r") {
      setNotice(null);
      setActivity(new Map()); // drop cached activity so expanded sessions refetch
      requested.current.clear();
      reload();
      return;
    }

    // continue the hovered session in the other agent: convert its transcript
    // and resume the result. Works on a session row in any view. Guard against
    // ctrl-c (handled earlier as quit) so a bare `c` is required.
    if (input === "c" && !key.ctrl && !key.meta) {
      const row = rows[cursor];
      if (!row || row.kind !== "session") {
        setNotice("Select a session row first to continue it in another agent.");
        return;
      }
      continueInOtherAgent(row.session);
      return;
    }

    // open the hovered work item / PR / session in the browser
    if (input === "o") {
      const row = rows[cursor];
      if (!row || (row.kind !== "item" && row.kind !== "pr" && row.kind !== "session")) {
        setNotice("Nothing to open in the browser for this row.");
        return;
      }
      const targets = row.open;
      if (!targets || (!targets.pr && !targets.workItem)) {
        setNotice("Nothing to open in the browser for this row.");
        return;
      }
      const title =
        row.kind === "item"
          ? `#${row.item.id} — ${row.item.title}`
          : row.kind === "pr"
            ? `PR ${V.prPrefix}${row.pr.id} — ${row.pr.title}`
            : row.session.title;
      setNotice(null);
      setMode({ kind: "open", targets, title });
      return;
    }

    if (key.upArrow || input === "k") return move(-1);
    if (key.downArrow || input === "j") return move(1);

    // ── expand/collapse with →/← (or l/h) ──
    const isExpandable = (row: Row) =>
      row.kind === "item" || row.kind === "pr" || row.kind === "toggle" || row.kind === "session";
    const isOpen = (row: Row) =>
      row.kind === "item" || row.kind === "pr" || row.kind === "session"
        ? row.expanded
        : row.kind === "toggle"
          ? row.open
          : false;
    const flipOpen = (row: Row) => {
      if (row.kind === "item") toggleExpand(`wi:${itemKey(row.item)}`);
      else if (row.kind === "pr") toggleExpand(`pr:${prKey(row.pr)}`);
      else if (row.kind === "toggle") toggleSection(row.id);
      else if (row.kind === "session") {
        ensureActivity(row.session); // kick off the lazy parse on first expand
        toggleExpand(sessionExpandKey(row.key));
      }
    };
    // Nesting depth: sections/groups (toggle) = 0, work items / PRs = 1, the
    // sessions & fresh rows under them = 2. Used to climb one level on ←.
    const depthOf = (row: Row) =>
      row.kind === "session" || row.kind === "fresh" ? 2 : row.kind === "item" || row.kind === "pr" ? 1 : 0;

    if (key.rightArrow || input === "l") {
      const row = rows[cursor];
      if (!row || !isExpandable(row)) return;
      if (!isOpen(row)) return flipOpen(row); // expand
      // already open → select the first child (the row right below it)
      const child = rows[cursor + 1];
      if (child && SELECTABLE.has(child.kind)) setCursor(cursor + 1);
      return;
    }
    if (key.leftArrow || input === "h") {
      const row = rows[cursor];
      if (!row) return;
      // An open expandable collapses first; only once it's collapsed (or it's a
      // leaf) does ← climb to the nearest selectable ancestor one level up
      // (child → work item/PR → its section/group).
      if (isExpandable(row) && isOpen(row)) return flipOpen(row);
      const d = depthOf(row);
      for (let i = cursor - 1; i >= 0; i--) {
        if (depthOf(rows[i]) < d && SELECTABLE.has(rows[i].kind)) return setCursor(i);
      }
      return;
    }

    if (key.return) {
      const row = rows[cursor];
      if (!row) return;
      if (row.kind === "item") toggleExpand(`wi:${itemKey(row.item)}`);
      else if (row.kind === "pr") toggleExpand(`pr:${prKey(row.pr)}`);
      else if (row.kind === "toggle") toggleSection(row.id);
      else if (row.kind === "session") {
        open(openSession(row.session, model?.liveWindows.get(sessionName(row.session))));
      } else if (row.kind === "fresh") {
        enterFresh(row.target);
      } else if (row.kind === "newsess") {
        enterNewSession();
      }
    }
  });

  // ── render ──
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press r to retry, q to quit.</Text>
      </Box>
    );
  }
  if (!model) return <Text><Text color="cyan">⟳</Text> Loading work items, PRs & sessions…</Text>;
  if (busy) return <Text><Text color="cyan">⟳</Text> {busy}</Text>;

  if (mode.kind === "agent") {
    const isFree = mode.target.kind === "free";
    return (
      <Box flexDirection="column">
        <Text bold>{isFree ? `New session — pick an agent` : `Fresh session — ${mode.target.title.slice(0, 54)}`}</Text>
        <Text dimColor>{`Which agent should run this session?  ·  ↑/↓ move · enter select · esc back`}</Text>
        <Box marginTop={1} flexDirection="column">
          {AGENT_CHOICES.map((a, i) => {
            const sel = i === mode.cursor;
            return (
              <Text key={a.source} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text bold>{a.label.padEnd(10).slice(0, 10)}</Text>
                <Text dimColor={!sel}>{`  ${a.desc}`}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "repo") {
    const isFree = mode.target.kind === "free";
    return (
      <Box flexDirection="column">
        <Text bold>{isFree ? `New session — pick a repo` : `Fresh session — ${mode.target.title.slice(0, 54)}`}</Text>
        <Text dimColor>{`Pick a repo${isFree ? "" : " to create the worktree in"}  ·  ↑/↓ move · enter select · esc back`}</Text>
        <Box marginTop={1} flexDirection="column">
          {scopedRepos.map((r, i) => {
            const sel = i === mode.cursor;
            return (
              <Text key={r.root} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text bold>{r.name.padEnd(22).slice(0, 22)}</Text>
                {r.total === 0 ? (
                  <Text color={sel ? "black" : "gray"}>{`  (no sessions yet)         `}</Text>
                ) : (
                  <>
                    <Text color={sel ? "black" : "green"}>{` ${String(r.total).padStart(3)} sessions`}</Text>
                    <Text color={sel ? "black" : "gray"}>{` (${r.claude} claude, ${r.copilot} copilot)`}</Text>
                  </>
                )}
                <Text dimColor={!sel}>{`  ${r.root}`}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "identity") {
    const curId = (identity ?? model.me).id;
    return (
      <Box flexDirection="column">
        <Text bold>Switch who you are</Text>
        <Text dimColor>
          {"Work items & PRs reload for the selected person  ·  ↑/↓ move · enter select · esc back"}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {roster.map((m, i) => {
            const sel = i === mode.cursor;
            const isCur = m.id === curId;
            const isMe = m.id === model.me.id;
            return (
              <Text key={m.id} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text color={sel ? "black" : isCur ? "green" : "gray"}>{isCur ? "● " : "○ "}</Text>
                <Text bold>{m.displayName.padEnd(28).slice(0, 28)}</Text>
                {isMe ? <Text color={sel ? "black" : "magenta"}>{" (you)"}</Text> : null}
                <Text dimColor={!sel}>{`  ${m.uniqueName}`}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "settings") {
    const settingValue = (item: "provider" | "identity" | "autoResume"): { text: string; color?: string } =>
      item === "provider"
        ? { text: providerLabel, color: "cyan" }
        : item === "identity"
          ? { text: `${model.identity.displayName}${model.identity.id === model.me.id ? " (you)" : ""}` }
          : { text: autoResume ? "on" : "off", color: autoResume ? "green" : "gray" };
    const settingLabel = (item: "provider" | "identity" | "autoResume") =>
      item === "provider" ? "Backend" : item === "identity" ? "Viewing as" : "Auto-resume on usage limit";
    return (
      <Box flexDirection="column">
        <Text bold>Settings</Text>
        <Text dimColor>{"↑/↓ move · enter change/toggle · esc back"}</Text>
        <Box marginTop={1} flexDirection="column">
          {settingsItems.map((item, i) => {
            const sel = i === mode.cursor;
            const v = settingValue(item);
            return (
              <Text key={item} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text bold>{settingLabel(item).padEnd(28).slice(0, 28)}</Text>
                <Text color={sel ? "black" : v.color}>{v.text}</Text>
              </Text>
            );
          })}
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text bold color="blue">Authentication</Text>
          {PROVIDER_INFO.map((info) => {
            const installed = available.has(info.name);
            const st = authStatus.get(info.name);
            const detail: { text: string; color: string } = !installed
              ? { text: `${info.cli} not installed — ${info.authHint}`, color: "yellow" }
              : st === undefined || st === "checking"
                ? { text: `${info.cli} installed · checking…`, color: "gray" }
                : st
                  ? { text: `${info.cli} installed · authenticated ✓`, color: "green" }
                  : { text: `${info.cli} installed · not authenticated ✗ — ${info.authHint}`, color: "red" };
            return (
              <Box key={info.name} marginLeft={2}>
                <Text wrap="truncate">
                  <Text bold>{info.label.padEnd(16).slice(0, 16)}</Text>
                  <Text color={detail.color}>{detail.text}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "provider") {
    return (
      <Box flexDirection="column">
        <Text bold>Switch backend</Text>
        <Text dimColor>
          {"Everything reloads from the selected backend  ·  ↑/↓ move · enter select · esc back"}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {PROVIDER_INFO.map((info, i) => {
            const sel = i === mode.cursor;
            const isCur = info.name === provider;
            const ok = available.has(info.name);
            return (
              <Text key={info.name} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text color={sel ? "black" : isCur ? "green" : "gray"}>{isCur ? "● " : "○ "}</Text>
                <Text bold color={sel ? "black" : ok ? undefined : "gray"}>{info.label.padEnd(16).slice(0, 16)}</Text>
                {ok ? (
                  <Text dimColor={!sel}>{`  via ${info.cli}`}</Text>
                ) : (
                  <Text color={sel ? "black" : "yellow"}>{`  ${info.cli} not installed — ${info.authHint}`}</Text>
                )}
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "wtchoice") {
    const opts = ["New git worktree", "Main repo checkout"];
    const descs = [
      `branch + worktree under ${mode.repo.root}/.claude/worktrees/`,
      `runs directly in ${mode.repo.root}`,
    ];
    return (
      <Box flexDirection="column">
        <Text bold>{`New session in ${mode.repo.name} — choose where to run`}</Text>
        <Text dimColor>{"↑/↓ move · enter select · esc back"}</Text>
        <Box marginTop={1} flexDirection="column">
          {opts.map((label, i) => {
            const sel = i === mode.cursor;
            return (
              <Text key={i} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
                {sel ? "❯ " : "  "}
                <Text bold>{label.padEnd(22).slice(0, 22)}</Text>
                <Text dimColor={!sel}>{`  ${descs[i]}`}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    );
  }

  if (mode.kind === "branch") {
    const { value, cursor } = mode;
    const isFree = mode.target.kind === "free";
    // Free sessions get a `cl-new-<id>` name assigned at launch, so we can only
    // preview the prefix; item/PR launches already know their target name.
    const tmuxPreview = isFree ? "cl-new-…" : mode.target.tmuxName;
    return (
      <Box flexDirection="column">
        <Text bold>{isFree ? `New session in ${mode.repo.name}` : `Fresh session in ${mode.repo.name} — ${mode.target.title.slice(0, 40)}`}</Text>
        <Text dimColor>{mode.worktree ? "New branch off origin/HEAD · ←/→ move · ⌃a/⌃e start/end · enter create & launch · esc back" : "Session name · ←/→ move · ⌃a/⌃e start/end · enter launch · esc back"}</Text>
        <Box marginTop={1}>
          <Text>{mode.worktree ? "branch: " : "name:   "}</Text>
          <Text color="cyan">{value.slice(0, cursor)}</Text>
          <Text inverse>{value[cursor] ?? " "}</Text>
          <Text color="cyan">{value.slice(cursor + 1)}</Text>
        </Box>
        <Box marginTop={1}>
          {mode.worktree
            ? <Text dimColor>{`→ ${mode.agent} · worktree at ${mode.repo.root}/.claude/worktrees/${worktreeDirName(value)}`}</Text>
            : <Text dimColor>{`→ ${mode.agent} · runs in ${mode.repo.root}  · tmux ${tmuxPreview}`}</Text>
          }
        </Box>
      </Box>
    );
  }

  if (mode.kind === "open") {
    const { pr, workItem } = mode.targets;
    return (
      <Box flexDirection="column">
        <Text bold>{`Open in browser — ${mode.title.slice(0, 54)}`}</Text>
        <Text dimColor>{"Pick what to open · esc/q cancel"}</Text>
        <Box marginTop={1} flexDirection="column">
          {pr ? (
            <Text>
              <Text bold color="magenta">{"  p"}</Text>
              <Text>{`  PR ${V.prPrefix}${pr.id}`}</Text>
            </Text>
          ) : null}
          {workItem ? (
            <Text>
              <Text bold color="cyan">{"  i"}</Text>
              <Text>{`  issue #${workItem.id}`}</Text>
            </Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  // list view
  const tab = (v: View, label: string) => (
    <Text
      bold={view === v}
      backgroundColor={view === v ? "cyan" : undefined}
      color={view === v ? "black" : undefined}
      dimColor={view !== v}
    >
      {` ${label} `}
    </Text>
  );
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agendo </Text>
        <Text color="cyan">{`[${providerLabel}]  `}</Text>
        {tab("items", `1 ${V.itemsTab}`)}
        <Text> </Text>
        {tab("prs", "2 PRs")}
        <Text> </Text>
        {tab("sessions", "3 Sessions")}
      </Box>
      {filterRoot ? (
        <Box>
          <Text wrap="truncate">
            <Text color={scoped ? "green" : "yellow"}>
              {scoped ? `⊙ ${hostSession}: ${homeShort(filterRoot)}` : "⊙ global — all paths"}
            </Text>
            <Text dimColor>{`  · a ${scoped ? "show all" : `rescope to ${hostSession}`}`}</Text>
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text wrap="truncate" dimColor>
          {searchFocus === "input"
            ? `type to filter · ←/→ caret · ⌫ delete · ⌃w del word · ↓ results · enter ${view === "sessions" ? "resume" : "open"} · esc cancel`
            : searchFocus === "list"
              ? `↑/↓ move · ↑ at top edits search · → expand · / edit · enter ${view === "sessions" ? "resume" : "open"} · o browser · esc cancel`
              : view === "sessions"
                ? `↑/↓ move · → expand · ⇥ switch view · g ${grouped ? "ungroup" : "group"} · s sort: ${sessionSort} · / search · n new · enter resume · c →other agent · o browser · , settings · r refresh · q/esc quit`
                : view === "prs"
                  ? `↑/↓ move · → expand · ⇥ view · g ${prsGrouped ? "ungroup" : "group"} · s sort: ${prSort === "created" ? "created" : "updated"} · / search · enter open · o browser · , settings · r refresh · q/esc quit`
                  : "↑/↓ move · →/← expand · ⇥ switch view · / search · enter open/expand · o browser · , settings · r refresh · q/esc quit"}
        </Text>
      </Box>
      {searchFocus ? (
        <Box>
          <Text wrap="truncate">
            <Text color={searchFocus === "input" ? "cyan" : "gray"}>{"search "}</Text>
            {searchFocus === "input" ? (
              <Text>
                {search.text.slice(0, search.cursor)}
                <Text inverse>{search.text[search.cursor] ?? " "}</Text>
                {search.text.slice(search.cursor + 1)}
              </Text>
            ) : (
              <Text dimColor>{search.text}</Text>
            )}
          </Text>
        </Box>
      ) : null}
      {view !== "sessions" ? (
        <Box>
          <Text wrap="truncate">
            <Text color="magenta">{"as "}</Text>
            <Text bold>
              {model.identity.displayName}
              {model.identity.id === model.me.id ? " (you)" : ""}
            </Text>
          </Text>
        </Box>
      ) : null}
      {view !== "sessions" ? (
        <ColumnHeader
          headers={view === "prs" ? prHeaders(prSort) : HEADERS_ITEMS}
          widths={view === "prs" ? PR_WIDTHS : ITEM_WIDTHS}
        />
      ) : null}
      <Text dimColor>{moreAbove > 0 ? `  ↑ ${moreAbove} more` : " "}</Text>

      {visible.map((row, li) => {
        const i = scrollTop + li;
        const selected = i === cursor && searchFocus !== "input";
        if (row.kind === "spacer") return <Text key={`s${i}`}> </Text>;
        if (row.kind === "header") {
          return (
            <Box key={`h${i}`}>
              <Text wrap="truncate" bold color="blue">{row.label}</Text>
              {row.sub ? <Text dimColor>{`  ${row.sub}`}</Text> : null}
            </Box>
          );
        }
        if (row.kind === "item") {
          return (
            <ItemRow key={`i${itemKey(row.item)}`} item={row.item} expanded={row.expanded} running={row.running} selected={selected} />
          );
        }
        if (row.kind === "pr") {
          return (
            <PrRow
              key={`p${prKey(row.pr)}`}
              pr={row.pr}
              expanded={row.expanded}
              running={row.running}
              selected={selected}
              contextCell={row.contextCell}
              sort={prSort}
            />
          );
        }
        if (row.kind === "session") {
          return (
            <SessionRow
              key={row.key}
              session={row.session}
              running={row.running}
              kind={row.running ? model?.liveKinds.get(sessionName(row.session)) : undefined}
              pane={row.running ? panes.get(sessionName(row.session)) : undefined}
              expanded={row.expanded}
              selected={selected}
              timeField={row.timeField}
              open={row.open}
              showLink={row.showLink}
              placeholder={row.placeholder}
            />
          );
        }
        if (row.kind === "sessmeta") {
          return (
            <Box key={row.key} marginLeft={6}>
              <Text wrap="truncate" dimColor>
                <Text color="gray">{row.label.padEnd(8)}</Text>
                {row.value}
              </Text>
            </Box>
          );
        }
        if (row.kind === "sessprompt") {
          return (
            <Box key={row.key} marginLeft={6}>
              <Text wrap="truncate" dimColor>{`↳ "${row.prompt.replace(/\s+/g, " ")}"`}</Text>
            </Box>
          );
        }
        if (row.kind === "task") {
          return <TaskRow key={row.key} task={row.task} />;
        }
        if (row.kind === "action") {
          return <ActionRow key={row.key} action={row.action} />;
        }
        if (row.kind === "sessnote") {
          return (
            <Box key={row.key} marginLeft={6}>
              <Text dimColor italic>{row.text}</Text>
            </Box>
          );
        }
        if (row.kind === "newsess") {
          return (
            <Box key="newsess">
              <Text bold color={selected ? "black" : "green"} backgroundColor={selected ? "cyan" : undefined}>
                {"＋ new session"}
              </Text>
            </Box>
          );
        }
        if (row.kind === "fresh") {
          return (
            <Box key={row.key} marginLeft={4}>
              <Text color={selected ? "black" : "gray"} backgroundColor={selected ? "cyan" : undefined}>
                {"+ start a fresh session…"}
              </Text>
            </Box>
          );
        }
        // toggle section
        const caret = row.open ? "▾" : "▸";
        return (
          <Box key={`toggle:${row.id}`} marginLeft={row.indent ?? 0}>
            <Text wrap="truncate" color={selected ? "black" : "blue"} backgroundColor={selected ? "cyan" : undefined} bold>
              {`${caret} ${row.label} (${row.count})`}
              {row.sub ? <Text color={selected ? "black" : "gray"}>{`  ${row.sub}`}</Text> : null}
            </Text>
          </Box>
        );
      })}

      <Text dimColor>{moreBelow > 0 ? `  ↓ ${moreBelow} more` : " "}</Text>
      {notice ? (
        <Box>
          <Text color="yellow">⚑ {notice}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
