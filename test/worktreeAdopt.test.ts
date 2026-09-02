import { describe, expect, test } from "bun:test";
import { countDirty, parseWorktreeList } from "../src/worktreeAdopt.ts";

// The porcelain parsers behind adopting an existing worktree (`agendo launch
// --worktree=<path>` / `--name <existing>`). The e2e suite drives the adopt
// flow end to end, but against the FAKE git, whose porcelain is the tidy subset
// it prints itself — so a record shape it never emits (a bare repo, a detached
// or locked worktree, a branch with a slash in it, no trailing newline) is only
// ever seen here. These pin the format as real git prints it.

describe("parseWorktreeList", () => {
  test("main worktree first, then each linked one, branch stripped of refs/heads/", () => {
    const out = [
      "worktree /home/u/repo",
      "HEAD 72c12de0000000000000000000000000000000aa",
      "branch refs/heads/master",
      "",
      "worktree /home/u/repo/.claude/worktrees/audio-focus",
      "HEAD 5c3ffde0000000000000000000000000000000bb",
      "branch refs/heads/fix/audio-focus",
      "",
    ].join("\n");
    expect(parseWorktreeList(out)).toEqual([
      { path: "/home/u/repo", head: "72c12de0000000000000000000000000000000aa", branch: "master", detached: false, bare: false },
      {
        path: "/home/u/repo/.claude/worktrees/audio-focus",
        head: "5c3ffde0000000000000000000000000000000bb",
        // A slash in the branch survives: only the one `refs/heads/` prefix goes.
        branch: "fix/audio-focus",
        detached: false,
        bare: false,
      },
    ]);
  });

  test("a detached worktree has no branch; a bare main entry has neither branch nor HEAD", () => {
    const out = ["worktree /srv/repo.git", "bare", "", "worktree /srv/wt", "HEAD abc", "detached", ""].join("\n");
    const [bare, detached] = parseWorktreeList(out);
    expect(bare).toEqual({ path: "/srv/repo.git", detached: false, bare: true });
    expect(detached).toEqual({ path: "/srv/wt", head: "abc", detached: true, bare: false });
    expect(detached.branch).toBeUndefined();
  });

  test("attributes it does not model are skipped, not fatal, and the last record needs no trailing blank", () => {
    const out = [
      "worktree /r",
      "HEAD 1",
      "branch refs/heads/main",
      "",
      "worktree /r/.claude/worktrees/x",
      "HEAD 2",
      "branch refs/heads/worktree-x",
      "locked reason with spaces",
      "prunable gitdir file points to non-existent location",
    ].join("\n");
    const entries = parseWorktreeList(out);
    expect(entries.map((e) => e.path)).toEqual(["/r", "/r/.claude/worktrees/x"]);
    expect(entries[1].branch).toBe("worktree-x");
  });

  test("a path containing spaces is kept whole", () => {
    // The value is everything after the first space, not the second token.
    expect(parseWorktreeList("worktree /home/u/my repo/.claude/worktrees/a b\nHEAD 1\nbranch refs/heads/b\n")[0].path).toBe(
      "/home/u/my repo/.claude/worktrees/a b",
    );
  });

  test("empty output parses to no entries, and a stray attribute before any worktree is ignored", () => {
    expect(parseWorktreeList("")).toEqual([]);
    expect(parseWorktreeList("HEAD 1\nbranch refs/heads/x\n")).toEqual([]);
  });
});

describe("countDirty", () => {
  test("one per non-blank line: modified, untracked and renamed alike", () => {
    expect(countDirty(" M src/a.ts\n?? notes.md\nR  old.ts -> new.ts\nD  gone.ts\n")).toBe(4);
  });

  test("a clean tree is zero, with or without a trailing newline", () => {
    expect(countDirty("")).toBe(0);
    expect(countDirty("\n")).toBe(0);
    expect(countDirty(" M a\n M b")).toBe(2);
  });
});
