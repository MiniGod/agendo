// One row of the enriched `agendo list` — the table and `--json` alike:
// everything a session says about itself, decided apart from how the listing
// is printed. Split out of list.ts, which sits at the shared max-lines budget.

import { basename } from "path";
import {
  capturePaneState, paneBackgroundAgents, paneReadiness, paneResumeDialogActive, paneShells, sessionName, shortId,
  type LiveTarget, type Readiness, type SessionKind,
} from "../tmux.ts";
import { idleSeconds, isStalled } from "../idle.ts";
import type { SessionLink } from "../model/types.ts";
import type { OrchestratorRole } from "../orchestrator.ts";
import { repoRootForCwd } from "../repos.ts";
import type { AgentSession, AgentSource, BranchSync, BranchSyncReader, WorkflowStatus } from "../types.ts";
import { workflowStatus } from "../workflows.ts";
import { rowCompactionPercent, rowResetAt } from "./cells.ts";

export interface ListRow {
  id: string;
  shortId: string;
  source: AgentSource;
  running: boolean;
  /** Input readiness from the live pane, or null when idle (no pane to read). */
  readiness: Readiness | null;
  /**
   * Sitting on claude's OWN resume dialog — the same signal `wait --json`
   * reports. Carried here because it is the one case where a large `idleSeconds`
   * means the opposite of what it looks like: the session hasn't run yet, so the
   * age belongs to the previous run and `stalled` is deliberately false. Without
   * it a consumer would have to re-infer that from the pane itself.
   */
  resumeDialog: boolean;
  /**
   * When the usage limit resets, as an ISO 8601 instant — set only for a
   * "limited" row whose pane states a time (the numbered limit dialog hides it,
   * and we never press a key to reveal it), null otherwise. Machine-readable on
   * purpose: the human list renders the same instant in the local locale.
   *
   * The other reason a consumer wants it: a `limited` row is never `stalled`
   * however old it is (see src/idle.ts), and this is what says when it stops
   * being someone else's problem.
   */
  limitResetAt: string | null;
  /**
   * How far a "compacting" row's progress bar has got (0-100), null for every other
   * state and for a compacting pane that isn't drawing one yet. Like `limitResetAt`,
   * it says how long someone else's pause has left to run — a compacting session is
   * blocked but progressing, and this is the difference between "wait" and "stuck".
   */
  compactionPercent: number | null;
  /** Background shells the running pane reports (0 when idle/unknown). */
  shells: number;
  /** How it was launched, when running (from the live-tmux reconciliation). */
  kind: SessionKind | null;
  /**
   * Whether this session coordinates other sessions rather than doing work
   * itself, and at which level of the hierarchy — `"repo"` runs one repository's
   * sessions and merges their branches, `"global"` runs the repo orchestrators.
   * `null` (and `orchestrator: false`) is an ordinary worktree session.
   *
   * A first-class field, not an inference from `kind`: an orchestrator launches
   * as a `background` session and is indistinguishable from one by every other
   * field on this row. Unlike the live-only `kind`, it is known for idle sessions
   * too — the marker file outlives the tmux window.
   */
  orchestrator: boolean;
  role: OrchestratorRole | null;
  branch: string | null;
  cwd: string;
  /**
   * The repo the session belongs to — its checkout's root, so every worktree
   * folds back onto the repository itself. This is the grouping key for "which
   * repos have an orchestrator and which do not", and a consumer cannot derive it
   * from `cwd` without repeating agendo's worktree-path arithmetic.
   *
   * NULL for a `role: "global"` row, which belongs to no repository at all.
   */
  repoRoot: string | null;
  repoName: string | null;
  dir: string;
  title: string;
  /** When the session was last active (ISO 8601), for machine consumers. */
  lastUsed: string;
  /** Seconds since that last activity — idle age, without parsing a timestamp. */
  idleSeconds: number;
  /**
   * QUALIFIER, not a readiness state: the session is live, isn't mid-turn, and
   * has done nothing for at least `stalledAfterSeconds`. It does NOT mean the
   * work is unfinished — agendo cannot know that. See src/idle.ts.
   */
  stalled: boolean;
  /** The threshold `stalled` was judged against, so the flag reads standalone. */
  stalledAfterSeconds: number;
  /**
   * Local-vs-origin state of the session's checkout, read from `.git` ref files
   * (never a `git` process, never a fetch). `null` when undeterminable — which
   * is NOT the same as "in sync". See src/gitrefs.ts.
   */
  git: BranchSync | null;
  /** Linked PR, resolved through the model's reverse index (null if none/unknown). */
  pr: { id: number; url: string } | null;
  /** Linked work item / issue, resolved through the model's reverse index. */
  workItem: { id: number; url: string } | null;
  /**
   * The same two links flattened to top-level fields — null when unlinked, never
   * a partially-built URL. Agents consume this JSON to hand a human a clickable
   * link; a first-class field beats making them reach into a nested object (or,
   * worse, reconstruct the URL from an id and guess the host shape).
   */
  prUrl: string | null;
  workItemUrl: string | null;
  /** Workflow-tool runs the session launched, with their effective status. */
  workflows: { runId: string; name: string; status: WorkflowStatus; summary: string | null }[];
}

