import { describe, expect, test } from "bun:test";
import {
  ACTIVE_MS, activityPathsOf, buildCleanupRows, claudeProjectSlug, managedWorktreeOf, othersRunningIn, sharedActivityPaths, runStateOf, sessionRepoRoot, tmpDirOf, transcriptPathsOf,
} from "../src/cleanup/rows.ts";
import { sessionName } from "../src/runtime/tmux/names.ts";
import type { AgentSession } from "../src/shared/types.ts";

const s = (id: string, cwd: string, over: Partial<AgentSession> = {}): AgentSession =>
  ({ id, source: "claude", cwd, title: `title ${id}`, lastUsed: new Date(2000), logPath: `/c/projects/p/${id}.jsonl`, ...over }) as AgentSession;

describe("managedWorktreeOf", () => {
  test("a worktree path, or a directory inside one", () => {
    expect(managedWorktreeOf("/r/.claude/worktrees/x")).toEqual({ repoRoot: "/r", worktree: "/r/.claude/worktrees/x" });
    expect(managedWorktreeOf("/r/.claude/worktrees/x/src/deep/")).toEqual({ repoRoot: "/r", worktree: "/r/.claude/worktrees/x" });
  });
  test("anything else is not one", () => {
    expect(managedWorktreeOf("/r")).toBeNull();
    expect(managedWorktreeOf("/r/.claude/worktrees")).toBeNull();
    expect(managedWorktreeOf("/r/.claude/worktrees/..")).toBeNull();
    expect(managedWorktreeOf("/r/worktrees/x")).toBeNull();
  });
  test("sessionRepoRoot prefers the worktree's repo, else walks up", () => {
    expect(sessionRepoRoot("/r/.claude/worktrees/x", () => "/nope")).toBe("/r");
    expect(sessionRepoRoot("/r/sub", () => "/r")).toBe("/r");
  });
});

