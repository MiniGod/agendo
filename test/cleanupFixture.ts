// Throwaway git repos for the cleanup tests: a bare `origin`, a main checkout
// cloned from it, and helpers to grow agendo-style worktrees under
// `<repo>/.claude/worktrees/`. Everything lives in one mkdtemp dir that the
// caller removes; git runs with no global or system config, so neither the
// developer's settings (signing, hooks, default branch) nor their repos are
// ever involved.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
});

export function sh(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${dir}: ${r.stderr}`);
  return r.stdout.trim();
}

export function commit(dir: string, file: string, content: string, msg = `edit ${file}`): void {
  writeFileSync(join(dir, file), content);
  sh(dir, "add", file);
  sh(dir, "commit", "-q", "-m", msg);
}

export interface Fixture {
  tmp: string;
  origin: string;
  repo: string;
  /** Add `<repo>/.claude/worktrees/<name>` on a new branch `worktree-<name>` off master. */
  worktree(name: string): string;
}

export function makeFixture(): Fixture {
  const tmp = mkdtempSync(join(tmpdir(), "agendo-cleanup-"));
  const origin = join(tmp, "origin.git");
  const repo = join(tmp, "repo");
  spawnSync("git", ["init", "-q", "--bare", "-b", "master", origin]);
  spawnSync("git", ["clone", "-q", origin, repo]);
  commit(repo, "README.md", "hello\n", "init");
  sh(repo, "push", "-q", "-u", "origin", "master");
  sh(repo, "remote", "set-head", "origin", "master");
  return {
    tmp,
    origin,
    repo,
    worktree(name) {
      const path = join(repo, ".claude", "worktrees", name);
      sh(repo, "worktree", "add", "-q", "-b", `worktree-${name}`, path, "master");
      return path;
    },
  };
}

/** Squash-merge `branch` into master in the main checkout and push it. */
export function squashMerge(f: Fixture, branch: string): void {
  sh(f.repo, "merge", "-q", "--squash", branch);
  sh(f.repo, "commit", "-q", "-m", `squash ${branch}`);
  sh(f.repo, "push", "-q", "origin", "master");
}
