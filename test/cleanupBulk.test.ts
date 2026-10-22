import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { pausedTabIn, runBulk, touchedBy, type BulkCheck, type BulkStep } from "../src/cleanup/bulk.ts";
import { offersFor } from "../src/cleanup/classify.ts";
import type { CleanupPlan, CleanupResult } from "../src/cleanup/execute.ts";
import { verdictOf } from "../src/cleanup/filter.ts";
import type { CleanupRow, GitState } from "../src/cleanup/types.ts";
import type { AgentSession } from "../src/shared/types.ts";
import { cleanupKey, INITIAL_CLEANUP, type CleanupEnv, type CleanupState } from "../src/ui/keys/cleanup.ts";
import { bulkDone, bulkKey, bulkScrolls, bulkStepped, openBulk } from "../src/ui/keys/cleanupBulk.ts";

const NONE = {} as Key;
const session = { id: "s1", source: "claude", cwd: "/r/.claude/worktrees/a", title: "t", lastUsed: new Date(0), logPath: "/p/s1.jsonl" } as AgentSession;
const row = (key: string, over: Partial<CleanupRow> = {}): CleanupRow => ({
  key, title: `T${key}`, session, repoRoot: "/r", worktree: `/r/.claude/worktrees/${key}`, path: `/r/.claude/worktrees/${key}`,
  branchHint: null, updated: new Date(0), created: new Date(0), run: "idle", ...over,
});
const CLEAN: GitState = { worktreeExists: true, isMain: false, branch: "worktree-a", mainBranch: "master", head: "h1", dirty: 0, ignored: [], changed: [], submodules: 0, unpushed: 0, merged: true, base: "origin/master" };

describe("runBulk", () => {
  const plan = (key: string) => ({ row: row(key) }) as CleanupPlan;

  test("runs every row in order, one at a time, skipping and carrying on past failures", async () => {
    const order: string[] = [];
    let inFlight = 0;
    const checks: Record<string, BulkCheck> = {
      a: { title: "A", plan: plan("a") },
      b: { title: "B", skip: "skipped — no longer safe to remove" },
      c: { title: "C", plan: plan("c") },
      d: { title: "D", plan: plan("d") },
      e: { title: "E", plan: plan("e") },
    };
    const results: Record<string, () => Promise<CleanupResult[]>> = {
      a: async () => [{ ok: true, text: "removed worktree" }, { ok: true, text: "deleted branch" }],
      c: async () => [{ ok: true, text: "removed worktree" }, { ok: false, text: "branch: refused" }],
      d: async () => { throw new Error("boom"); },
      e: async () => [{ ok: true, text: "removed worktree" }],
    };
    const seen: BulkStep[] = [];
    const steps = await runBulk(["a", "b", "c", "d", "e"], {
      check: async (k) => checks[k],
      execute: async (p) => {
        expect(++inFlight).toBe(1);
        order.push(p.row.key);
        await new Promise((r) => setTimeout(r, 1));
        try {
          return await results[p.row.key]();
        } finally {
          inFlight--;
        }
      },
      onStep: (s) => seen.push(s),
    });
    expect(order).toEqual(["a", "c", "d", "e"]);
    expect(steps.map((s) => s.outcome)).toEqual(["removed", "skipped", "failed", "failed", "removed"]);
    expect(steps[1].lines).toEqual([{ ok: false, text: "skipped — no longer safe to remove" }]);
    expect(steps[3].lines).toEqual([{ ok: false, text: "boom" }]);
    expect(seen).toEqual(steps);
  });

  test("a check that throws fails that row and the run carries on", async () => {
    const steps = await runBulk(["a", "b"], {
      check: async (k) => {
        if (k === "a") throw new Error("probe died");
        return { title: "B", plan: plan("b") };
      },
      execute: async () => [{ ok: true, text: "removed worktree" }],
      onStep: () => {},
    });
    expect(steps.map((s) => [s.outcome, s.lines[0].text])).toEqual([["failed", "probe died"], ["removed", "removed worktree"]]);
  });
});

