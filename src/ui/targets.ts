import { freshName, prFreshName } from "../launch.ts";
import { defaultBranch } from "../worktree.ts";
import { ORCHESTRATOR_SLUG } from "../orchestrator.ts";
import { V } from "./vocabState.ts";
import type { LinkedPR, PRWithSessions, WorkItem } from "../types.ts";

// A target for the fresh-session flow — derived from either a work item or a PR.
// Work items create a NEW branch off origin/HEAD (so we prompt for its name);
// PRs check out the PR's EXISTING branch from origin (no prompt — there's no new
// branch to name).
export interface FreshTarget {
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
  /**
   * Launch this session in orchestrator mode — it coordinates and delegates
   * instead of implementing (see src/orchestrator.ts). Only set on "free"
   * targets, and it forces Claude (Copilot can't carry the instructions), so the
   * flow skips the agent picker.
   */
  orchestrator?: boolean;
}
export function wiTarget(item: WorkItem): FreshTarget {
  return {
    kind: "new",
    // Scope the tmux name by repo on GitHub (issue numbers collide across repos).
    tmuxName: freshName(item.id, V.repoScopedFresh ? item.project : undefined),
    defaultBranch: defaultBranch(item.id, item.title),
    title: `#${item.id} — ${item.title}`,
  };
}
export function prTarget(pr: PRWithSessions): FreshTarget {
  return {
    kind: "pr",
    tmuxName: prFreshName(pr.id, V.repoScopedFresh ? pr.repositoryId : undefined),
    defaultBranch: pr.branch,
    prBranch: pr.branch,
    title: `PR ${V.prPrefix}${pr.id} — ${pr.title}`,
    preferRepo: pr.repositoryName,
  };
}
export function freeTarget(): FreshTarget {
  return { kind: "free", tmuxName: "", defaultBranch: "", title: "New session" };
}
/**
 * A free target that runs in orchestrator mode. `defaultBranch` prefills the
 * worktree/branch prompt with the launcher's own orchestrator slug — the
 * worktree is a coordination desk, so it's named after the role, not the work.
 */
export function orchestratorTarget(): FreshTarget {
  return {
    kind: "free",
    orchestrator: true,
    tmuxName: "",
    defaultBranch: ORCHESTRATOR_SLUG,
    title: "Orchestrator session",
  };
}

// What the "open in browser" (o) dialog can open for a given row. A row may
// offer the PR, the work item, or both — sessions inherit their parent's.
export interface OpenTargets {
  pr?: { id: number; url: string };
  workItem?: { id: number; url: string };
}
// Each target is included only when it actually has a URL: a PullRequest/WorkItem
// whose `url` is "" carries no link (see types.ts), and offering it would open
// the browser on an empty address.
export function wiOpen(item: WorkItem): OpenTargets {
  const primary = item.prs[0];
  return {
    ...(item.url ? { workItem: { id: item.id, url: item.url } } : {}),
    ...(primary?.url ? { pr: { id: primary.id, url: primary.url } } : {}),
  };
}
export function prOpen(pr: PRWithSessions): OpenTargets {
  const linked = pr as Partial<LinkedPR>;
  return {
    ...(pr.url ? { pr: { id: pr.id, url: pr.url } } : {}),
    ...(linked.workItemId != null && linked.workItemUrl
      ? { workItem: { id: linked.workItemId, url: linked.workItemUrl } }
      : {}),
  };
}