/** What every row of one listing shares: the live tmux state, the roles, the links, and the options. */
export interface ListRowContext {
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  /** One read of the marker file for the whole listing, not one per row. */
  roles: Map<string, OrchestratorRole>;
  linkOf: (s: AgentSession) => SessionLink | undefined;
  thresholdMs: number;
  /**
   * Ref-file reads only, and only here on the one-shot CLI path — never from
   * SessionIndex.build()/loadLocalSessions(), which the 2s rescan drives.
   * Null unless a JSON consumer will actually read it: the human table doesn't
   * render it, and `--all` can enumerate every session on disk.
   */
  readBranchSync: BranchSyncReader | null;
}

/** What a running session's pane says; the nulls and zeros when there is no pane to read. */
export interface PaneFields {
  readiness: Readiness | null;
  shells: number;
  backgroundAgents: number;
  /**
   * Parked on claude's own resume dialog: reads `ready`, but nothing has run
   * yet, so its idle age is the previous run's and it is never stalled.
   */
  resumeDialog: boolean;
  resetAt: number | null;
  compactionPercent: number | null;
}

const NO_PANE: PaneFields = { readiness: null, shells: 0, backgroundAgents: 0, resumeDialog: false, resetAt: null, compactionPercent: null };

export function paneFields(target: string | undefined): PaneFields {
  if (target === undefined) return NO_PANE;
  const { raw, cursor } = capturePaneState(target);
  const readiness = paneReadiness(raw, cursor);
  return {
    readiness,
    shells: paneShells(raw),
    backgroundAgents: paneBackgroundAgents(raw),
    resumeDialog: paneResumeDialogActive(raw),
    resetAt: rowResetAt(readiness, raw),
    compactionPercent: rowCompactionPercent(readiness, raw),
  };
}

/**
 * A link whose URL couldn't be built reads as absent — applied once here so
 * the nested object and the flattened *Url field can never disagree.
 */
export function usableLink(l: { id: number; url: string } | undefined): { id: number; url: string } | null {
  return l?.url ? l : null;
}

/**
 * NULL for the global orchestrator, which belongs to no repository. Its cwd
 * is a vantage point picked precisely because it is not a checkout, so
 * `repoRootForCwd` hands back that bare directory — and a consumer applying
 * the rule this listing is documented by ("a repo whose rows carry no
 * role:'repo' session is unmanaged") would read it as a repo nobody is
 * coordinating and start an orchestrator in a non-repo. `list repos` leaves
 * it out for the same reason.
 */
export function repoFields(role: OrchestratorRole | null, cwd: string): { repoRoot: string | null; repoName: string | null } {
  if (role === "global") return { repoRoot: null, repoName: null };
  const root = repoRootForCwd(cwd);
  return { repoRoot: root, repoName: basename(root) || root };
}

/** The live half of a row: whether it is running, its kind while it is, and what its pane says. */
export function liveFields(s: AgentSession, ctx: ListRowContext): { running: boolean; kind: SessionKind | null; pane: PaneFields } {
  const canon = sessionName(s);
  const running = ctx.live.has(canon);
  if (!running) return { running, kind: null, pane: NO_PANE };
  return { running, kind: ctx.liveKinds.get(canon) ?? null, pane: paneFields(ctx.liveWindows.get(canon)?.target) };
}

/**
 * The linked PR and work item, nested and flattened. Siblings of the other
 * fields, not nested under them: a consumer reads `stalled` and `prUrl` off
 * the same row object.
 */
export function linkFields(l: SessionLink | undefined): Pick<ListRow, "pr" | "workItem" | "prUrl" | "workItemUrl"> {
  const pr = usableLink(l?.pr);
  const workItem = usableLink(l?.workItem);
  return { pr, workItem, prUrl: pr?.url ?? null, workItemUrl: workItem?.url ?? null };
}

/** Workflow-tool runs the session launched, with their effective status. */
export function rowWorkflows(s: AgentSession, running: boolean): ListRow["workflows"] {
  return (s.workflows ?? []).map((w) => ({
    runId: w.runId,
    name: w.name,
    status: workflowStatus(w, running),
    summary: w.summary ?? null,
  }));
}

export function listRow(s: AgentSession, ctx: ListRowContext): ListRow {
  const { running, kind, pane } = liveFields(s, ctx);
  const role = ctx.roles.get(s.id) ?? null;
  const idle = idleSeconds(s.lastUsed);
  return {
    id: s.id,
    shortId: shortId(s.id),
    source: s.source,
    running,
    readiness: pane.readiness,
    resumeDialog: pane.resumeDialog,
    limitResetAt: pane.resetAt === null ? null : new Date(pane.resetAt).toISOString(),
    compactionPercent: pane.compactionPercent,
    shells: pane.shells,
    kind,
    orchestrator: ctx.roles.has(s.id),
    role,
    branch: s.branch ?? null,
    cwd: s.cwd,
    ...repoFields(role, s.cwd),
    dir: basename(s.cwd) || s.cwd,
    title: s.title.replace(/\s+/g, " ").trim(),
    lastUsed: s.lastUsed.toISOString(),
    idleSeconds: idle,
    stalled: isStalled({ running, readiness: pane.readiness, resumeDialog: pane.resumeDialog, backgroundAgents: pane.backgroundAgents, idleSeconds: idle }, ctx.thresholdMs),
    // Exact, NOT floored: a consumer re-deriving `idleSeconds >= stalledAfterSeconds`
    // must reach the same verdict this row already carries, including for
    // sub-second thresholds.
    stalledAfterSeconds: ctx.thresholdMs / 1000,
    git: ctx.readBranchSync ? ctx.readBranchSync(s.cwd) : null,
    ...linkFields(ctx.linkOf(s)),
    workflows: rowWorkflows(s, running),
  };
}
