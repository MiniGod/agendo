// What a PR / work-item NUMBER resolves to for `agendo focus`, and the link
// throttle's arithmetic. A number is not always one entity — GitHub numbers per
// repository — and the e2e fixtures never collide, so the refusal lives here.
import { describe, expect, test } from "bun:test";
import { linkedMatches, resolveLinked } from "../src/cli/focus/linked.ts";
import { resumeWaitMs, URL_RESUME_GAP_MS } from "../src/cli/focus/throttle.ts";
import type { AgentSession } from "../src/shared/types.ts";

const sess = (id: string, source = "claude") => ({ id, source }) as AgentSession;

describe("resolveLinked", () => {
  test("no match, or matches without sessions, is an empty answer", () => {
    expect(resolveLinked([])).toEqual({ sessions: [] });
    expect(resolveLinked([{ key: "a", sessions: [] }, { key: "b", sessions: [] }])).toEqual({ sessions: [] });
  });

  test("one entity listed twice is one entity, its sessions deduped", () => {
    const a = sess("a");
    const got = resolveLinked([{ key: "u/1", sessions: [a, sess("b")] }, { key: "u/1", sessions: [a] }]);
    expect(got).toEqual({ sessions: [a, sess("b")] });
  });

  test("the same id under two sources is two sessions", () => {
    const got = resolveLinked([{ key: "u/1", sessions: [sess("x", "claude"), sess("x", "codex")] }]);
    expect("sessions" in got && got.sessions.length).toBe(2);
  });

  test("two different entities with sessions is ambiguous, not a choice", () => {
    const got = resolveLinked([{ key: "repo-a/5", sessions: [sess("a")] }, { key: "repo-b/5", sessions: [sess("b")] }]);
    expect(got).toEqual({ ambiguous: ["repo-a/5", "repo-b/5"] });
  });

  test("a second entity WITHOUT sessions does not make it ambiguous", () => {
    const got = resolveLinked([{ key: "repo-a/5", sessions: [sess("a")] }, { key: "repo-b/5", sessions: [] }]);
    expect(got).toEqual({ sessions: [sess("a")] });
  });
});

describe("linkedMatches", () => {
  const pr = (id: number, url: string, repositoryId: string, sessions: AgentSession[]) => ({ id, url, repositoryId, sessions });
  const item = (id: number, url: string, sessions: AgentSession[]) => ({ id, url, sessions });
  const model = {
    linkedPrs: [pr(5, "https://x/a/pull/5", "a", [sess("1")])],
    orphanPrs: [pr(5, "", "b", [sess("2")]), pr(6, "https://x/a/pull/6", "a", [])],
    reviewPrs: [pr(5, "https://x/a/pull/5", "a", [sess("1")])],
    current: [item(5, "https://x/a/issues/5", [sess("3")])],
    other: [],
    prLinked: [item(7, "", [sess("4")])],
  } as unknown as Parameters<typeof linkedMatches>[0];

  test("PRs by number across all three lists, keyed by url or repository", () => {
    expect(linkedMatches(model, { kind: "pr", id: 5 }).map((m) => m.key)).toEqual([
      "https://x/a/pull/5",
      "repo:b",
      "https://x/a/pull/5",
    ]);
  });

  test("work items by number, never PRs of the same number", () => {
    expect(linkedMatches(model, { kind: "workItem", id: 5 }).map((m) => m.key)).toEqual(["https://x/a/issues/5"]);
    expect(linkedMatches(model, { kind: "workItem", id: 7 }).map((m) => m.key)).toEqual(["item:7"]);
  });
});

describe("resumeWaitMs", () => {
  test("never resumed, or a stamp from the future, waits nothing", () => {
    expect(resumeWaitMs(null, 1_000)).toBe(0);
    expect(resumeWaitMs(5_000, 1_000)).toBe(0);
  });

  test("inside the gap waits out the rest of it; past it waits nothing", () => {
    expect(resumeWaitMs(10_000, 10_000)).toBe(URL_RESUME_GAP_MS);
    expect(resumeWaitMs(10_000, 14_000, 5_000)).toBe(1_000);
    expect(resumeWaitMs(10_000, 15_000, 5_000)).toBe(0);
  });
});
