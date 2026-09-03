// The pure half of loadModel (../model.ts): joining what the backend returned
// to the on-disk sessions. Everything here is a function of its arguments — no
// fetch, no tmux — so the unit suite can drive the joins the e2e fixtures never
// reach: a PR shared by two items, a finished PR, a session under both a PR and
// an item, a poorer link source that must not clobber a richer one.
import type { SessionIndex } from "../sessions.ts";
import type {
  AgentSession, LinkedPR, PRWithSessions, PullRequest, ReviewPR, ReviewPRWithSessions, WorkItem,
} from "../types.ts";
import { prKey } from "./scope.ts";
import type { SessionLink } from "./types.ts";

/** The two lookups the joins need: the real SessionIndex, or a stand-in. */
export type SessionLookup = Pick<SessionIndex, "forBranch" | "forWorkItem">;

function byLastUsed(a: AgentSession, b: AgentSession): number {
  return b.lastUsed.getTime() - a.lastUsed.getTime();
}

/**
 * Collect sessions for a work item: via each PR's branch, plus any session
 * whose branch/worktree embeds the work-item id (covers items with no PR).
 * `scopeToRepo` repo-scopes the id-in-branch/cwd match for backends whose item
 * ids collide across repos (GitHub: it.project is the `owner/repo` slug, and
 * issue numbers are tiny). ADO ids are globally unique → unscoped.
 */
export function withSessions(index: SessionLookup, scopeToRepo: boolean, it: Omit<WorkItem, "sessions">): WorkItem {
  const seen = new Set<string>();
  const sessions: AgentSession[] = [];
  const add = (s: AgentSession) => {
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    sessions.push(s);
  };
  for (const pr of it.prs) {
    for (const s of index.forBranch(pr.branch)) add(s);
  }
  for (const s of index.forWorkItem(it.id, scopeToRepo ? it.project : null)) add(s);
  sessions.sort(byLastUsed);
  return { ...it, sessions };
}

/** A PR with the sessions on its branch, newest first. */
function withBranchSessions<P extends PullRequest>(index: SessionLookup, pr: P): P & { sessions: AgentSession[] } {
  return { ...pr, sessions: [...index.forBranch(pr.branch)].sort(byLastUsed) };
}

/**
 * PRs linked to a work item (PR view, upper section). Dedupe by PR id so a PR
 * shared across two items isn't listed twice, and hide finished PRs — the PR
 * view is about work still in flight.
 */
export function linkedPrsOf(index: SessionLookup, full: WorkItem[]): LinkedPR[] {
  const linked: LinkedPR[] = [];
  const seen = new Set<string>();
  for (const it of full) {
    for (const pr of it.prs) {
      if (pr.status === "completed" || pr.status === "abandoned" || seen.has(prKey(pr))) continue;
      seen.add(prKey(pr));
      linked.push({
        ...withBranchSessions(index, pr),
        workItemId: it.id, workItemType: it.type, workItemTitle: it.title, workItemUrl: it.url,
      });
    }
  }
  return linked;
}

/** The PRs already shown under a work item, by key; those are not "orphans". */
export function linkedPrKeys(full: WorkItem[]): Set<string> {
  return new Set(full.flatMap((i) => i.prs.map(prKey)));
}

/** The viewer's own active PRs that no work item shows, each with its sessions. */
export function orphanPrsOf(index: SessionLookup, activePRs: PullRequest[], linked: Set<string>): PRWithSessions[] {
  return activePRs.filter((pr) => !linked.has(prKey(pr))).map((pr) => withBranchSessions(index, pr));
}

/**
 * PRs awaiting the viewer's review (self or their teams). Drop any already
 * shown as a linked/created PR so each PR appears once across the view.
 */
export function reviewPrsOf(
  index: SessionLookup, reviewPRs: ReviewPR[], linked: Set<string>, created: PullRequest[],
): ReviewPRWithSessions[] {
  const createdKeys = new Set(created.map(prKey));
  return reviewPRs
    .filter((pr) => !linked.has(prKey(pr)) && !createdKeys.has(prKey(pr)))
    .map((pr) => withBranchSessions(index, pr));
}

/** The last segment of an ADO iteration path (`Team\\Sprint 12` → `Sprint 12`); null when there is none. */
export function iterationName(path: string | null): string | null {
  return path ? path.split("\\").pop() ?? path : null;
}

/**
 * First writer wins per field (`cur ?? patch`), so later, poorer sources only
 * fill gaps rather than clobbering a complete entry.
 */
function linkSession(links: Map<string, SessionLink>, s: AgentSession, patch: SessionLink): void {
  const key = `${s.source}:${s.id}`;
  const cur = links.get(key);
  links.set(key, {
    pr: cur?.pr ?? patch.pr,
    workItem: cur?.workItem ?? patch.workItem,
  });
}

/**
 * Reverse index for the Sessions view: which PR / work item each session links
 * to. Built from the already-resolved lists, richest source first, so a session
 * ends up with both its PR and work item when both are known.
 */
export function sessionLinksOf(linkedPrs: LinkedPR[], items: WorkItem[], prs: PRWithSessions[]): Map<string, SessionLink> {
  const links = new Map<string, SessionLink>();
  // 1) Linked PRs carry both a PR and its work item — the richest source.
  for (const pr of linkedPrs) {
    for (const s of pr.sessions) {
      linkSession(links, s, { pr: { id: pr.id, url: pr.url }, workItem: { id: pr.workItemId, url: pr.workItemUrl } });
    }
  }
  // 2) Work items fill in the WI for sessions matched by branch/worktree id
  //    alone (an item with no PR), plus PR-linked items not assigned to me.
  for (const it of items) {
    for (const s of it.sessions) linkSession(links, s, { workItem: { id: it.id, url: it.url } });
  }
  // 3) Orphan / review PRs fill in the PR for sessions whose PR isn't WI-linked.
  for (const pr of prs) {
    for (const s of pr.sessions) linkSession(links, s, { pr: { id: pr.id, url: pr.url } });
  }
  return links;
}
