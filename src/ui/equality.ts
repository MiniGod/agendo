import type { RepoInfo } from "../repos.ts";
import type { Activity } from "./format.ts";
import type { ActionLine, RepoSessions, TaskItem } from "../types.ts";
import type { LiveTarget } from "../tmux.ts";

// Cheap structural equality check to skip re-renders when the log hasn't changed.
// "loading"/"error"/undefined are never equal so any state transition always fires.
function sameTask(a: TaskItem, b: TaskItem): boolean {
  return a.label === b.label && a.status === b.status;
}

/** Same checklist, item for item; an absent list is an empty one. */
function sameTasks(a: TaskItem[] | undefined, b: TaskItem[] | undefined): boolean {
  const xs = a ?? [];
  const ys = b ?? [];
  return xs.length === ys.length && xs.every((x, i) => sameTask(x, ys[i]));
}

/** Two actions are the same when they happened at the same instant and say the same thing. */
function sameAction(a: ActionLine, b: ActionLine): boolean {
  return a.timestamp.getTime() === b.timestamp.getTime() && a.verb === b.verb && a.detail === b.detail;
}

/**
 * Compare both ends of the (capped) rolling window: when the list is pinned at
 * ACTIVITY_LIMIT, new appends shift the head off even if the tail looks stable,
 * so checking only the last action could miss a change and freeze the display.
 */
function sameActionWindow(a: ActionLine[], b: ActionLine[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  return sameAction(a[0], b[0]) && sameAction(a[a.length - 1], b[b.length - 1]);
}

export function sameActivity(a: Activity | undefined, b: Activity | undefined): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a.lastPrompt !== b.lastPrompt) return false;
  return sameTasks(a.tasks, b.tasks) && sameActionWindow(a.actions, b.actions);
}

// Set equality, order-independent: same size + every member of `a` is in `b`.
// Gates the liveness poll's setState so an unchanged tmux state is a no-op.
export function sameLiveTmux(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Map equality on BOTH halves of each live target — a window that moved host keeps
// its name and changes only the target addressing it. Gates the rescan's setModel.
export function sameLiveWindows(a: Map<string, LiveTarget>, b: Map<string, LiveTarget>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k)?.name !== v.name || b.get(k)?.target !== v.target) return false;
  return true;
}

// The set of session identities (source:id) present across all repo groups, as a
// stable signature. Used to detect that a session appeared/vanished between
// rescans — the trigger for refreshing the (network-free) local half of the model.
export function sessionGroupsSig(groups: RepoSessions[]): string {
  const ids: string[] = [];
  for (const g of groups) for (const s of g.sessions) ids.push(`${s.source}:${s.id}`);
  return ids.sort().join(",");
}

// Repo-list equality by root (order-sensitive; discoverRepos is deterministically
// ordered), so a changed repo set for the fresh-session picker triggers a refresh.
export function sameRepos(a: RepoInfo[], b: RepoInfo[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].root !== b[i].root) return false;
  return true;
}
