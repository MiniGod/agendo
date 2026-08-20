// Shared domain types for the launcher.

/** Which backend the launcher talks to (Azure DevOps or GitHub). */
export type ProviderName = "ado" | "github";

/**
 * Every agent the launcher can run, in display / validation order. The union is
 * derived from this array so a new agent can't be added to one and missed in the
 * other (the CLI's `--agent` check and the TUI picker both read the array).
 */
export const AGENTS = ["claude", "copilot", "codex"] as const;

export type AgentSource = (typeof AGENTS)[number];

/** A resumable agent session discovered on disk (Claude Code, Copilot or Codex CLI). */
export interface AgentSession {
  /**
   * Stable id used to resume: Claude sessionId / Copilot session dir id /
   * Codex thread id (the UUID in its `rollout-…-<id>.jsonl` filename).
   */
  id: string;
  source: AgentSource;
  /** Working directory the session ran in (where resume must be invoked). */
  cwd: string;
  /** git branch the session was last on, if known. */
  branch?: string;
  /**
   * Repository identifier. Copilot stores "org/project/repo"; Codex records the
   * `origin` remote URL, which we reduce to an `owner/repo` slug (GitHub) or a
   * bare repo name, so both live in the same identity domain (see sessionInScope).
   */
  repository?: string;
  /** Human-friendly title for the session. */
  title: string;
  /** Most recent activity (file mtime, good enough for sorting). */
  lastUsed: Date;
  /**
   * When the session was first created — the timestamp of the first entry in the
   * session's transcript. NOT file birthtime (unreliable on Linux). May be absent
   * for Copilot sessions and older/edge sessions; callers fall back to `lastUsed`.
   */
  createdAt?: Date;
  /**
   * For Claude sessions: the config dir the session was found under
   * (e.g. ~/.claude or ~/.claude-work). Resume must set CLAUDE_CONFIG_DIR to
   * this so the right subscription/profile finds the session.
   */
  configDir?: string;
  /**
   * On-disk location used to load the session's recent activity on demand
   * (when its row is expanded). Claude: the `<id>.jsonl` log file. Copilot:
   * the session-state directory (which holds `events.jsonl`). Codex: the
   * `rollout-…-<id>.jsonl` file.
   */
  logPath?: string;
  /**
   * Claude Workflow runs launched by this session (multi-agent orchestrations
   * started via the Workflow tool), in launch order. Extracted from the
   * transcript during indexing; absent when none were launched (always for
   * Copilot and Codex). Details (agent progress, phases) load on demand — see workflows.ts.
   */
  workflows?: WorkflowRef[];
}

// ── Claude Workflow runs ─────────────────────────────────────────────────────
// A "workflow" is Claude Code's Workflow tool: a background multi-agent
// orchestration. Its lifecycle leaves three traces we read (never write):
//   1. the launch tool_result in the session transcript (structured
//      `toolUseResult` with taskType "local_workflow") — identity + paths,
//   2. a `<task-notification>` user message in the transcript when it finishes,
//   3. run files under `<sessionDir>/subagents/workflows/<runId>/` (journal +
//      per-agent transcripts) and the script under
//      `<sessionDir>/workflows/scripts/` — progress + phase metadata.

/** One phase declared in a workflow script's `meta.phases`. */
export interface WorkflowPhase {
  title: string;
  detail?: string;
  model?: string;
}

/** A workflow run as recorded in the session transcript (cheap, index-time). */
export interface WorkflowRef {
  /** Run id (`wf_…`) — stable across resumes of the same run. */
  runId: string;
  /** Background-task id the completion notification references. */
  taskId?: string;
  /** Workflow name from the script's meta. */
  name: string;
  /** One-line summary reported at launch. */
  summary?: string;
  /** Directory holding journal.jsonl + per-agent transcripts. */
  transcriptDir?: string;
  /** The persisted workflow script (carries the meta literal). */
  scriptPath?: string;
  launchedAt?: Date;
  /** Raw `<status>` from the completion task-notification, if one arrived. */
  notifiedStatus?: string;
}

/**
 * Effective run state. "interrupted" = never notified as finished, but the
 * session that ran it has no live tmux window — workflows run in-process, so
 * the run died with the session.
 */
export type WorkflowStatus = "running" | "completed" | "failed" | "stopped" | "interrupted";

/** On-demand detail for one run, read from its files (see loadWorkflowDetails). */
export interface WorkflowDetails {
  /** Agents spawned so far (unique `started` events in the journal). */
  agentsStarted: number;
  /** Agents finished (unique `result` events in the journal). */
  agentsDone: number;
  /** Most recent write in the run's transcript dir (activity heartbeat). */
  lastActivity?: Date;
  /** Description from the script's meta (fallback when the ref has no summary). */
  description?: string;
  /** Phases declared in the script's meta, in order. */
  phases?: WorkflowPhase[];
  /** Agent count per model (from per-agent meta files), e.g. { sonnet: 2 }. */
  modelCounts?: Record<string, number>;
}

/** One recent action in a session's log (a tool call, a model message, …). */
export interface ActionLine {
  timestamp: Date;
  /** Display verb: "Bash", "Edit", "Claude", "Thinking", … */
  verb: string;
  /** Short detail: a command, file path, or message excerpt. */
  detail: string;
  /**
   * Milliseconds since the previous action in the full log (undefined for the
   * first action). Computed over the whole log before truncation, so the first
   * surfaced line still reflects the real gap from the action before it.
   */
  deltaMs?: number;
}

