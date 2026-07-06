// Shared domain types for the launcher.

/** Which backend the launcher talks to (Azure DevOps or GitHub). */
export type ProviderName = "ado" | "github";

export type AgentSource = "claude" | "copilot";

/** A resumable agent session discovered on disk (Claude Code or Copilot CLI). */
export interface AgentSession {
  /** Stable id used to resume: Claude sessionId / Copilot session dir id. */
  id: string;
  source: AgentSource;
  /** Working directory the session ran in (where resume must be invoked). */
  cwd: string;
  /** git branch the session was last on, if known. */
  branch?: string;
  /** Repository identifier (Copilot stores "org/project/repo"). */
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
   * the session-state directory (which holds `events.jsonl`).
   */
  logPath?: string;
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
  /** Web URL of the work item (the Boards details/edit page). */
  url: string;
}
