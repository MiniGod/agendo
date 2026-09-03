// Finding a checkout's two git dirs (src/gitrefs.ts `gitDirs`), on scratch
// directories. The e2e suite reaches this through `agendo status` on fixture
// checkouts that are all main checkouts under a real .git directory; it never
// hands it a linked worktree with a relative `gitdir:`, an absolute one, a
// `.git` file that says nothing usable, or a cwd that is gone. (The stop at
// $HOME is not driven here: bun reads $HOME once at startup, so only the e2e
// suite, which sets it per fixture, can reach that line.)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitDirs } from "../src/gitrefs.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agendo-gitdirs-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A main checkout with a real `.git` directory, returned as its root. */
function checkout(name: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, ".git"), { recursive: true });
  return repo;
}

describe("gitDirs", () => {
  test("a main checkout, from its root or a subdirectory: both dirs are its .git", () => {
    const repo = checkout("repo");
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    const dirs = { gitDir: join(repo, ".git"), commonDir: join(repo, ".git") };
    expect(gitDirs(repo)).toEqual(dirs);
    expect(gitDirs(join(repo, "src", "deep"))).toEqual(dirs);
  });

  test("a linked worktree follows gitdir: and commondir, relative or absolute", () => {
    const repo = checkout("repo");
    const wtGit = join(repo, ".git", "worktrees", "wt");
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(join(wtGit, "commondir"), "../..\n");
    const wt = join(repo, ".claude", "worktrees", "wt");
    mkdirSync(join(wt, "src"), { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: ../../../.git/worktrees/wt\n");
    expect(gitDirs(join(wt, "src"))).toEqual({ gitDir: wtGit, commonDir: join(repo, ".git") });
    writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
    writeFileSync(join(wtGit, "commondir"), `${join(repo, ".git")}\n`);
    expect(gitDirs(wt)).toEqual({ gitDir: wtGit, commonDir: join(repo, ".git") });
  });

  test("a .git file that names no gitdir, a vanished cwd, a cwd that is a file, and no checkout at all are unknown", () => {
    const wt = join(root, "wt");
    mkdirSync(wt);
    writeFileSync(join(wt, ".git"), "not a worktree pointer\n");
    expect(gitDirs(wt)).toBeNull();
    expect(gitDirs(join(root, "gone"))).toBeNull();
    writeFileSync(join(root, "file"), "");
    expect(gitDirs(join(root, "file"))).toBeNull();
    mkdirSync(join(root, "notes"));
    expect(gitDirs(join(root, "notes"))).toBeNull();
  });
});
