// What a PR / work-item NUMBER resolves to for `agendo focus`, and the link
// throttle's arithmetic. A number is not always one entity — GitHub numbers per
// repository — and the e2e fixtures never collide, so the refusal lives here.
import { afterAll, describe, expect, test } from "bun:test";
import { linkedMatches, narrowToRepo, resolveLinked } from "../src/cli/focus/linked.ts";
import { claimFloor, resumeWaitMs, STALE_LOCK_MS, URL_RESUME_GAP_MS } from "../src/cli/focus/throttle.ts";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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

describe("narrowToRepo", () => {
  test("keeps only the sessions in the repo, so two repos' PR #5 stop being ambiguous", () => {
    const a = { ...sess("a"), cwd: "/w/repo-a" } as AgentSession;
    const b = { ...sess("b"), cwd: "/w/repo-b" } as AgentSession;
    const matches = [{ key: "repo-a/5", sessions: [a] }, { key: "repo-b/5", sessions: [b] }];
    expect(resolveLinked(matches)).toEqual({ ambiguous: ["repo-a/5", "repo-b/5"] });
    expect(resolveLinked(narrowToRepo(matches, (s) => s.cwd === "/w/repo-b"))).toEqual({ sessions: [b] });
    expect(resolveLinked(narrowToRepo(matches, () => false))).toEqual({ sessions: [] });
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

describe("claimFloor", () => {
  const T0 = 1_800_000_000_000;
  const GO = { go: true } as const;
  const made: string[] = [];
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), "agendo-floor-"));
    made.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of made) rmSync(dir, { recursive: true, force: true });
  });
  const waitOf = (c: ReturnType<typeof claimFloor>) => ("waitMs" in c ? c.waitMs : null);

  test("the first claim goes and stamps; a second inside the gap waits it out; after it, goes again", () => {
    const dir = fresh();
    expect(claimFloor("f", 10_000, T0, dir)).toEqual(GO);
    expect(existsSync(join(dir, "f.stamp"))).toBe(true);
    // The stamp's mtime is the real clock's, so ask relative to it.
    const stamped = Date.now();
    expect(waitOf(claimFloor("f", 10_000, stamped + 4_000, dir))).toBeGreaterThan(5_000);
    expect(claimFloor("f", 10_000, stamped + 60_000, dir)).toEqual(GO);
  });

  test("the lock is released after every claim", () => {
    const dir = fresh();
    claimFloor("f", 10_000, T0, dir);
    claimFloor("f", 10_000, T0, dir);
    expect(existsSync(join(dir, "f.lock"))).toBe(false);
  });

  test("a held lock waits: a concurrent claim is the burst the floor is for", () => {
    const dir = fresh();
    mkdirSync(join(dir, "f.lock"));
    expect(claimFloor("f", 10_000, Date.now(), dir)).toEqual({ waitMs: 10_000 });
    expect(existsSync(join(dir, "f.lock"))).toBe(true);
    expect(existsSync(join(dir, "f.stamp"))).toBe(false);
  });

  test("a stale lock is cleared, but only the NEXT claim may take it", () => {
    const dir = fresh();
    const lockDir = join(dir, "f.lock");
    mkdirSync(lockDir);
    const old = (Date.now() - STALE_LOCK_MS - 60_000) / 1000;
    utimesSync(lockDir, old, old);
    expect(claimFloor("f", 10_000, Date.now(), dir)).toEqual({ waitMs: 10_000 });
    expect(existsSync(lockDir)).toBe(false);
    expect(claimFloor("f", 10_000, Date.now(), dir)).toEqual(GO);
  });

  test.skipIf(process.getuid?.() === 0)("a directory it cannot write is an error, not a wait", () => {
    const dir = fresh();
    chmodSync(dir, 0o500);
    try {
      expect("error" in claimFloor("f", 10_000, Date.now(), dir)).toBe(true);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test.skipIf(process.getuid?.() === 0)("a stamp it cannot write is an error too", () => {
    const dir = fresh();
    // A directory where the stamp goes, old enough that the floor has passed: the write is what fails.
    mkdirSync(join(dir, "f.stamp"));
    utimesSync(join(dir, "f.stamp"), 1, 1);
    expect("error" in claimFloor("f", 10_000, Date.now(), dir)).toBe(true);
    expect(existsSync(join(dir, "f.lock"))).toBe(false);
  });

  test("a FILE where the state dir should be is an error, not a held lock", () => {
    const dir = join(fresh(), "file");
    writeFileSync(dir, "");
    expect("error" in claimFloor("f", 10_000, Date.now(), dir)).toBe(true);
  });

  test("floors are independent by name", () => {
    const dir = fresh();
    expect(claimFloor("a", 10_000, Date.now(), dir)).toEqual(GO);
    expect(claimFloor("b", 10_000, Date.now(), dir)).toEqual(GO);
  });
});