/** Status of a checklist item, normalized across sources. */
export type TaskStatus = "pending" | "in_progress" | "completed";

/**
 * One item in the agent's task checklist. Reconstructed for Claude sessions
 * from the latest TodoWrite tool call, or (fallback) by replaying des-workflow
 * TaskCreate/TaskUpdate events. Copilot sessions have none.
 */
export interface TaskItem {
  label: string;
  status: TaskStatus;
}

/** A session's recent activity, loaded lazily when its row is expanded. */
export interface SessionActivity {
  /** The most recent human prompt, if any (shown as a header line). */
  lastPrompt?: string;
  /** Recent actions, chronological (oldest → newest), capped to the last N. */
  actions: ActionLine[];
  /**
   * The agent's current task checklist, in the order the agent listed it.
   * Empty/absent when the session recorded no tasks (always for Copilot).
   */
  tasks?: TaskItem[];
  /**
   * The FULL, untruncated text of the last assistant text block — the agent's
   * final response. Surfaced verbatim by `agendo status` so an orchestrator can
   * read the whole answer (the action lines above are truncated for display).
   */
  finalResponse?: string;
}

export type PRStatus = "active" | "completed" | "abandoned" | "unknown";

/**
 * CI / merge-gate status, derived from branch-policy evaluations + mergeStatus.
 * "expired" means a build ran but its result aged out past the policy's
 * validDuration — ADO reverts such evaluations to "queued", which is misleading
 * (nothing is actually queued); we surface them as expired instead.
 */
export type CIStatus = "pass" | "fail" | "running" | "queued" | "expired" | "conflict" | "none";

export interface PullRequest {
  id: number;
  title: string;
  status: PRStatus;
  /** Source branch without the refs/heads/ prefix. */
  branch: string;
  repositoryId: string;
  repositoryName?: string;
  isDraft: boolean;
  /** Net vote summary: approvals / waiting / rejections. */
  approvals: number;
  rejections: number;
  waiting: number;
  /** Approval progress toward the gate: approvedCount of requiredCount (X/Y). */
  approvedCount: number;
  requiredCount: number;
  /**
   * The provider's OWN verdict on the review gate, for a provider that reports
   * whether the gate is satisfied without reporting how big it is (GitHub's
   * `reviewDecision`). Authoritative when set: it outranks comparing
   * approvedCount against requiredCount, which can only ever be as good as
   * `requiredCount` is. Left undefined by a provider that reports an exact
   * count instead (Azure DevOps), where the comparison IS the verdict.
   */
  gateMet?: boolean;
  /** CI / merge-gate status. "none" until policy enrichment fills it in. */
  ci: CIStatus;
  /**
   * When `ci` is "expired": the last known result of the build that expired, if
   * it could still be fetched. PR-validation builds are frequently purged by
   * retention, so this is often `undefined` (result no longer recoverable).
   */
  ciExpiredResult?: "pass" | "fail";
  /** Creation time (epoch ms). */
  createdDate: number;
  /** Last-update time (epoch ms) — last pushed iteration; enrichment fills it. */
  updatedDate: number;
  /**
   * Web URL of the pull request, built by the backend's canonical URL builder
   * (see Provider.urls). Empty string when the backend payload carried no
   * repository to scope the link to — every consumer must read `""` as "no
   * link" rather than opening or handing over a half-built URL.
   */
  url: string;
}

/** An orphan PR (no linked work item) with the sessions on its branch. */
export interface PRWithSessions extends PullRequest {
  sessions: AgentSession[];
}

/** A member of the configured team — used by the "switch who you are" picker. */
export interface TeamMember {
  /** ADO identity/member id (usable as creatorId / reviewerId). */
  id: string;
  displayName: string;
  /** Unique name (email/UPN), used in WIQL `[System.AssignedTo] = '…'`. */
  uniqueName: string;
}

/** The identity the launcher is currently acting as. */
export type Identity = TeamMember;

/** A PR where the viewing identity (or one of their teams) is a reviewer. */
export interface ReviewPR extends PullRequest {
  /** Why this PR is here: "you", a team name, or e.g. "Team A +1". */
  reviewReason: string;
}

/** A review PR with the sessions on its branch. */
export interface ReviewPRWithSessions extends ReviewPR {
  sessions: AgentSession[];
}

/** A PR linked to a work item, with the sessions on its branch. */
export interface LinkedPR extends PRWithSessions {
  workItemId: number;
  workItemType: string;
  workItemTitle: string;
  /** Web URL of the linked work item. */
  workItemUrl: string;
}

/** Local sessions grouped by the main repo of their worktree. */
export interface RepoSessions {
  /** Repo root, or the cwd itself when no git repo was found. */
  root: string;
  /** Display name (basename of root). */
  name: string;
  sessions: AgentSession[];
}

export interface WorkItem {
  id: number;
  type: string;
  title: string;
  state: string;
  boardColumn?: string;
  iterationPath: string;
  project: string;
  /** Whether this item is in the team's current iteration. */
  inCurrentSprint: boolean;
  /** PRs linked to this item via ArtifactLink relations. */
  prs: PullRequest[];
  /** Sessions whose branch matches one of this item's PR branches. */
  sessions: AgentSession[];
  /** Web URL of the work item (the Boards details/edit page), from the backend's
   *  canonical URL builder. `""` means "no link" — see PullRequest.url. */
  url: string;
}
