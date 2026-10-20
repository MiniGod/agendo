// The cleanup view's cells, its disk measurements and its probe pool.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedUsage, claudeTmpRoot, diskUsage, invalidateUsage, listManagedWorktrees, usageOf } from "../src/cleanup/disk.ts";
import type { CleanupRow, GitState } from "../src/cleanup/types.ts";
import { measureRow, runPool } from "../src/ui/hooks/useCleanupData.ts";
import { gitCells, pageTop, runCell, sortLabel } from "../src/ui/models/cleanupRow.ts";
import type { AgentSession } from "../src/shared/types.ts";

const CLEAN: GitState = { worktreeExists: true, isMain: false, branch: "b", mainBranch: "master", head: "h1", dirty: 0, ignored: [], changed: [], submodules: 0, unpushed: 0, merged: true, base: "origin/master" };
const texts = (g: GitState | null | undefined) => gitCells(g).map((c) => c.text);

describe("cells", () => {
  test("the git column", () => {
    expect(texts(undefined)).toEqual(["…"]);
    expect(texts(null)).toEqual(["no checkout or branch"]);
    expect(texts({ ...CLEAN, isMain: true })).toEqual(["main checkout"]);
    expect(texts(CLEAN)).toEqual(["clean", "merged"]);
    expect(texts({ ...CLEAN, dirty: 2, unpushed: 1, merged: false })).toEqual(["2 dirty", "1 unpushed", "unmerged"]);
    expect(texts({ ...CLEAN, worktreeExists: false })).toEqual(["branch only", "clean", "merged"]);
    expect(texts({ ...CLEAN, ignored: [".env"] })).toEqual(["1 ignored", "merged"]);
    expect(texts({ ...CLEAN, submodules: 1 })).toEqual(["1 submodule", "merged"]);
    expect(texts({ ...CLEAN, statusError: "x" })).toEqual(["status?", "merged"]);
  });

  test("the state column", () => {
    expect(runCell("running", true)).toEqual({ text: "● running", color: "green" });
    expect(runCell("paused", true).text).toBe("◐ paused");
    expect(runCell("idle", true).text).toBe("○ idle");
    expect(runCell("idle", false).text).toBe("· no session");
  });

  test("the sort label and the page window", () => {
    expect(sortLabel("size", false)).toBe("size ↓");
    expect(sortLabel("created", true)).toBe("created ↑");
    expect(pageTop(0, 10, 4, 0)).toBe(0);
    expect(pageTop(5, 10, 4, 0)).toBe(2);
    expect(pageTop(3, 10, 4, 2)).toBe(2); // still on the page: the window stays
    expect(pageTop(1, 10, 4, 2)).toBe(1);
    expect(pageTop(0, 2, 4, 3)).toBe(0); // shrank under it
  });
});

const tmp = mkdtempSync(join(tmpdir(), "agendo-cleanup-disk-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("disk", () => {
  test("du measures a tree; a missing path is null", async () => {
    const d = join(tmp, "tree");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "f"), "x".repeat(10_000));
    expect(await diskUsage(d)).toBeGreaterThanOrEqual(8192);
    expect(await diskUsage(join(tmp, "missing"))).toBeNull();
  });

  test("the cache serves a fresh entry, expires an old one, and forgets what was invalidated", async () => {
    const d = join(tmp, "cached");
    mkdirSync(d, { recursive: true });
    const first = await cachedUsage(d, 1_000);
    writeFileSync(join(d, "big"), "x".repeat(200_000));
    expect(await cachedUsage(d, 2_000)).toBe(first);
    expect(await cachedUsage(d, 1_000 + 6 * 60_000)).toBeGreaterThan(first ?? 0);
    rmSync(join(d, "big"));
    invalidateUsage(tmp);
    expect(await cachedUsage(d)).toBeLessThan(200_000);
  });

  test("usageOf sums what exists, null when nothing does", async () => {
    const a = join(tmp, "ua");
    mkdirSync(a, { recursive: true });
    writeFileSync(join(a, "f"), "x");
    expect(await usageOf([a, join(tmp, "nope")])).toBeGreaterThan(0);
    expect(await usageOf([join(tmp, "nope")])).toBeNull();
    expect(await usageOf([])).toBeNull();
  });

  test("the managed worktrees are the directories directly under .claude/worktrees/, symlinks skipped", async () => {
    const repo = join(tmp, "repo");
    const wts = join(repo, ".claude", "worktrees");
    mkdirSync(join(wts, "one"), { recursive: true });
    writeFileSync(join(wts, "file"), "");
    symlinkSync(tmp, join(wts, "link"));
    const found = await listManagedWorktrees([repo, join(tmp, "no-repo")]);
    expect(found.map((w) => [w.path, w.repoRoot])).toEqual([[join(wts, "one"), repo]]);
  });

  test("the scratch root honours CLAUDE_CODE_TMPDIR", () => {
    const prev = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = "/scratch";
    expect(claudeTmpRoot()).toBe("/scratch");
    delete process.env.CLAUDE_CODE_TMPDIR;
    expect(claudeTmpRoot()).toBe(tmpdir());
    if (prev !== undefined) process.env.CLAUDE_CODE_TMPDIR = prev;
  });

  test("measureRow measures each part of a row", async () => {
    const wt = join(tmp, "m", ".claude", "worktrees", "w");
    mkdirSync(wt, { recursive: true });
    const log = join(tmp, "m", "sid.jsonl");
    writeFileSync(log, "{}\n");
    const session = { id: "sid", source: "claude", cwd: wt, title: "t", lastUsed: new Date(), logPath: log } as AgentSession;
    const row = { key: "k", session, worktree: wt } as CleanupRow;
    const sizes = await measureRow(row, join(tmp, "scratch"), 1);
    expect(sizes.worktree).toBeGreaterThanOrEqual(0);
    expect(sizes.transcript).toBeGreaterThan(0);
    expect(sizes.tmp).toBeNull();
    expect(await measureRow({ ...row, session: null, worktree: null }, tmp, 1)).toEqual({ worktree: null, transcript: null, tmp: null });
  });
});

describe("runPool", () => {
  test("runs every job with bounded concurrency, and stops once no longer alive", async () => {
    let inFlight = 0;
    let peak = 0;
    const ran: number[] = [];
    const job = (n: number) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      ran.push(n);
      inFlight--;
    };
    await runPool([1, 2, 3, 4, 5].map(job), 2, () => true);
    expect(ran.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    const stopped: number[] = [];
    await runPool([1, 2, 3].map((n) => async () => void stopped.push(n)), 1, () => stopped.length < 1);
    expect(stopped).toEqual([1]);
  });
});
