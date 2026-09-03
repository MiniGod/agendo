// Creating a fresh session's worktree (src/worktree.ts `createWorktree`). The
// e2e suite does this against a fixture clone where origin/HEAD resolves and
// the new branch never exists yet, so under measurement only the first `git
// worktree add` ever ran. What it never sees: no remote HEAD to base on, the
// branch already existing (checked out on the retry), and both attempts
// failing with the first real message kept. Those run here against a scripted
// git, the same way checkoutWorktree's do.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, worktreePath, type GitRun } from "../src/worktree.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agendo-wtc-"));

/** A git whose origin/HEAD is `base` (none when null) and whose `worktree add` succeeds on the `succeedAt`-th try. */
function scripted(base: string | null, succeedAt: number, stderrs: string[] = []): { run: GitRun; calls: string[][] } {
  const calls: string[][] = [];
  let adds = 0;
  const run: GitRun = (args) => {
    calls.push(args);
    if (args[0] === "symbolic-ref") {
      return base === null ? { status: 128, stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref", stdout: "" } : { status: 0, stderr: "", stdout: `${base}\n` };
    }
    adds++;
    const stderr = adds - 1 < stderrs.length ? stderrs[adds - 1] : `fail ${adds}`;
    return adds === succeedAt ? { status: 0, stderr: "" } : { status: 128, stderr };
  };
  return { run, calls };
}

describe("createWorktree", () => {
  test("a worktree already there is reused, and git is not even asked", () => {
    mkdirSync(worktreePath(root, "have"), { recursive: true });
    const g = scripted("origin/main", 1);
    expect(createWorktree(root, "have", g.run)).toEqual({ path: worktreePath(root, "have"), created: false });
    expect(g.calls).toEqual([]);
  });

  test("a new branch off the remote default, or off HEAD when the remote has none", () => {
    const g = scripted("origin/main", 1);
    const path = worktreePath(root, "feat/a");
    expect(createWorktree(root, "feat/a", g.run)).toEqual({ path, created: true });
    expect(g.calls).toEqual([
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      ["worktree", "add", "-b", "feat/a", path, "origin/main"],
    ]);
    const bare = scripted(null, 1);
    createWorktree(root, "feat/a2", bare.run);
    expect(bare.calls.at(-1)).toEqual(["worktree", "add", "-b", "feat/a2", worktreePath(root, "feat/a2"), "HEAD"]);
  });

  test("a branch that already exists is checked out on the retry", () => {
    const g = scripted("origin/main", 2);
    const path = worktreePath(root, "feat/b");
    expect(createWorktree(root, "feat/b", g.run)).toEqual({ path, created: true });
    expect(g.calls.slice(1)).toEqual([
      ["worktree", "add", "-b", "feat/b", path, "origin/main"],
      ["worktree", "add", path, "feat/b"],
    ]);
  });

  test("both failing keeps the first message, skipping a blank one; none at all is a generic line", () => {
    const path = worktreePath(root, "feat/c");
    expect(createWorktree(root, "feat/c", scripted("origin/main", 3, ["fatal: first", "fatal: second"]).run))
      .toEqual({ path, created: false, error: "fatal: first" });
    expect(createWorktree(root, "feat/c", scripted("origin/main", 3, ["  ", "fatal: second"]).run).error).toBe("fatal: second");
    expect(createWorktree(root, "feat/c", scripted("origin/main", 3, ["", ""]).run).error).toBe("git worktree add failed");
  });
});