describe("buildCleanupRows", () => {
  const running = s("run1", "/r/.claude/worktrees/a");
  const paused = s("pau1", "/r/.claude/worktrees/a/sub", { createdAt: new Date(1000), branch: "worktree-a" });
  const plain = s("pln1", "/r/sub");
  const rows = buildCleanupRows({
    sessions: [running, paused, plain],
    live: new Set([sessionName(running)]),
    placeholders: new Set([sessionName(paused)]),
    worktrees: [
      { path: "/r/.claude/worktrees/a", repoRoot: "/r", mtime: new Date(5), birthtime: new Date(3) },
      { path: "/r/.claude/worktrees/orphan", repoRoot: "/r", mtime: new Date(5), birthtime: new Date(0) },
    ],
    repoRootOf: () => "/r",
  });

  test("one row per session, with its run state, worktree and times", () => {
    expect(rows.map((r) => [r.key, r.run, r.worktree, r.path])).toEqual([
      ["session:claude:run1", "running", "/r/.claude/worktrees/a", "/r/.claude/worktrees/a"],
      ["session:claude:pau1", "paused", "/r/.claude/worktrees/a", "/r/.claude/worktrees/a"],
      ["session:claude:pln1", "idle", null, "/r/sub"],
      ["worktree:/r/.claude/worktrees/orphan", "idle", "/r/.claude/worktrees/orphan", "/r/.claude/worktrees/orphan"],
    ]);
    expect(rows[1].created.getTime()).toBe(1000);
    expect(rows[1].branchHint).toBe("worktree-a");
    expect(rows[0].created.getTime()).toBe(2000); // no createdAt: falls back to lastUsed
  });

  test("a worktree-only row has no session, and falls back to mtime when birthtime is unknown", () => {
    const orphan = rows[3];
    expect(orphan.session).toBeNull();
    expect(orphan.title).toBe("orphan");
    expect(orphan.created.getTime()).toBe(5);
  });

  test("othersRunningIn sees a running sibling in the same worktree, and nothing for unmanaged rows", () => {
    expect(othersRunningIn(rows[1], rows)).toBe(true);
    expect(othersRunningIn(rows[0], rows)).toBe(false);
    expect(othersRunningIn(rows[2], rows)).toBe(false);
  });

  test("a session not running here that was written to in the last few minutes is active; a live one never is", () => {
    const now = 2000 + ACTIVE_MS - 1;
    const input = { live: new Set([sessionName(running)]), placeholders: new Set([sessionName(paused)]), worktrees: [], repoRootOf: () => "/r" };
    expect(buildCleanupRows({ ...input, sessions: [running, paused, plain], now }).map((r) => r.active)).toEqual([false, true, true]);
    expect(buildCleanupRows({ ...input, sessions: [plain], now: now + 1 })[0].active).toBe(false);
    expect(rows[2].active).toBe(false); // no clock, no guess
  });

  test("activity is shared through the worktree: a fresh session there makes its idle neighbour active, not a running one", () => {
    const now = 1_000_000;
    const old = s("old1", "/r/.claude/worktrees/a", { lastUsed: new Date(0) });
    const fresh = s("new1", "/r/.claude/worktrees/a/src", { lastUsed: new Date(now) });
    const live = s("liv1", "/r/.claude/worktrees/a", { lastUsed: new Date(0) });
    const elsewhere = s("els1", "/r/.claude/worktrees/b", { lastUsed: new Date(0) });
    const input = { live: new Set([sessionName(live)]), placeholders: new Set<string>(), worktrees: [], repoRootOf: () => "/r", now };
    const built = buildCleanupRows({ ...input, sessions: [old, fresh, live, elsewhere] });
    expect(built.map((r) => r.active)).toEqual([true, true, false, false]);
    expect(sharedActivityPaths(built[0], built)).toEqual(["/c/projects/p/new1.jsonl", "/c/projects/p/liv1.jsonl"]);
    expect(sharedActivityPaths(built[3], built)).toEqual([]);
    expect(sharedActivityPaths({ ...built[0], worktree: null }, built)).toEqual([]);
  });

  test("a worktree a session outside the launch scope lives in is not offered as an orphan", () => {
    const at = (path: string) => ({ path, repoRoot: "/r", mtime: new Date(5), birthtime: new Date(0) });
    const built = buildCleanupRows({
      sessions: [], live: new Set(), placeholders: new Set(), repoRootOf: () => "/r",
      worktrees: [at("/r/.claude/worktrees/w2"), at("/r/.claude/worktrees/w3")],
      claimers: [s("out1", "/r/.claude/worktrees/w2/src")],
    });
    expect(built.map((r) => r.key)).toEqual(["worktree:/r/.claude/worktrees/w3"]);
  });

  test("one checkout listed under two spellings is one row", () => {
    const at = (path: string) => ({ path, repoRoot: "/r", mtime: new Date(5), birthtime: new Date(0) });
    const built = buildCleanupRows({
      sessions: [], live: new Set(), placeholders: new Set(), repoRootOf: () => "/r",
      worktrees: [at("/link/.claude/worktrees/x"), at("/r/.claude/worktrees/x")],
      canon: (p) => p.replace(/^\/link/, "/r"),
    });
    expect(built.map((r) => r.key)).toEqual(["worktree:/r/.claude/worktrees/x"]);
  });

  test("a worktree-only row is active when its directory changed moments ago", () => {
    const wt = (mtime: number) => ({ path: "/r/.claude/worktrees/new", repoRoot: "/r", mtime: new Date(mtime), birthtime: new Date(0) });
    const base = { sessions: [], live: new Set<string>(), placeholders: new Set<string>(), repoRootOf: () => "/r" };
    expect(buildCleanupRows({ ...base, worktrees: [wt(1000)], now: 1000 + ACTIVE_MS - 1 })[0].active).toBe(true);
    expect(buildCleanupRows({ ...base, worktrees: [wt(1000)], now: 1000 + ACTIVE_MS })[0].active).toBe(false);
  });

  test("a session and a worktree that differ only by a symlink are one place", () => {
    const canon = (p: string) => p.replace(/^\/link/, "/r");
    const rows2 = buildCleanupRows({
      sessions: [s("sym1", "/link/.claude/worktrees/a")],
      live: new Set(),
      placeholders: new Set(),
      worktrees: [{ path: "/r/.claude/worktrees/a", repoRoot: "/r", mtime: new Date(5), birthtime: new Date(3) }],
      repoRootOf: () => "/r",
      canon,
    });
    expect(rows2.map((r) => [r.key, r.worktree, r.repoRoot])).toEqual([["session:claude:sym1", "/r/.claude/worktrees/a", "/r"]]);
  });

  test("a live pane inside the worktree counts as running there, even for a session the model doesn't know", () => {
    expect(othersRunningIn(rows[0], rows, ["/r/.claude/worktrees/a/src"])).toBe(true);
    expect(othersRunningIn(rows[0], rows, ["/r/.claude/worktrees/a"])).toBe(true);
    expect(othersRunningIn(rows[0], rows, ["/r/.claude/worktrees/ab"])).toBe(false);
    expect(othersRunningIn(rows[2], rows, ["/r/sub"])).toBe(false); // not a managed worktree
  });

  test("a nested managed worktree is attributed to the innermost one", () => {
    expect(managedWorktreeOf("/r/.claude/worktrees/x/.claude/worktrees/y/src")).toEqual({
      repoRoot: "/r/.claude/worktrees/x",
      worktree: "/r/.claude/worktrees/x/.claude/worktrees/y",
    });
  });

  test("activity is read from the transcript, and from copilot's events.jsonl inside its session dir", () => {
    expect(activityPathsOf(s("c1", "/x"))).toEqual(["/c/projects/p/c1.jsonl"]);
    expect(activityPathsOf(s("cp", "/x", { source: "copilot", logPath: "/s/cp" }))).toEqual(["/s/cp", "/s/cp/events.jsonl"]);
    expect(activityPathsOf(s("n", "/x", { logPath: undefined }))).toEqual([]);
  });

  test("lastWrite, when given, beats lastUsed for activity", () => {
    const now = 2000 + ACTIVE_MS * 2;
    const base = { live: new Set<string>(), placeholders: new Set<string>(), worktrees: [], repoRootOf: () => "/r", now };
    expect(buildCleanupRows({ ...base, sessions: [plain] })[0].active).toBe(false);
    expect(buildCleanupRows({ ...base, sessions: [plain], lastWrite: () => new Date(now - 1) })[0].active).toBe(true);
  });

  test("a session with no title shows its id", () => {
    expect(runStateOf(plain, new Set(), new Set())).toBe("idle");
    const [r] = buildCleanupRows({ sessions: [s("id9", "/x", { title: "" })], live: new Set(), placeholders: new Set(), worktrees: [], repoRootOf: () => "/x" });
    expect(r.title).toBe("id9");
  });
});

