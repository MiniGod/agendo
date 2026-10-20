// The cleanup view's git probe and its deletions, against real throwaway repos
// (test/cleanupFixture.ts) — the squash-merge detection and the refusal guards
// are exactly the logic a mocked git would let through untested.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { executeCleanup, managedPath, type CleanupPlan } from "../src/cleanup/execute.ts";
import { aheadCount, baseRef, git, isMerged, listWorktrees, patchIds, probeGit, squashMerged } from "../src/cleanup/git.ts";
import type { CleanupRow, GitState, Selection } from "../src/cleanup/types.ts";
import type { AgentSession } from "../src/shared/types.ts";
import { commit, makeFixture, sh, squashMerge, type Fixture } from "./cleanupFixture.ts";

let f: Fixture;
beforeEach(() => {
  f = makeFixture();
});
afterEach(() => {
  rmSync(f.tmp, { recursive: true, force: true });
});

function row(path: string, over: Partial<CleanupRow> = {}): CleanupRow {
  return {
    key: `worktree:${path}`,
    title: "t",
    session: null,
    repoRoot: f.repo,
    worktree: path,
    path,
    branchHint: null,
    updated: new Date(0),
    created: new Date(0),
    run: "idle",
    ...over,
  };
}

const sel = (over: Partial<Selection>): Selection => ({ worktree: false, branch: false, transcript: false, tmp: false, ...over });

function plan(r: CleanupRow, s: Selection, gitState: GitState | null | undefined, over: Partial<CleanupPlan> = {}): CleanupPlan {
  // The clock sits an hour ahead, so the worktrees each test just made are not "written to moments ago".
  return { row: r, sel: s, git: gitState, confirmed: false, activeConfirmed: false, othersRunning: false, tmpRoot: f.tmp, uid: 1000, now: Date.now() + 3_600_000, ...over };
}

const branchExists = (b: string) => sh(f.repo, "branch", "--list", b) !== "";

