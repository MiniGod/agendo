// Checking a PR branch out into a worktree (src/worktree.ts). The e2e suite
// does this against a fixture repo where the first attempt — a new local
// branch tracking the remote — always succeeds. What it never sees is that
// attempt failing: the local branch that already exists, the detached fallback
// when even that is gone, and all three failing with the first real message
// kept. Those run here against a scripted git.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkoutWorktree, worktreePath, type GitRun } from "../src/worktree.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agendo-wt-"));

/** A git whose `worktree add` calls succeed on the `succeedAt`-th try (1-based), with a stderr per failure. */
function scripted(succeedAt: number, stderrs: (string | null)[] = []): { run: GitRun; calls: string[][] } {
  const calls: string[][] = [];
  let adds = 0;
  const run: GitRun = (args) => {
    calls.push(args);
    if (args[0] !== "worktree") return { status: 0, stderr: "" };
    adds++;
    const stderr = adds - 1 < stderrs.length ? stderrs[adds - 1]! : `fail ${adds}`;
    return adds === succeedAt ? { status: 0, stderr: "" } : { status: 128, stderr };
  };
  return { run, calls };
}

describe("checkoutWorktree", () => {
  test("a worktree already there is reused, and git is not even asked", () => {
    mkdirSync(worktreePath(root, "have"), { recursive: true });
    const g = scripted(1);
    expect(checkoutWorktree(root, "have", g.run)).toEqual({ path: worktreePath(root, "have"), created: false });
    expect(g.calls).toEqual([]);
  });

  test("fetch first, then a tracking branch: the common case stops at the first attempt", () => {
    const g = scripted(1);
    const path = worktreePath(root, "feat/a");
    expect(checkoutWorktree(root, "feat/a", g.run)).toEqual({ path, created: true });
    expect(g.calls).toEqual([
      ["fetch", "origin", "feat/a"],
      ["worktree", "add", "--track", "-b", "feat/a", path, "origin/feat/a"],
    ]);
  });

  test("the local branch that already exists is checked out on the second attempt; the remote ref, detached, on the third", () => {
    const second = scripted(2);
    const path = worktreePath(root, "feat/b");
    expect(checkoutWorktree(root, "feat/b", second.run).created).toBe(true);
    expect(second.calls.slice(1)).toEqual([
      ["worktree", "add", "--track", "-b", "feat/b", path, "origin/feat/b"],
      ["worktree", "add", path, "feat/b"],
    ]);
    const third = scripted(3);
    expect(checkoutWorktree(root, "feat/b", third.run).created).toBe(true);
    expect(third.calls.at(-1)).toEqual(["worktree", "add", "--detach", path, "origin/feat/b"]);
  });

  test("all three failing keeps the first attempt's message, skipping blank ones; none at all is a generic line", () => {
    const path = worktreePath(root, "feat/c");
    expect(checkoutWorktree(root, "feat/c", scripted(4, ["  fatal: a branch named 'feat/c' already exists  ", "x", "y"]).run)).toEqual({
      path, created: false, error: "fatal: a branch named 'feat/c' already exists",
    });
    expect(checkoutWorktree(root, "feat/c", scripted(4, ["", null, "fatal: invalid reference"]).run).error).toBe("fatal: invalid reference");
    expect(checkoutWorktree(root, "feat/c", scripted(4, ["", "", ""]).run).error).toBe("git worktree add failed");
  });
});
