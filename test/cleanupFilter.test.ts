import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { defaultSelection, offersFor, safeToRemove } from "../src/cleanup/classify.ts";
import { filterLabel, filterRows, matchesQuery, nextFilter, verdictOf, type Verdict } from "../src/cleanup/filter.ts";
import type { CleanupRow, GitState } from "../src/cleanup/types.ts";
import type { AgentSession } from "../src/shared/types.ts";
import { endRowsOf } from "../src/ui/hooks/useCleanupEnd.ts";
import { cleanupKey, INITIAL_CLEANUP, type CleanupEnv, type CleanupState } from "../src/ui/keys/cleanup.ts";

const NONE = {} as Key;
const session = { id: "s1", source: "claude", cwd: "/r/.claude/worktrees/a", title: "t", lastUsed: new Date(0), logPath: "/p/s1.jsonl" } as AgentSession;
const row = (key: string, over: Partial<CleanupRow> = {}): CleanupRow => ({
  key, title: key, session, repoRoot: "/r", worktree: `/r/.claude/worktrees/${key}`, path: `/r/.claude/worktrees/${key}`,
  branchHint: null, updated: new Date(0), created: new Date(0), run: "idle", ...over,
});
const CLEAN: GitState = { worktreeExists: true, isMain: false, branch: "worktree-a", mainBranch: "master", head: "h1", dirty: 0, ignored: [], changed: [], submodules: 0, unpushed: 0, merged: true, base: "origin/master" };

const verdict = (r: CleanupRow, git: GitState | null | undefined) => verdictOf(r, git, offersFor(r, git));

describe("safe to remove", () => {
  test("is exactly whether the dialog opens with the worktree or branch ticked", () => {
    const cases: Array<[CleanupRow, GitState | null | undefined]> = [
      [row("a"), CLEAN],
      [row("a"), undefined],
      [row("a"), null],
      [row("a"), { ...CLEAN, dirty: 1 }],
      [row("a", { active: true }), CLEAN],
      [row("a", { run: "running" }), CLEAN],
      [row("a", { worktree: null }), { ...CLEAN, worktreeExists: false }],
    ];
    for (const [r, git] of cases) {
      const offers = offersFor(r, git);
      const sel = defaultSelection(offers, git, r.active);
      expect(safeToRemove(offers, git, r.active)).toBe(sel.worktree || sel.branch);
    }
  });
});

describe("the verdict", () => {
  test("a clean, merged worktree is safe; a probe still running is pending, never safe", () => {
    expect(verdict(row("a"), CLEAN)).toBe("safe");
    expect(verdict(row("a"), undefined)).toBe("pending");
  });

  test("dirty, unpushed, unmerged, ignored files, submodules or an unreadable status put it at risk", () => {
    const risky: Array<Partial<GitState>> = [{ dirty: 1 }, { unpushed: 2 }, { merged: false }, { ignored: [".env"] }, { submodules: 1 }, { statusError: "boom" }];
    for (const over of risky) expect(verdict(row("a"), { ...CLEAN, ...over })).toBe("risk");
  });

  test("a running or just-written row is not safe, even when clean; at risk only if git says so", () => {
    expect(verdict(row("a", { run: "running" }), CLEAN)).toBe("other");
    expect(verdict(row("a", { active: true }), CLEAN)).toBe("other");
    expect(verdict(row("a", { run: "running" }), { ...CLEAN, dirty: 1 })).toBe("risk");
  });

  test("nothing to judge, or the main checkout, is neither", () => {
    expect(verdict(row("a"), null)).toBe("other");
    expect(verdict(row("a", { worktree: null }), { ...CLEAN, isMain: true, merged: false })).toBe("other");
  });
});

describe("the filter", () => {
  test("f cycles all → safe to remove → has something to lose → all", () => {
    expect(nextFilter("all")).toBe("safe");
    expect(nextFilter("safe")).toBe("risk");
    expect(nextFilter("risk")).toBe("all");
    expect([filterLabel("all"), filterLabel("safe"), filterLabel("risk")]).toEqual(["all", "safe to remove", "has something to lose"]);
  });

  test("/ matches title, branch or path, case-insensitively", () => {
    const r = row("a", { title: "Login Form", branchHint: "worktree-hint" });
    expect(matchesQuery(r, CLEAN, "")).toBe(true);
    expect(matchesQuery(r, CLEAN, " login ")).toBe(true);
    expect(matchesQuery(r, CLEAN, "WORKTREE-A")).toBe(true);
    expect(matchesQuery(r, undefined, "hint")).toBe(true);
    expect(matchesQuery(r, CLEAN, "worktrees/a")).toBe(true);
    expect(matchesQuery(r, CLEAN, "nope")).toBe(false);
    expect(matchesQuery(row("b", { title: "x" }), null, "worktree-")).toBe(false);
  });

  test("keeps the rows of the chosen verdict that match the text, in order", () => {
    const rows = [row("a"), row("b"), row("c"), row("d")];
    const v: Record<string, Verdict> = { a: "safe", b: "risk", c: "pending", d: "safe" };
    const of = (r: CleanupRow) => v[r.key];
    const keys = (rs: CleanupRow[]) => rs.map((r) => r.key);
    expect(keys(filterRows(rows, "all", "", of, () => CLEAN))).toEqual(["a", "b", "c", "d"]);
    expect(keys(filterRows(rows, "safe", "", of, () => CLEAN))).toEqual(["a", "d"]);
    expect(keys(filterRows(rows, "risk", "", of, () => CLEAN))).toEqual(["b"]);
    expect(keys(filterRows(rows, "safe", "/d", of, () => CLEAN))).toEqual(["d"]);
  });
});