describe("probeGit", () => {
  test("a fresh worktree with nothing on it is clean, pushed and merged", async () => {
    const wt = f.worktree("fresh");
    expect(await probeGit(f.repo, wt, null)).toEqual({
      worktreeExists: true,
      isMain: false,
      branch: "worktree-fresh",
      head: sh(f.repo, "rev-parse", "master"),
      mainBranch: "master",
      dirty: 0,
      ignored: [], changed: [], submodules: 0,
      unpushed: 0,
      merged: true,
      base: "origin/master",
    });
  });

  test("a local commit is unpushed and unmerged; an untracked file is dirty", async () => {
    const wt = f.worktree("work");
    commit(wt, "a.txt", "a\n");
    writeFileSync(join(wt, "scratch.txt"), "x");
    const g = await probeGit(f.repo, wt, null);
    expect(g).toMatchObject({ dirty: 1, unpushed: 1, merged: false });
  });

  test("a squash merge counts as merged — and nothing on it is unpushed — even after the base moved on", async () => {
    const wt = f.worktree("squashed");
    commit(wt, "a.txt", "a\n");
    commit(wt, "a.txt", "a\nb\n");
    commit(f.repo, "other.txt", "elsewhere\n"); // the base gains an unrelated commit first
    squashMerge(f, "worktree-squashed");
    commit(f.repo, "later.txt", "later\n");
    sh(f.repo, "push", "-q", "origin", "master");
    sh(wt, "fetch", "-q", "origin");
    expect(await probeGit(f.repo, wt, null)).toMatchObject({ merged: true, unpushed: 0, dirty: 0 });
  });

  test("a commit after the squash that differs only in whitespace is NOT merged", async () => {
    const wt = f.worktree("ws");
    commit(wt, "g.py", "def g():\n    if x:\n        y()\n    z()\n");
    commit(f.repo, "other.txt", "elsewhere\n"); // so the squash's tree is not the branch's
    squashMerge(f, "worktree-ws");
    sh(f.repo, "push", "-q", "origin", "master");
    // Re-indenting z() into the if block changes what the code does; --stable patch-ids would not see it.
    commit(wt, "g.py", "def g():\n    if x:\n        y()\n        z()\n");
    sh(wt, "fetch", "-q", "origin");
    expect(await probeGit(f.repo, wt, null)).toMatchObject({ merged: false, unpushed: 2 });
  });

  test("the user's diff configuration cannot hide an unpushed change from the squash check", async () => {
    const wt = f.worktree("conv");
    writeFileSync(join(f.repo, ".git", "info", "attributes"), "*.bin diff=bin\n");
    sh(f.repo, "config", "diff.bin.textconv", "head -c 1"); // every version reads "a"
    commit(wt, "data.bin", "aXXX");
    commit(f.repo, "other.txt", "elsewhere\n");
    squashMerge(f, "worktree-conv");
    sh(f.repo, "push", "-q", "origin", "master");
    commit(wt, "data.bin", "aYYY"); // a real change no textconv'd diff shows
    sh(wt, "fetch", "-q", "origin");
    expect(await probeGit(f.repo, wt, null)).toMatchObject({ merged: false, unpushed: 2 });
    sh(f.repo, "config", "diff.external", "true"); // an external diff tool prints nothing either
    expect(await isMerged(wt, "HEAD", "origin/master")).toBe(false);
  });

  test("a submodule bump hidden by diff.ignoreSubmodules=all still reads as unmerged", async () => {
    const wt = f.worktree("subm");
    commit(wt, "a.txt", "a\n");
    commit(f.repo, "other.txt", "elsewhere\n");
    squashMerge(f, "worktree-subm");
    sh(f.repo, "push", "-q", "origin", "master");
    const sha = sh(f.repo, "rev-parse", "HEAD");
    sh(wt, "update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
    sh(wt, "commit", "-q", "-m", "bump sub");
    sh(f.repo, "config", "diff.ignoreSubmodules", "all");
    sh(wt, "fetch", "-q", "origin");
    expect(await isMerged(wt, "refs/heads/worktree-subm", "origin/master")).toBe(false);
  });

  test("a submodule bump printed as a log by diff.submodule=log still reads as unmerged", async () => {
    const wt = f.worktree("sublog");
    commit(wt, "a.txt", "a\n");
    squashMerge(f, "worktree-sublog"); // the base took the edit…
    commit(f.repo, "other.txt", "elsewhere\n");
    sh(f.repo, "push", "-q", "origin", "master");
    const sha = sh(f.repo, "rev-parse", "HEAD");
    sh(wt, "update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
    sh(wt, "commit", "-q", "-m", "bump sub"); // …but never the bump
    sh(f.repo, "config", "diff.submodule", "log");
    sh(wt, "fetch", "-q", "origin");
    expect(await isMerged(wt, "refs/heads/worktree-sublog", "origin/master")).toBe(false);
  });

  test("an unstaged change listed first keeps its whole path", async () => {
    const wt = f.worktree("unstaged");
    writeFileSync(join(wt, "README.md"), "changed\n");
    writeFileSync(join(wt, "zed.txt"), "z");
    expect(await probeGit(f.repo, wt, null)).toMatchObject({ dirty: 2, changed: ["README.md", "zed.txt"] });
  });

  test("an edit hidden from status by skip-worktree or assume-unchanged is still at stake", async () => {
    commit(f.repo, "conf.txt", "default\n");
    commit(f.repo, "keys.txt", "none\n");
    sh(f.repo, "push", "-q", "origin", "master");
    const wt = f.worktree("hidden-edit");
    sh(wt, "update-index", "--skip-worktree", "conf.txt");
    sh(wt, "update-index", "--assume-unchanged", "keys.txt");
    writeFileSync(join(wt, "conf.txt"), "local secret\n");
    writeFileSync(join(wt, "keys.txt"), "local key\n");
    expect(await probeGit(f.repo, wt, null)).toMatchObject({ dirty: 2, changed: ["conf.txt", "keys.txt"], merged: true });
  });

  test("a checkout whose status can't be read is not clean, and is never forced away", async () => {
    const wt = f.worktree("blind");
    writeFileSync(join(wt, "untracked.txt"), "mine");
    writeFileSync(join(f.repo, ".git", "worktrees", "blind", "index"), "garbage");
    const g = await probeGit(f.repo, wt, null);
    expect(g?.statusError).toBeTruthy();
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { confirmed: true }));
    expect(res).toEqual([{ ok: false, text: expect.stringContaining("git status fails there") }]);
    expect(existsSync(join(wt, "untracked.txt"))).toBe(true);
  });

  test("status.showUntrackedFiles=no cannot hide untracked or ignored files", async () => {
    const wt = f.worktree("hidden");
    sh(f.repo, "config", "status.showUntrackedFiles", "no");
    writeFileSync(join(f.repo, ".git", "info", "exclude"), ".env\n");
    writeFileSync(join(wt, "new.txt"), "x");
    writeFileSync(join(wt, ".env"), "SECRET=1\n");
    expect(await probeGit(f.repo, wt, null)).toMatchObject({ dirty: 1, changed: ["new.txt"], ignored: [".env"] });
  });

  test("ignored files count as at stake; regenerable build output does not", async () => {
    const wt = f.worktree("ign");
    // Ignored through info/exclude, so the branch itself stays clean and merged.
    writeFileSync(join(f.repo, ".git", "info", "exclude"), ".env\nnode_modules/\ncoverage/\nnotes/\n");
    writeFileSync(join(wt, ".env"), "SECRET=1\n");
    mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
    writeFileSync(join(wt, "node_modules", "x", "i.js"), "");
    mkdirSync(join(wt, "coverage"));
    writeFileSync(join(wt, "coverage", "c.json"), "{}");
    mkdirSync(join(wt, "notes"));
    writeFileSync(join(wt, "notes", "n.md"), "mine");
    expect((await probeGit(f.repo, wt, null))?.ignored).toEqual([".env", "notes/"]);
  });

  test("only a wholly ignored output directory is regenerable, not a file somebody put inside a tracked one", async () => {
    mkdirSync(join(f.repo, "build"));
    mkdirSync(join(f.repo, "packages", "a"), { recursive: true });
    commit(f.repo, "build/script.sh", "echo\n");
    commit(f.repo, "packages/a/index.js", "\n");
    sh(f.repo, "push", "-q", "origin", "master");
    const wt = f.worktree("ignbuild");
    writeFileSync(join(f.repo, ".git", "info", "exclude"), "*.env\nnode_modules/\n");
    writeFileSync(join(wt, "build", "prod.env"), "SECRET=1\n");
    mkdirSync(join(wt, "packages", "a", "node_modules"), { recursive: true });
    writeFileSync(join(wt, "packages", "a", "node_modules", "i.js"), "");
    expect((await probeGit(f.repo, wt, null))?.ignored).toEqual(["build/prod.env"]);
  });

  test("a squash of an up-to-date branch is found by its tree", async () => {
    const wt = f.worktree("tree");
    commit(wt, "a.txt", "a\n");
    squashMerge(f, "worktree-tree");
    sh(wt, "fetch", "-q", "origin");
    expect(await squashMerged(wt, "HEAD", "origin/master")).toBe(true);
  });

  test("a branch the base never took stays unmerged", async () => {
    const wt = f.worktree("open");
    commit(wt, "a.txt", "mine\n");
    commit(f.repo, "a.txt", "theirs\n");
    sh(f.repo, "push", "-q", "origin", "master");
    sh(wt, "fetch", "-q", "origin");
    expect(await isMerged(wt, "HEAD", "origin/master")).toBe(false);
    expect(await isMerged(wt, "HEAD", null)).toBe(false);
  });

  test("a pushed branch has nothing unpushed, and counts against its upstream once it moves", async () => {
    const wt = f.worktree("pushed");
    commit(wt, "a.txt", "a\n");
    sh(wt, "push", "-q", "-u", "origin", "worktree-pushed");
    expect(await aheadCount(wt, "HEAD", "worktree-pushed")).toBe(0);
    commit(wt, "b.txt", "b\n");
    expect(await aheadCount(wt, "HEAD", "worktree-pushed")).toBe(1);
    sh(wt, "branch", "--unset-upstream");
    expect(await aheadCount(wt, "HEAD", "worktree-pushed")).toBe(1); // origin/<branch> still answers
    expect(await aheadCount(wt, "HEAD", null)).toBe(1); // no branch: whatever no remote has
  });

  test("the main checkout says so, from any directory inside it", async () => {
    mkdirSync(join(f.repo, "sub"));
    expect(await probeGit(f.repo, join(f.repo, "sub"), null)).toMatchObject({ isMain: true, branch: "master", mainBranch: "master" });
  });

  test("a removed worktree is judged by the branch it left behind; with neither left there is nothing", async () => {
    const wt = f.worktree("gone");
    commit(wt, "a.txt", "a\n");
    sh(f.repo, "worktree", "remove", wt);
    expect(await probeGit(f.repo, wt, "worktree-gone")).toMatchObject({ worktreeExists: false, branch: "worktree-gone", dirty: 0, unpushed: 1 });
    expect(await probeGit(f.repo, wt, "no-such-branch")).toBeNull();
    expect(await probeGit(f.repo, wt, null)).toBeNull();
  });

  test("a leftover directory under .claude/worktrees/ is not mistaken for the main checkout above it", async () => {
    sh(f.repo, "branch", "feat");
    const dir = join(f.repo, ".claude", "worktrees", "old");
    mkdirSync(dir, { recursive: true });
    expect(await probeGit(f.repo, dir, "feat")).toMatchObject({ worktreeExists: false, isMain: false, branch: "feat" });
    expect(await probeGit(f.repo, dir, null)).toBeNull();
  });

  test("the base falls back from origin/HEAD to origin/master, and is null with no origin at all", async () => {
    sh(f.repo, "remote", "set-head", "origin", "--delete");
    expect(await baseRef(f.repo)).toBe("origin/master");
    sh(f.repo, "remote", "remove", "origin");
    expect(await baseRef(f.repo)).toBeNull();
    expect(await probeGit(f.repo, f.repo, null)).toMatchObject({ base: null, merged: false });
  });

  test("git itself: a failing command resolves with its code, and the worktree list is empty outside a repo", async () => {
    expect((await git(f.tmp, ["rev-parse", "--show-toplevel"])).code).not.toBe(0);
    expect(await listWorktrees(f.tmp)).toEqual([]);
    expect(await patchIds(f.tmp, ["log", "-p"])).toEqual([]); // the feeding git failed
    expect(await patchIds(f.repo, ["log", "-p", "-n1"])).toHaveLength(1);
  });

  test("a patch-id that quits early does not leave the feeding git blocked on a full pipe", async () => {
    const wt = f.worktree("big");
    commit(wt, "big.txt", "x".repeat(600_000) + "\n"); // far more than a pipe buffer
    // An unknown flag makes patch-id exit at once, the way a git without --verbatim does.
    // Resolving at all means the feeding `git diff` was reaped rather than left writing.
    expect(await patchIds(wt, ["diff", "--binary", "master", "HEAD"], ["patch-id", "--no-such-flag"])).toEqual([]);
    // …and a writer that never starts does not leave patch-id waiting on its input.
    expect(await patchIds(wt, ["diff"], undefined, "/nonexistent/git")).toEqual([]);
  });
});