describe("a session's files", () => {
  test("claude: the log and its sibling dir; others: the log alone", () => {
    expect(transcriptPathsOf(s("abc", "/w"))).toEqual(["/c/projects/p/abc.jsonl", "/c/projects/p/abc"]);
    expect(transcriptPathsOf(s("abc", "/w", { source: "copilot", logPath: "/h/.copilot/session-state/abc" }))).toEqual(["/h/.copilot/session-state/abc"]);
    expect(transcriptPathsOf(s("abc", "/w", { source: "codex", logPath: "/h/rollout-1-abc.jsonl" }))).toEqual(["/h/rollout-1-abc.jsonl"]);
  });

  test("nothing when the log is not the session's own, or the id is not an identifier", () => {
    expect(transcriptPathsOf(s("abc", "/w", { logPath: "/c/other.jsonl" }))).toEqual([]);
    expect(transcriptPathsOf(s("abc", "/w", { logPath: undefined }))).toEqual([]);
    expect(transcriptPathsOf(s("../x", "/w", { logPath: "/c/../x.jsonl" }))).toEqual([]);
  });

  test("the scratch dir follows Claude Code's layout", () => {
    expect(claudeProjectSlug("/home/u/git/a/.claude/worktrees/b")).toBe("-home-u-git-a--claude-worktrees-b");
    expect(tmpDirOf(s("abc", "/w/x"), "/tmp", 1000)).toBe("/tmp/claude-1000/-w-x/abc");
    expect(tmpDirOf(s("abc", "/w", { source: "codex" }), "/tmp", 1000)).toBeNull();
    expect(tmpDirOf(s("a/b", "/w"), "/tmp", 1000)).toBeNull();
  });
});
