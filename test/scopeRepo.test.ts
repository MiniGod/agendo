// The repo-vs-folder classifier behind `G`'s two meanings
// (src/repositories/scopeRepo.ts), on scratch trees with an explicit $HOME.
// The e2e suite scopes to a fixture checkout and to the folder holding them,
// but never to a linked worktree outside `.claude/worktrees/`, a submodule, a
// subdirectory of a worktree, or a home directory that is itself a checkout.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scopeRepoRoot } from "../src/repositories/scopeRepo.ts";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agendo-scope-"));
  home = join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dir = (...parts: string[]) => {
  const p = join(home, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const checkout = (...parts: string[]) => {
  const p = dir(...parts);
  mkdirSync(join(p, ".git"));
  return p;
};
/** A linked worktree at `at`, the way `git worktree add` lays one out. */
const linkedWorktree = (main: string, name: string, at: string) => {
  const gitDir = join(main, ".git", "worktrees", name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "commondir"), "../..\n");
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, ".git"), `gitdir: ${gitDir}\n`);
  return at;
};

describe("scopeRepoRoot", () => {
  test("a checkout's root is a repo scope, spelled any way", () => {
    const repo = checkout("git", "agendo");
    expect(scopeRepoRoot(repo, home)).toBe(repo);
    expect(scopeRepoRoot(`${repo}/`, home)).toBe(repo);
    expect(scopeRepoRoot(`${repo}//src/..`, home)).toBe(repo);
  });

  test("a directory inside a checkout is a scope over that checkout", () => {
    const repo = checkout("git", "agendo");
    expect(scopeRepoRoot(dir("git", "agendo", "src", "ui"), home)).toBe(repo);
  });

  test("a folder holding checkouts is not a repo scope", () => {
    checkout("git", "agendo");
    checkout("git", "blip");
    expect(scopeRepoRoot(join(home, "git"), home)).toBeNull();
  });

  test("a .claude/worktrees worktree, or anywhere in it, scopes to the main checkout", () => {
    const repo = checkout("git", "agendo");
    const wt = linkedWorktree(repo, "feat", join(repo, ".claude", "worktrees", "feat"));
    expect(scopeRepoRoot(wt, home)).toBe(repo);
    expect(scopeRepoRoot(dir("git", "agendo", ".claude", "worktrees", "feat", "src"), home)).toBe(repo);
  });

  test("a linked worktree elsewhere follows its commondir back to the main checkout", () => {
    const repo = checkout("git", "agendo");
    const wt = linkedWorktree(repo, "elsewhere", join(home, "wt", "agendo-elsewhere"));
    expect(scopeRepoRoot(wt, home)).toBe(repo);
    expect(scopeRepoRoot(dir("wt", "agendo-elsewhere", "src"), home)).toBe(repo);
  });

  test("a .claude/worktrees worktree nested in a linked worktree elsewhere still scopes to the main checkout", () => {
    const repo = checkout("git", "agendo");
    const outer = linkedWorktree(repo, "hotfix", join(home, "wt", "agendo-hotfix"));
    const inner = linkedWorktree(repo, "inner", join(outer, ".claude", "worktrees", "inner"));
    expect(scopeRepoRoot(inner, home)).toBe(repo);
  });

  test("a submodule (gitdir with no commondir) is a repository of its own", () => {
    const repo = checkout("git", "super");
    const modDir = join(repo, ".git", "modules", "lib");
    mkdirSync(modDir, { recursive: true });
    const sub = dir("git", "super", "lib");
    writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/lib\n");
    expect(scopeRepoRoot(sub, home)).toBe(sub);
  });

  test("a worktree of a bare repo is a repository of its own", () => {
    const bare = dir("bare.git");
    const gitDir = join(bare, "worktrees", "w");
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, "commondir"), "../..\n");
    const wt = dir("w");
    writeFileSync(join(wt, ".git"), `gitdir: ${gitDir}\n`);
    expect(scopeRepoRoot(wt, home)).toBe(wt);
  });

  test("an unreadable or malformed .git pointer still marks the top of a checkout", () => {
    const odd = dir("odd");
    writeFileSync(join(odd, ".git"), "not a pointer\n");
    expect(scopeRepoRoot(odd, home)).toBe(odd);
    const dangling = dir("dangling");
    writeFileSync(join(dangling, ".git"), `gitdir: ${join(root, "nowhere")}\n`);
    expect(scopeRepoRoot(dangling, home)).toBe(dangling);
  });

  test("the walk never climbs into a home directory that is itself a checkout", () => {
    mkdirSync(join(home, ".git"));
    expect(scopeRepoRoot(dir("git"), home)).toBeNull();
    expect(scopeRepoRoot(dir("git", "notes", "deep"), home)).toBeNull();
  });

  test("…but naming $HOME itself, when it is a checkout, is a repo scope", () => {
    mkdirSync(join(home, ".git"));
    expect(scopeRepoRoot(home, home)).toBe(home);
  });

  test("outside $HOME the walk goes up freely, until it reaches one of $HOME's ancestors", () => {
    const repo = join(root, "srv", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(join(repo, "a", "b"), { recursive: true });
    expect(scopeRepoRoot(join(repo, "a", "b"), home)).toBe(repo);
    mkdirSync(join(root, "srv", "plain"), { recursive: true });
    expect(scopeRepoRoot(join(root, "srv", "plain"), home)).toBeNull();
    // A checkout ABOVE $HOME is never reached from a folder beside it: that stop
    // is also what keeps the filesystem root out, `/` being every $HOME's ancestor.
    mkdirSync(join(root, ".git"));
    expect(scopeRepoRoot(join(root, "srv", "plain"), home)).toBeNull();
  });

  test("a path that does not exist is not a repo scope, even inside a checkout", () => {
    expect(scopeRepoRoot(join(home, "missing", "dir"), home)).toBeNull();
    // Outside $HOME too, where no ancestor stop would have caught it.
    const repo = join(root, "srv", "repo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(scopeRepoRoot(join(repo, "not", "there"), home)).toBeNull();
  });
});
