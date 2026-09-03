import type { PullRequest, WorkItem } from "../types.ts";

type Item = Omit<WorkItem, "sessions">;

/**
 * WI → the PRs that link to it, from each PR's resolved WI ids. WIs already
 * loaded as assigned items are left out: they are not "surfaced" by a PR.
 */
export function groupPrsByWorkItem(
  prs: PullRequest[],
  prToWis: Map<number, number[]>,
  excludeWorkItemIds: Set<number>,
): Map<number, PullRequest[]> {
  const wiToPrs = new Map<number, PullRequest[]>();
  for (const pr of prs) {
    for (const wiId of prToWis.get(pr.id) ?? []) {
      if (excludeWorkItemIds.has(wiId)) continue;
      const arr = wiToPrs.get(wiId) ?? [];
      arr.push(pr);
      wiToPrs.set(wiId, arr);
    }
  }
  return wiToPrs;
}

/**
 * Union the surfacing PR(s) into each mapped WI's prs — deduped by id, since
 * mapRawWorkItem may have already resolved the link bidirectionally.
 */
export function attachSurfacingPrs(items: Item[], wiToPrs: Map<number, PullRequest[]>): void {
  for (const wi of items) {
    const have = new Set(wi.prs.map((p) => p.id));
    for (const pr of wiToPrs.get(wi.id) ?? []) if (!have.has(pr.id)) wi.prs.push(pr);
  }
}

/** Only PRs under a WI we actually fetched count as surfaced. */
export function surfacedPrIdsOf(items: Item[], wiToPrs: Map<number, PullRequest[]>): Set<number> {
  const mappedIds = new Set(items.map((w) => w.id));
  return new Set(
    [...wiToPrs.entries()]
      .filter(([wiId]) => mappedIds.has(wiId))
      .flatMap(([, prs]) => prs)
      .map((p) => p.id),
  );
}
