// The pure middle of fetchWorkItemsForPRs (src/ado/prWorkItems.ts): which WIs
// a set of orphan PRs surface, how their PRs are merged in, and which PRs
// count as surfaced. The e2e ADO fixture links each PR to at most one WI and
// never has a WI both assigned and PR-linked, a PR whose WI the batch could
// not fetch, or a WI whose PR was already resolved from the other direction —
// so the exclusion, the dedupe and the not-surfaced verdict were unreached.
import { describe, expect, test } from "bun:test";
import { attachSurfacingPrs, groupPrsByWorkItem, surfacedPrIdsOf } from "../src/ado/prWorkItems.ts";
import type { PullRequest, WorkItem } from "../src/types.ts";

const pr = (id: number) => ({ id, repositoryId: "r" }) as PullRequest;
const item = (id: number, ...prs: PullRequest[]) => ({ id, prs }) as unknown as Omit<WorkItem, "sessions">;
const [p1, p2, p3] = [pr(1), pr(2), pr(3)];

describe("groupPrsByWorkItem", () => {
  test("inverts PR→WIs, keeps every PR under a shared WI, and drops WIs already loaded", () => {
    const prToWis = new Map([[1, [10, 20]], [2, [10]]]);
    const got = groupPrsByWorkItem([p1, p2, p3], prToWis, new Set([20]));
    expect([...got.entries()]).toEqual([[10, [p1, p2]]]);
  });

  test("a PR with no WIs surfaces nothing", () => {
    expect(groupPrsByWorkItem([p1], new Map(), new Set()).size).toBe(0);
  });
});

describe("attachSurfacingPrs", () => {
  test("adds each surfacing PR once, after any the item already had", () => {
    const items = [item(10, p1), item(30)];
    attachSurfacingPrs(items, new Map([[10, [p1, p2]], [40, [p3]]]));
    expect(items[0]!.prs).toEqual([p1, p2]);
    expect(items[1]!.prs).toEqual([]);
  });
});

describe("surfacedPrIdsOf", () => {
  test("only the PRs under a WI that was actually fetched", () => {
    const got = surfacedPrIdsOf([item(10)], new Map([[10, [p1, p2]], [40, [p3]]]));
    expect([...got].sort()).toEqual([1, 2]);
    expect(surfacedPrIdsOf([], new Map([[10, [p1]]])).size).toBe(0);
  });
});