describe("pausedTabIn", () => {
  test("is the row itself paused, or a paused row of the same repo in its worktree", () => {
    const paused = row("a", { run: "paused" });
    const mate = row("b", { worktree: paused.worktree });
    expect(pausedTabIn(paused, [paused])).toBe(true);
    expect(pausedTabIn(mate, [paused, mate])).toBe(true);
    expect(pausedTabIn(mate, [mate, row("c", { run: "paused" })])).toBe(false);
    expect(pausedTabIn(mate, [{ ...paused, repoRoot: "/other" }, mate])).toBe(false);
    expect(pausedTabIn(row("d", { worktree: null }), [row("e", { worktree: null, run: "paused" })])).toBe(false);
    // A paused pane in the checkout, whose session is no row, counts too.
    expect(pausedTabIn(mate, [mate], ["/r/.claude/worktrees/a/sub"])).toBe(true);
    expect(pausedTabIn(mate, [mate], ["/r/.claude/worktrees/ab"])).toBe(false);
  });
});

describe("touchedBy", () => {
  test("is the deleted rows and the rows of the same repo sharing a checkout or a branch — nothing else", () => {
    const gone = row("a");
    const sameWorktree = row("a2", { worktree: gone.worktree });
    const sameBranch = row("b");
    const otherRepo = row("c", { repoRoot: "/other", worktree: gone.worktree });
    const untouched = row("d");
    const hinted = row("e", { branchHint: "worktree-a" });
    const gits: Record<string, GitState | null | undefined> = {
      a: CLEAN, a2: CLEAN, b: { ...CLEAN, branch: "worktree-a" }, c: CLEAN, d: { ...CLEAN, branch: "worktree-d" }, e: null,
    };
    const all = [gone, sameWorktree, sameBranch, otherRepo, untouched, hinted];
    expect(touchedBy([gone], all, (r) => gits[r.key]).sort()).toEqual(["a", "a2", "b", "e"]);
    // A row with no branch and no checkout matches nothing but itself.
    const bare = row("f", { worktree: null });
    expect(touchedBy([bare], [...all, bare], () => null)).toEqual(["f"]);
  });
});

describe("the bulk dialog", () => {
  const rows = [row("a"), row("b"), row("c")];

  test("y runs; ↑/↓ scroll a list that does not fit, only as far as its last page; any other key cancels", () => {
    const b = openBulk(rows);
    expect(bulkKey(b, "y", NONE, 2)).toMatchObject({ effect: "runAll", bulk: { stage: "running" } });
    expect(bulkKey(b, "Y", NONE, 2).effect).toBe("runAll");
    expect(bulkKey(b, "j", NONE, 2).bulk?.top).toBe(1);
    expect(bulkKey({ ...b, top: 1 }, "", { downArrow: true } as Key, 2).bulk?.top).toBe(1);
    expect(bulkKey({ ...b, top: 1 }, "k", NONE, 2).bulk?.top).toBe(0);
    expect(bulkKey(b, "", { upArrow: true } as Key, 2).bulk?.top).toBe(0);
    expect(bulkKey(b, "n", NONE, 2)).toEqual({ bulk: null, effect: "cancel" });
    // A list that fits has nothing to scroll: an arrow is any other key.
    expect(bulkScrolls(b, 3)).toBe(false);
    expect(bulkKey(b, "j", NONE, 3)).toEqual({ bulk: null, effect: "cancel" });
  });

  test("running swallows keys; done scrolls, then any key closes and re-measures", () => {
    const running = { ...openBulk(rows), stage: "running" as const };
    expect(bulkKey(running, "n", NONE)).toEqual({ bulk: running, effect: "none" });
    const step: BulkStep = { key: "a", title: "Ta", outcome: "removed", lines: [] };
    const stepped = bulkStepped(running, step);
    expect(stepped.steps).toEqual([step]);
    const done = bulkDone({ ...bulkStepped(stepped, { ...step, key: "b" }), top: 1 });
    expect(done).toMatchObject({ stage: "done", top: 0 });
    expect(bulkKey(done, "j", NONE).bulk?.top).toBe(1);
    expect(bulkKey(done, "x", NONE)).toEqual({ bulk: null, effect: "refresh" });
    // A summary that fits closes on an arrow too, as its "press any key" says.
    expect(bulkKey(done, "j", NONE, 2)).toEqual({ bulk: null, effect: "refresh" });
  });
});

