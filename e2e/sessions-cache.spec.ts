// The transcript-parse cache in src/sessions.ts. The background rescan rebuilds
// the session index every ~2s; without this cache each build re-reads + JSON-
// parses every transcript on disk (the user's corpus is ~500 MB), pegging a CPU
// core. The cache mtime+size-gates the per-file parse so a rebuild only re-reads
// the FEW files that changed.
//
// os.homedir() is read once at process start, so a fixture corpus can't be tested
// in this worker — we spawn a child (cacheDriver.ts) with HOME pointed at a
// throwaway dir and assert on the parse counts it reports. The cache is module
// state, so all scenarios run in that ONE child across successive builds.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";

test("transcript parse cache: hit / invalidation / new file / prune", () => {
  const home = mkdtempSync(join(tmpdir(), "agendo-cache-"));
  try {
    const r = spawnSync("bun", [join(REPO_ROOT, "e2e", "harness", "cacheDriver.ts")], {
      // HOME must be set from the child's start so os.homedir() resolves to it.
      env: { ...process.env, HOME: home },
      encoding: "utf-8",
    });
    expect(r.status, `driver stderr:\n${r.stderr}`).toBe(0);
    const out = JSON.parse(r.stdout) as {
      build1: { sessions: number; parses: number; titleA: string };
      build2: { parses: number };
      build3: { parses: number; titleA: string };
      build4: { parses: number; hasD: boolean };
      build5: { parses: number; hasB: boolean; cacheSize: number };
    };

    // Cold build parses all three transcripts.
    expect(out.build1.sessions).toBe(3);
    expect(out.build1.parses).toBe(3);
    expect(out.build1.titleA).toBe("Alpha");

    // CACHE HIT: an unchanged rebuild re-parses nothing — the core proof.
    expect(out.build2.parses).toBe(0);

    // INVALIDATION: the one changed file is re-parsed and its new content shows.
    expect(out.build3.parses).toBe(1);
    expect(out.build3.titleA).toBe("Alpha v2");

    // NEW FILE: parsed on the next build (not hidden by the cache) and visible.
    expect(out.build4.parses).toBe(1);
    expect(out.build4.hasD).toBe(true);

    // DELETE: the session is gone, unchanged files still 0 re-parses, and the
    // cache entry is pruned (4 files seen, then 1 deleted → 3 cached).
    expect(out.build5.hasB).toBe(false);
    expect(out.build5.parses).toBe(0);
    expect(out.build5.cacheSize).toBe(3);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// `agendo wait` is the notification path an orchestrator leaves running for
// minutes at a time. It must ride the ONE cached index build it does up front and
// add no transcript work per tick — a second scanner on this loop is the primary
// way to reintroduce the CPU burn the cache exists to prevent.
//
// Counting parses over an untouched corpus would prove nothing (the cache serves
// 0 misses either way), so the driver changes a transcript WHILE the wait polls.
// Any per-tick rebuild would miss the cache on that file and re-parse it.
test("agendo wait adds no transcript parsing beyond its one cached build", async ({ mock }) => {
  const report = join(mock.tmpDir, "wait-driver.json");
  const r = spawnSync("bun", [join(REPO_ROOT, "e2e", "harness", "waitPollDriver.ts")], {
    env: { ...mock.env, WAIT_DRIVER_REPORT: report },
    cwd: REPO_ROOT,
    encoding: "utf-8",
    timeout: 60_000,
  });
  expect(r.status, `driver stderr:\n${r.stderr}`).toBe(0);
  const out = JSON.parse(readFileSync(report, "utf-8")) as {
    code: number;
    coldSessions: number;
    coldParses: number;
    waitParses: number;
    mutated: boolean;
    reparsesAfter: number;
  };

  // The wait itself settled (busy → ready) rather than timing out.
  expect(out.code).toBe(0);
  // The up-front build did real work, so "0 during the wait" isn't vacuous.
  expect(out.coldSessions).toBeGreaterThan(0);
  expect(out.coldParses).toBeGreaterThan(0);

  // THE CORE ASSERTION: the whole poll loop re-parsed nothing.
  expect(out.waitParses).toBe(0);

  // …and the zero is real: the transcript really was rewritten mid-wait, and a
  // genuine rebuild afterwards does re-parse it. So the loop skipped the file
  // because it never scanned, not because the counter was stuck.
  expect(out.mutated).toBe(true);
  expect(out.reparsesAfter).toBe(1);
});
