import type { RepoInfo } from "../repos.ts";
import type { Activity } from "./format.ts";
import type { RepoSessions, TaskItem } from "../types.ts";

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

export function sameActivity(a: Activity | undefined, b: Activity | undefined): boolean {
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
export function sameLiveTmux(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// Map equality (same keys → same values). Gates the rescan's setModel on the
// live-window map, whose changes drive the readiness/auto-resume effect.
export function sameLiveWindows(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
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