describe("executeCleanup", () => {
  test("a clean, merged worktree and its branch are removed", async () => {
    const wt = f.worktree("done");
    const g = await probeGit(f.repo, wt, null);
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true, branch: true }), g));
    expect(res.every((r) => r.ok)).toBe(true);
    expect(existsSync(wt)).toBe(false);
    expect(branchExists("worktree-done")).toBe(false);
  });

  test("a dirty worktree needs the confirmation, and then goes with --force", async () => {
    const wt = f.worktree("dirty");
    writeFileSync(join(wt, "scratch.txt"), "x");
    const g = await probeGit(f.repo, wt, null);
    const refused = await executeCleanup(plan(row(wt), sel({ worktree: true }), g));
    expect(refused[0]).toMatchObject({ ok: false });
    expect(existsSync(wt)).toBe(true);
    const forced = await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { confirmed: true }));
    expect(forced[0]).toMatchObject({ ok: true, text: expect.stringContaining("(forced)") });
    expect(existsSync(wt)).toBe(false);
  });

  test("another branch, or the same branch on other commits, is not what was confirmed", async () => {
    const wt = f.worktree("moved");
    commit(wt, "a.txt", "a\n");
    const before = await probeGit(f.repo, wt, null);
    sh(wt, "switch", "-q", "-c", "other");
    sh(wt, "reset", "-q", "--hard", "master");
    commit(wt, "b.txt", "b\n"); // the same one unpushed, unmerged commit — on another branch
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true, branch: true }), before, { confirmed: true }));
    expect(res[0].text).toContain("more is at stake");
    expect(existsSync(wt)).toBe(true);
    expect(branchExists("other")).toBe(true);
    sh(wt, "switch", "-q", "worktree-moved");
    sh(wt, "commit", "-q", "--amend", "-m", "rewritten"); // same branch, same count, another commit
    expect((await executeCleanup(plan(row(wt), sel({ worktree: true }), before, { confirmed: true })))[0].text).toContain("more is at stake");
  });

  test("more at stake than the confirmed snapshot refuses, even when confirmed", async () => {
    const wt = f.worktree("grew");
    const before = await probeGit(f.repo, wt, null);
    writeFileSync(join(wt, "new.txt"), "x");
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true }), before, { confirmed: true }));
    expect(res[0].text).toContain("more is at stake");
    expect(existsSync(wt)).toBe(true);
  });

  test("a running session, or another running session in the worktree, refuses", async () => {
    const wt = f.worktree("busy");
    const g = await probeGit(f.repo, wt, null);
    expect((await executeCleanup(plan(row(wt, { run: "running" }), sel({ worktree: true }), g)))[0].text).toContain("running");
    expect((await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { othersRunning: true })))[0].text).toContain("a running session uses");
    expect(existsSync(wt)).toBe(true);
  });

  test("a session active moments ago is touched only once confirmed", async () => {
    const wt = f.worktree("recent");
    const g = await probeGit(f.repo, wt, null);
    const refused = await executeCleanup(plan(row(wt, { active: true }), sel({ worktree: true }), g));
    expect(refused).toEqual([{ ok: false, text: expect.stringContaining("active moments ago") }]);
    expect(existsSync(wt)).toBe(true);
    expect((await executeCleanup(plan(row(wt, { active: true }), sel({ worktree: true }), g, { confirmed: true, activeConfirmed: true })))[0].ok).toBe(true);
  });

  test("another session in the worktree written moments ago is checked at run time too", async () => {
    const wt = f.worktree("shared");
    const log = join(f.tmp, "neighbour.jsonl");
    writeFileSync(log, "{}\n");
    const g = await probeGit(f.repo, wt, null);
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { now: Date.now(), shared: [log] }));
    expect(res).toEqual([{ ok: false, text: expect.stringContaining("active moments ago") }]);
    expect(existsSync(wt)).toBe(true);
  });

  test("a worktree with a checked-out submodule is risky, and goes only with the confirmation (and --force)", async () => {
    const lib = join(f.tmp, "lib");
    sh(f.tmp, "init", "-q", "-b", "master", lib);
    commit(lib, "lib.txt", "lib\n");
    const wt = f.worktree("withsub");
    sh(wt, "-c", "protocol.file.allow=always", "submodule", "add", "-q", lib, "lib");
    sh(wt, "commit", "-q", "-m", "add lib");
    const g = await probeGit(f.repo, wt, null);
    expect(g).toMatchObject({ dirty: 0, submodules: 1 });
    expect((await executeCleanup(plan(row(wt), sel({ worktree: true }), g)))[0].ok).toBe(false);
    expect(existsSync(wt)).toBe(true);
    expect(await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { confirmed: true }))).toEqual([{ ok: true, text: expect.stringContaining("(forced)") }]);
    expect(existsSync(wt)).toBe(false);
  });

  test("a confirmation that never warned of activity does not cover activity found at run time", async () => {
    const wt = f.worktree("lateactive");
    writeFileSync(join(wt, "scratch.txt"), "x");
    const g = await probeGit(f.repo, wt, null);
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { confirmed: true, now: Date.now() }));
    expect(res).toEqual([{ ok: false, text: expect.stringContaining("active moments ago") }]);
    expect(existsSync(join(wt, "scratch.txt"))).toBe(true);
  });

  test("activity is re-checked on disk at run time: a worktree that just changed is touched only once confirmed", async () => {
    const wt = f.worktree("justnow");
    const g = await probeGit(f.repo, wt, null);
    const refused = await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { now: Date.now() }));
    expect(refused).toEqual([{ ok: false, text: expect.stringContaining("active moments ago") }]);
    expect(existsSync(wt)).toBe(true);
  });

  test("ignored files make a worktree risky: it is removed only once confirmed", async () => {
    const wt = f.worktree("ign");
    writeFileSync(join(f.repo, ".git", "info", "exclude"), ".env\n");
    writeFileSync(join(wt, ".env"), "SECRET=1\n");
    const g = await probeGit(f.repo, wt, null);
    expect(g).toMatchObject({ dirty: 0, unpushed: 0, merged: true, ignored: [".env"] });
    expect((await executeCleanup(plan(row(wt), sel({ worktree: true }), g)))[0].text).toContain("would lose work");
    expect(existsSync(join(wt, ".env"))).toBe(true);
    const done = await executeCleanup(plan(row(wt), sel({ worktree: true }), g, { confirmed: true }));
    expect(done[0]).toMatchObject({ ok: true });
  });

  test("a worktree outside .claude/worktrees/ — or a symlink into one — is never removed", async () => {
    const outside = join(f.tmp, "elsewhere");
    sh(f.repo, "worktree", "add", "-q", "-b", "elsewhere", outside, "master");
    const g = await probeGit(f.repo, outside, null);
    const res = await executeCleanup(plan(row(outside), sel({ worktree: true }), g));
    expect(res[0]).toMatchObject({ ok: false, text: expect.stringContaining("refused") });
    expect(existsSync(outside)).toBe(true);

    const link = join(f.repo, ".claude", "worktrees", "link");
    mkdirSync(join(f.repo, ".claude", "worktrees"), { recursive: true });
    symlinkSync(outside, link);
    expect(await managedPath(f.repo, link)).toBeNull();
    expect((await executeCleanup(plan(row(link), sel({ worktree: true }), g)))[0].ok).toBe(false);
    expect(existsSync(outside)).toBe(true);
  });

  test("a worktree with another worktree nested inside it is refused, and the inner one survives", async () => {
    const outer = f.worktree("outer");
    const inner = join(outer, ".claude", "worktrees", "inner");
    sh(f.repo, "worktree", "add", "-q", "-b", "worktree-inner", inner, "master");
    const g = await probeGit(f.repo, outer, null);
    const res = await executeCleanup(plan(row(outer), sel({ worktree: true }), g, { confirmed: true }));
    expect(res[0].text).toContain("contains the worktree");
    expect(existsSync(inner)).toBe(true);
  });

  test("a plain directory under .claude/worktrees/ that git does not list is refused", async () => {
    const stray = join(f.repo, ".claude", "worktrees", "stray");
    mkdirSync(stray, { recursive: true });
    const g: GitState = { worktreeExists: true, isMain: false, branch: "x", mainBranch: "master", head: "h1", dirty: 0, ignored: [], changed: [], submodules: 0, unpushed: 0, merged: true, base: "origin/master" };
    const res = await executeCleanup(plan(row(stray, { path: stray }), sel({ worktree: true }), g));
    // The probe from inside it resolves to the main checkout, whose branch is never deleted.
    expect(res[0].ok).toBe(false);
    expect(existsSync(stray)).toBe(true);
  });

  test("the main checkout's branch, and a branch still checked out elsewhere, are refused", async () => {
    const main = await probeGit(f.repo, f.repo, null);
    const r1 = await executeCleanup(plan(row(f.repo, { worktree: null }), sel({ branch: true }), main));
    expect(r1[0]).toMatchObject({ ok: false, text: expect.stringContaining("main checkout") });

    const wt = f.worktree("held");
    const g = await probeGit(f.repo, wt, null);
    const r2 = await executeCleanup(plan(row(wt), sel({ branch: true }), g));
    expect(r2[0]).toMatchObject({ ok: false, text: expect.stringContaining("checked out at") });
    expect(branchExists("worktree-held")).toBe(true);
  });

  test("a branch left behind by a removed worktree can be deleted on its own, once confirmed", async () => {
    const wt = f.worktree("left");
    commit(wt, "a.txt", "a\n");
    sh(f.repo, "worktree", "remove", wt);
    const g = await probeGit(f.repo, wt, "worktree-left");
    const r = row(wt, { branchHint: "worktree-left" });
    expect((await executeCleanup(plan(r, sel({ branch: true }), g)))[0].ok).toBe(false);
    expect((await executeCleanup(plan(r, sel({ branch: true }), g, { confirmed: true })))[0].ok).toBe(true);
    expect(branchExists("worktree-left")).toBe(false);
  });

  test("a failed worktree removal stops before the branch", async () => {
    const wt = f.worktree("locked");
    sh(f.repo, "worktree", "lock", wt);
    const g = await probeGit(f.repo, wt, null);
    const res = await executeCleanup(plan(row(wt), sel({ worktree: true, branch: true }), g));
    expect(res).toHaveLength(1);
    expect(res[0].ok).toBe(false);
    expect(branchExists("worktree-locked")).toBe(true);
  });

  test("the transcript and the scratch dir are deleted; an agent with no scratch dir says so", async () => {
    const projects = join(f.tmp, "projects", "p");
    mkdirSync(join(projects, "sess-1"), { recursive: true });
    writeFileSync(join(projects, "sess-1.jsonl"), "{}\n");
    const cwd = join(f.tmp, "cwd");
    const scratch = join(f.tmp, "claude-1000", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "sess-1");
    mkdirSync(scratch, { recursive: true });
    const session = { id: "sess-1", source: "claude", cwd, title: "s", lastUsed: new Date(), logPath: join(projects, "sess-1.jsonl") } as AgentSession;
    const r = row(cwd, { worktree: null, session });
    const res = await executeCleanup(plan(r, sel({ transcript: true, tmp: true }), null));
    expect(res.map((x) => x.ok)).toEqual([true, true]);
    expect(existsSync(join(projects, "sess-1.jsonl"))).toBe(false);
    expect(existsSync(join(projects, "sess-1"))).toBe(false);
    expect(existsSync(scratch)).toBe(false);

    const codex = { ...session, source: "codex", logPath: join(f.tmp, "unrelated.jsonl") } as AgentSession;
    const res2 = await executeCleanup(plan(row(cwd, { worktree: null, session: codex }), sel({ transcript: true, tmp: true }), null));
    expect(res2.map((x) => x.ok)).toEqual([false, false]);
    // A dangling symlink is still something on disk to remove.
    symlinkSync(join(f.tmp, "nowhere"), join(projects, "sess-1.jsonl"));
    expect((await executeCleanup(plan(r, sel({ transcript: true }), null)))[0].text).toBe("deleted session transcript");
    // Gone already: said, not claimed as deleted.
    expect((await executeCleanup(plan(r, sel({ transcript: true, tmp: true }), null))).map((x) => x.text)).toEqual([
      "session transcript: nothing on disk",
      "tmp/scratch files: nothing on disk",
    ]);
  });

  test("the worktree agendo itself is running in is never removed", async () => {
    const wt = f.worktree("self");
    const g = await probeGit(f.repo, wt, null);
    const back = process.cwd();
    mkdirSync(join(wt, "deep"));
    process.chdir(join(wt, "deep"));
    try {
      const res = await executeCleanup(plan(row(wt), sel({ worktree: true }), g));
      expect(res).toEqual([{ ok: false, text: expect.stringContaining("agendo itself is running in it") }]);
    } finally {
      process.chdir(back);
    }
    expect(existsSync(wt)).toBe(true);
  });

  test("worktree/branch steps report a row whose checkout and branch are both gone", async () => {
    const missing = join(f.repo, ".claude", "worktrees", "never");
    const res = await executeCleanup(plan(row(missing), sel({ worktree: true }), null));
    expect(res[0].text).toContain("gone already");
  });
});