function envOf(rows: CleanupRow[], all = rows): CleanupEnv {
  return { rows, all, offers: (r) => offersFor(r, CLEAN), git: () => CLEAN, verdict: (r) => verdict(r, CLEAN) };
}

function press(state: CleanupState, env: CleanupEnv, ...keys: Array<string | Partial<Key>>) {
  let st = state;
  let effect = "none";
  for (const key of keys) {
    const step = typeof key === "string" ? cleanupKey(st, key, NONE, env) : cleanupKey(st, "", key as Key, env);
    st = step.state;
    effect = step.effect;
  }
  return { state: st, effect };
}

describe("the keys", () => {
  const env = envOf([row("a"), row("b")]);

  test("f cycles the filter, keeping the focused row", () => {
    const st = { ...INITIAL_CLEANUP, cursor: 1, focus: "b" };
    expect(press(st, env, "f").state).toMatchObject({ filter: "safe", focus: "b" });
    expect(press(st, env, "f", "f", "f").state.filter).toBe("all");
  });

  test("/ types a text filter: letters are text, enter keeps it, esc drops it, arrows still move", () => {
    const typed = press(INITIAL_CLEANUP, env, "/", "q", "x", "s", { backspace: true });
    expect(typed).toMatchObject({ effect: "none", state: { typing: true, query: "qx" } });
    expect(press(typed.state, env, { downArrow: true }).state).toMatchObject({ cursor: 1, typing: true });
    expect(press(typed.state, env, { upArrow: true }).state.cursor).toBe(0);
    expect(press(typed.state, env, { ctrl: true })).toMatchObject({ state: { query: "qx" } });
    const kept = press(typed.state, env, { return: true }).state;
    expect(kept).toMatchObject({ typing: false, query: "qx" });
    expect(press(typed.state, env, { escape: true }).state).toMatchObject({ typing: false, query: "" });
    // Out of the prompt, esc drops the text before it leaves.
    const cleared = press(kept, env, { escape: true });
    expect(cleared).toMatchObject({ effect: "none", state: { query: "" } });
    expect(press(cleared.state, env, { escape: true }).effect).toBe("back");
  });

  test("p, x and X ask the screen to pause, kill or force-kill; with ctrl or meta they do nothing", () => {
    expect(press(INITIAL_CLEANUP, env, "p").effect).toBe("pause");
    expect(press(INITIAL_CLEANUP, env, "x").effect).toBe("kill");
    expect(press(INITIAL_CLEANUP, env, "X").effect).toBe("forceKill");
    expect(cleanupKey(INITIAL_CLEANUP, "x", { ctrl: true } as Key, env).effect).toBe("none");
    expect(press({ ...INITIAL_CLEANUP, typing: true }, env, "x").effect).toBe("none");
  });

  test("the dialog finds its row among every row, not only the ones the filter shows", () => {
    const open = press(INITIAL_CLEANUP, env, { return: true }).state;
    expect(open.dialog?.key).toBe("a");
    const hidden = envOf([row("b")], [row("a"), row("b")]);
    expect(press(open, hidden, "j").state.dialog).toMatchObject({ key: "a", cursor: 1 });
    expect(press(open, envOf([], []), "j").state.dialog).toBeNull();
  });
});

describe("a cleanup row as a session row", () => {
  test("carries its session, running and paused state; a worktree-only row is none", () => {
    expect(endRowsOf(row("a", { run: "running" }))).toMatchObject([{ kind: "session", key: "a", session, running: true, placeholder: false }]);
    expect(endRowsOf(row("a", { run: "paused" }))).toMatchObject([{ running: false, placeholder: true }]);
    expect(endRowsOf(row("a", { session: null }))).toEqual([]);
    expect(endRowsOf(undefined)).toEqual([]);
  });
});
