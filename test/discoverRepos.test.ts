// The path-context walk for checkouts (src/repos.ts `discoverGitReposUnder`),
// on scratch trees. The e2e suite points `agendo <dir>` at a folder holding one
// or two fixture checkouts; it never puts a checkout inside a checkout, a
// symlink back up the tree, a node_modules with a repo in it, an unreadable
// directory, or asks for a fresh rescan after the disk changed.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverGitReposUnder } from "../src/repos.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agendo-discover-")); });
afterEach(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(root, { recursive: true, force: true });
});

const checkout = (...parts: string[]) => mkdirSync(join(root, ...parts, ".git"), { recursive: true });
const names = (dir: string, fresh = false) => discoverGitReposUnder(dir, fresh).map((r) => [r.name, r.root]);

describe("discoverGitReposUnder", () => {
  beforeEach(() => mkdirSync(join(root, "locked")));

  test("a target that is itself a checkout speaks for itself, nested worktrees and all", () => {
    checkout("repo");
    checkout("repo", ".claude", "worktrees", "wt");
    checkout("repo", "vendor", "inner");
    expect(names(join(root, "repo"))).toEqual([["repo", join(root, "repo")]]);
  });

  test("the walk collects checkouts by name, skips dot-dirs, node_modules and links, and stops at a checkout", () => {
    checkout("work", "zeta");
    checkout("work", "alpha");
    checkout("work", "alpha", "sub", "inner");
    checkout("work", "node_modules", "dep");
    checkout("work", ".cache", "hidden");
    mkdirSync(join(root, "work", "deep", "deeper"), { recursive: true });
    checkout("work", "deep", "deeper", "found");
    symlinkSync(root, join(root, "work", "loop"));
    expect(names(join(root, "work"))).toEqual([
      ["alpha", join(root, "work", "alpha")],
      ["found", join(root, "work", "deep", "deeper", "found")],
      ["zeta", join(root, "work", "zeta")],
    ]);
  });

  test("nothing below falls back to the checkout the target sits inside, or to nothing", () => {
    checkout("repo");
    mkdirSync(join(root, "repo", "packages", "web"), { recursive: true });
    expect(names(join(root, "repo", "packages", "web"))).toEqual([["repo", join(root, "repo")]]);
    mkdirSync(join(root, "empty"));
    expect(names(join(root, "empty"))).toEqual([]);
  });

  test("the result is cached per target until a fresh scan is asked for", () => {
    mkdirSync(join(root, "later"));
    expect(names(join(root, "later"))).toEqual([]);
    checkout("later", "new");
    expect(names(join(root, "later"))).toEqual([]);
    expect(names(join(root, "later"), true)).toEqual([["new", join(root, "later", "new")]]);
  });

  test("an unreadable directory is skipped rather than failing the scan", () => {
    if (process.getuid?.() === 0) return; // root reads everything
    checkout("locked", "secret");
    checkout("open");
    chmodSync(join(root, "locked"), 0o000);
    expect(names(root)).toEqual([["open", join(root, "open")]]);
  });
});