describe("the list's D, R and enter", () => {
  const gits: Record<string, GitState | undefined> = { a: CLEAN, b: { ...CLEAN, dirty: 1 }, c: CLEAN, p: undefined };
  const envOf = (rows: CleanupRow[]): CleanupEnv => ({
    rows, all: rows, offers: (r) => offersFor(r, gits[r.key]), git: (r) => gits[r.key], verdict: (r) => verdictOf(r, gits[r.key], offersFor(r, gits[r.key])),
  });
  const press = (st: CleanupState, env: CleanupEnv, input: string, key: Partial<Key> = {}) => cleanupKey(st, input, key as Key, env);

  test("D asks about every shown row that is safe to remove, and only those", () => {
    const st = press(INITIAL_CLEANUP, envOf([row("a"), row("b"), row("c"), row("p")]), "D").state;
    expect(st.bulk?.rows.map((r) => r.key)).toEqual(["a", "c"]);
    expect(st.bulk?.stage).toBe("confirm");
    const cancelled = press(st, envOf([]), "n");
    expect(cancelled).toMatchObject({ effect: "none", state: { bulk: null, note: "nothing deleted" } });
    expect(press(st, envOf([]), "y")).toMatchObject({ effect: "runAll", state: { bulk: { stage: "running" } } });
  });

  test("a key during the run leaves the state untouched, so it can't write over progress landing meanwhile", () => {
    const st = press(INITIAL_CLEANUP, envOf([row("a")]), "D").state;
    const running = press(st, envOf([]), "y").state;
    for (const k of ["n", "D", "x"]) expect(press(running, envOf([]), k)).toEqual({ state: running, effect: "none" });
  });

  test("D with nothing safe says so, and says when rows are still being checked", () => {
    expect(press(INITIAL_CLEANUP, envOf([row("b")]), "D").state).toMatchObject({ bulk: null, note: "nothing shown is safe to remove" });
    expect(press(INITIAL_CLEANUP, envOf([row("b"), row("p")]), "D").state.note).toContain("still being checked");
  });

  test("D leaves paused tabs out, and says so when they are all that is safe", () => {
    const st = press(INITIAL_CLEANUP, envOf([row("a", { run: "paused" }), row("c")]), "D").state;
    expect(st.bulk?.rows.map((r) => r.key)).toEqual(["c"]);
    const only = press(INITIAL_CLEANUP, envOf([row("a", { run: "paused" })]), "D").state;
    expect(only).toMatchObject({ bulk: null, note: expect.stringContaining("paused") });
    // An idle row in the worktree a paused tab uses is left out too.
    const shared = [row("a", { run: "paused" }), row("b", { worktree: "/r/.claude/worktrees/a" }), row("c")];
    expect(press(INITIAL_CLEANUP, envOf(shared), "D").state.bulk?.rows.map((r) => r.key)).toEqual(["c"]);
  });

  test("R re-scans everything", () => {
    expect(press(INITIAL_CLEANUP, envOf([row("a")]), "R").effect).toBe("rescan");
  });

  test("enter switches to a running or paused session; space, and enter elsewhere, open the dialog", () => {
    for (const run of ["running", "paused"] as const) {
      const env = envOf([row("a", { run })]);
      expect(press(INITIAL_CLEANUP, env, "", { return: true }).effect).toBe("switch");
      expect(press(INITIAL_CLEANUP, env, " ").state.dialog?.key).toBe("a");
    }
    expect(press(INITIAL_CLEANUP, envOf([row("a")]), "", { return: true }).state.dialog?.key).toBe("a");
    // A row with no session of its own has nothing to switch to: enter cleans it up.
    const bare = press(INITIAL_CLEANUP, envOf([row("a", { run: "running", session: null })]), "", { return: true });
    expect(bare).toMatchObject({ effect: "none", state: { dialog: { key: "a" } } });
  });
});
