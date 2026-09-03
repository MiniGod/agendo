// The joins loadModel makes (src/model/join.ts). The e2e fixtures load a model
// with one PR per item and one session per branch; they never share a PR
// between two items, never carry a finished PR, never put a session under both
// a linked PR and an orphan one, and never resolve an ADO iteration path with
// no backslash in it.
import { describe, expect, test } from "bun:test";
import type { AgentSession, LinkedPR, PullRequest, ReviewPR, WorkItem } from "../src/types.ts";
import {
  iterationName, linkedPrKeys, linkedPrsOf, orphanPrsOf, reviewPrsOf, sessionLinksOf, withSessions,
  type SessionLookup,
} from "../src/model/join.ts";

const session = (id: string, lastUsed: number, branch?: string): AgentSession =>
  ({ id, source: "claude", cwd: "/w", branch, title: id, lastUsed: new Date(lastUsed) }) as AgentSession;

const pr = (id: number, branch: string, status: PullRequest["status"] = "active"): PullRequest =>
  ({ id, title: `pr${id}`, status, branch, repositoryId: "r", isDraft: false, approvals: 0, rejections: 0, waiting: 0,
    approvedCount: 0, requiredCount: 0, ci: "none", createdDate: 0, updatedDate: 0, url: `u/pr/${id}` }) as PullRequest;

const item = (id: number, prs: PullRequest[], sessions: AgentSession[] = []): WorkItem => ({
  id, type: "Task", title: `wi${id}`, state: "Active", iterationPath: "T\\S1", project: "o/r",
  inCurrentSprint: true, prs, sessions, url: `u/wi/${id}`,
});

/** A stand-in index: sessions by branch, and by the work-item id in their branch. */
function lookup(sessions: AgentSession[], byItem: Record<number, AgentSession[]> = {}): SessionLookup & { itemCalls: (string | null | undefined)[] } {
  const itemCalls: (string | null | undefined)[] = [];
  return {
    itemCalls,
    forBranch: (branch) => sessions.filter((s) => s.branch === branch),
    forWorkItem: (id, repo) => {
      itemCalls.push(repo);
      return byItem[id] ?? [];
    },
  };
}

describe("withSessions", () => {
  test("collects by PR branch and by item id, once each, newest first", () => {
    const a = session("a", 1, "feat/1");
    const b = session("b", 3, "feat/1b");
    const c = session("c", 2);
    const index = lookup([a, b], { 7: [a, c] });
    const wi = withSessions(index, false, item(7, [pr(1, "feat/1"), pr(2, "feat/1b")]));
    expect(wi.sessions.map((s) => s.id)).toEqual(["b", "c", "a"]);
    expect(index.itemCalls).toEqual([null]);
  });

  test("scopes the id match to the item's repo only when asked", () => {
    const index = lookup([]);
    withSessions(index, true, item(7, []));
    expect(index.itemCalls).toEqual(["o/r"]);
  });
});

describe("linkedPrsOf and the orphans", () => {
  const shared = pr(1, "feat/1");
  const done = pr(2, "feat/2", "completed");
  const gone = pr(3, "feat/3", "abandoned");
  const own = pr(4, "feat/4");
  const s4 = session("s4", 5, "feat/4");
  const s1 = session("s1", 1, "feat/1");
  const full = [item(10, [shared, done]), item(11, [shared, gone])];

  test("a PR under two items is listed once, under the first, and finished PRs are hidden", () => {
    const linked = linkedPrsOf(lookup([s1]), full);
    expect(linked.map((p) => [p.id, p.workItemId, p.workItemTitle])).toEqual([[1, 10, "wi10"]]);
    expect(linked[0].sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  test("finished PRs still count as shown, so they are not orphans either", () => {
    const keys = linkedPrKeys(full);
    expect([...keys].sort()).toEqual(["r:1", "r:2", "r:3"]);
    const orphans = orphanPrsOf(lookup([s4]), [shared, done, own], keys);
    expect(orphans.map((p) => p.id)).toEqual([4]);
    expect(orphans[0].sessions.map((s) => s.id)).toEqual(["s4"]);
  });

  test("review PRs drop what a work item or the viewer's own list already shows", () => {
    const review = (p: PullRequest): ReviewPR => ({ ...p, reviewReason: "you" });
    const mine = pr(5, "feat/5");
    const theirs = pr(6, "feat/6");
    const got = reviewPrsOf(lookup([]), [review(shared), review(mine), review(theirs)], linkedPrKeys(full), [mine]);
    expect(got.map((p) => p.id)).toEqual([6]);
    expect(got[0].reviewReason).toBe("you");
  });
});

describe("sessionLinksOf", () => {
  const s = session("s", 1, "feat/1");
  const linked: LinkedPR = { ...pr(1, "feat/1"), sessions: [s], workItemId: 10, workItemType: "Task", workItemTitle: "wi10", workItemUrl: "u/wi/10" };

  test("the richest source wins per field; poorer ones only fill gaps", () => {
    const orphan = { ...pr(2, "feat/1"), sessions: [s] };
    const links = sessionLinksOf([linked], [item(11, [], [s])], [orphan]);
    expect(links.get("claude:s")).toEqual({ pr: { id: 1, url: "u/pr/1" }, workItem: { id: 10, url: "u/wi/10" } });
  });

  test("a session known only to an item, and one only to a PR, get that half alone", () => {
    const t = session("t", 1);
    const u = session("u", 1, "feat/9");
    const links = sessionLinksOf([], [item(12, [], [t])], [{ ...pr(9, "feat/9"), sessions: [u] }]);
    expect(links.get("claude:t")).toEqual({ pr: undefined, workItem: { id: 12, url: "u/wi/12" } });
    expect(links.get("claude:u")).toEqual({ pr: { id: 9, url: "u/pr/9" }, workItem: undefined });
  });
});

describe("iterationName", () => {
  test("is the last path segment, the whole path without one, and null for none", () => {
    expect(iterationName("Team\\Sprint 12")).toBe("Sprint 12");
    expect(iterationName("Sprint 12")).toBe("Sprint 12");
    expect(iterationName(null)).toBeNull();
  });
});
