import { describe, expect, test } from "bun:test";
import type { Key } from "ink";
import { offersFor } from "../src/cleanup/classify.ts";
import { verdictOf } from "../src/cleanup/filter.ts";
import type { CleanupRow, GitState } from "../src/cleanup/types.ts";
import { cleanupKey, syncCursor, finishRun, handleCleanupModeKeys, INITIAL_CLEANUP, type CleanupEnv, type CleanupState } from "../src/ui/keys/cleanup.ts";
import type { AgentSession } from "../src/shared/types.ts";

const NONE = {} as Key;
const k = (over: Partial<Key>) => over as Key;
const session = { id: "s1", source: "claude", cwd: "/r/.claude/worktrees/a", title: "t", lastUsed: new Date(0), logPath: "/p/s1.jsonl" } as AgentSession;
const row = (key: string, over: Partial<CleanupRow> = {}): CleanupRow => ({
  key, title: key, session, repoRoot: "/r", worktree: "/r/.claude/worktrees/a", path: "/r/.claude/worktrees/a",
  branchHint: null, updated: new Date(0), created: new Date(0), run: "idle", ...over,
});
const CLEAN: GitState = { worktreeExists: true, isMain: false, branch: "worktree-a", mainBranch: "master", head: "h1", dirty: 0, ignored: [], changed: [], submodules: 0, unpushed: 0, merged: true, base: "origin/master" };

function envOf(rows: CleanupRow[], gits: Record<string, GitState | null | undefined>): CleanupEnv {
  return { rows, all: rows, offers: (r) => offersFor(r, gits[r.key]), git: (r) => gits[r.key], verdict: (r) => verdictOf(r, gits[r.key], offersFor(r, gits[r.key])) };
}

function press(state: CleanupState, env: CleanupEnv, ...keys: Array<string | Partial<Key>>) {
  let st = state;
  let effect = "none";
  for (const key of keys) {
    const step = typeof key === "string" ? cleanupKey(st, key, NONE, env) : cleanupKey(st, "", k(key), env);
    st = step.state;
    effect = step.effect;
  }
  return { state: st, effect };
}

describe("the mode guard", () => {
  test("takes every key in cleanup mode and none otherwise", () => {
    expect(handleCleanupModeKeys("x", NONE, { mode: { kind: "cleanup" } })).toBe(true);
    expect(handleCleanupModeKeys("x", NONE, { mode: { kind: "list" } })).toBe(false);
  });
});

describe("the list", () => {
  const env = envOf([row("a"), row("b")], { a: CLEAN, b: undefined });

  test("moves, clamps, sorts, reverses, leaves and quits", () => {
    expect(press(INITIAL_CLEANUP, env, { downArrow: true }, "j", "j").state.cursor).toBe(1);
    expect(press(INITIAL_CLEANUP, env, "k", { upArrow: true }).state.cursor).toBe(0);
    expect(press(INITIAL_CLEANUP, env, "s").state.sort).toBe("created");
    expect(press(INITIAL_CLEANUP, env, "s", "s", "s").state.sort).toBe("updated");
    expect(press({ ...INITIAL_CLEANUP, cursor: 1, focus: "b" }, env, "r").state).toMatchObject({ reversed: true, focus: "b" });
    expect(press(INITIAL_CLEANUP, env, "j").state).toMatchObject({ cursor: 1, focus: "b" });
    expect(press(INITIAL_CLEANUP, env, { escape: true }).effect).toBe("back");
    expect(press(INITIAL_CLEANUP, env, "q").effect).toBe("quit");
    expect(press(INITIAL_CLEANUP, env, "z").state).toBe(INITIAL_CLEANUP);
  });

  test("enter or space opens the dialog with the defaults; a row still being probed waits", () => {
    const opened = press(INITIAL_CLEANUP, env, { return: true }).state.dialog;
    expect(opened).toMatchObject({ key: "a", stage: "edit", sel: { worktree: true, branch: true, transcript: false, tmp: false } });
    expect(press(INITIAL_CLEANUP, env, " ").state.dialog?.key).toBe("a");
    const waiting = press(INITIAL_CLEANUP, env, "j", " ").state;
    expect(waiting.dialog).toBeNull();
    expect(waiting.note).toContain("still checking");
    expect(press(waiting, env, "z").state.note).toBeNull();
    expect(press(INITIAL_CLEANUP, envOf([], {}), { return: true }).state.dialog).toBeNull();
  });
});

describe("the dialog", () => {
  const env = envOf([row("a")], { a: CLEAN });
  const open = press(INITIAL_CLEANUP, env, { return: true }).state;

  test("moves between the boxes and toggles them", () => {
    const st = press(open, env, "j", "j", " ").state;
    expect(st.dialog).toMatchObject({ cursor: 2, sel: { transcript: true } });
    expect(press(st, env, " ").state.dialog?.sel.transcript).toBe(false);
    expect(press(open, env, "j", "j", "j", "j", "j").state.dialog?.cursor).toBe(3);
    expect(press(open, env, "z").state).toBe(open);
  });

  test("a disabled box can't be ticked, and says why", () => {
    const busy = envOf([row("a", { session: null })], { a: CLEAN });
    const st = press(press(INITIAL_CLEANUP, busy, { return: true }).state, busy, "j", "j", " ").state;
    expect(st.dialog?.sel.transcript).toBe(false);
    expect(st.dialog?.note).toBe("can't select transcript: no session");
  });

  test("a ticked box that went unavailable can still be unticked, but not ticked again", () => {
    const nowRunning = envOf([row("a", { run: "running" })], { a: CLEAN });
    const off = press(open, nowRunning, " ").state.dialog;
    expect(off?.sel.worktree).toBe(false);
    const again = press({ ...open, dialog: off ?? null }, nowRunning, " ").state.dialog;
    expect(again?.sel.worktree).toBe(false);
    expect(again?.note).toContain("can't select worktree");
  });

  test("enter on a safe selection runs at once; nothing selected says so", () => {
    expect(press(open, env, { return: true })).toMatchObject({ effect: "run", state: { dialog: { stage: "running", confirmed: false } } });
    const none = press(open, env, " ", "j", " ", { return: true });
    expect(none.effect).toBe("none");
    expect(none.state.dialog?.note).toBe("nothing selected");
  });

  test("a risky selection needs y; anything else goes back unharmed", () => {
    const risky = envOf([row("a")], { a: { ...CLEAN, dirty: 2 } });
    const st = press(INITIAL_CLEANUP, risky, { return: true }, " ", { return: true }).state;
    expect(st.dialog).toMatchObject({ stage: "confirm", git: { dirty: 2 } });
    expect(press(st, risky, "n").state.dialog).toMatchObject({ stage: "edit", note: "not deleted" });
    expect(press(st, risky, "y")).toMatchObject({ effect: "run", state: { dialog: { stage: "running", confirmed: true } } });
  });

  test("y re-checks the row as it is now: one that started running, or vanished, is not deleted", () => {
    const risky = envOf([row("a")], { a: { ...CLEAN, dirty: 2 } });
    const st = press(INITIAL_CLEANUP, risky, { return: true }, " ", { return: true }).state;
    const nowRunning = envOf([row("a", { run: "running" })], { a: { ...CLEAN, dirty: 2 } });
    const refused = press(st, nowRunning, "y");
    expect(refused.effect).toBe("none");
    expect(refused.state.dialog).toMatchObject({ stage: "edit", note: "worktree: session is running — pause or kill it first" });
    expect(press(st, envOf([], {}), "y")).toMatchObject({ effect: "none", state: { dialog: null } });
  });

  test("a row active moments ago opens with nothing ticked and needs y for anything", () => {
    const active = envOf([row("a", { active: true })], { a: CLEAN });
    const st = press(INITIAL_CLEANUP, active, { return: true }).state;
    expect(st.dialog?.sel).toEqual({ worktree: false, branch: false, transcript: false, tmp: false });
    expect(press(st, active, "j", "j", " ", { return: true }).state.dialog).toMatchObject({ stage: "confirm", activeShown: true });
  });

  test("a row that went active while the prompt sat open asks again, warning of it, before y counts", () => {
    const risky = envOf([row("a")], { a: { ...CLEAN, dirty: 2 } });
    const st = press(INITIAL_CLEANUP, risky, { return: true }, " ", { return: true }).state;
    expect(st.dialog).toMatchObject({ stage: "confirm", activeShown: false });
    const nowActive = envOf([row("a", { active: true })], { a: { ...CLEAN, dirty: 2 } });
    const asked = press(st, nowActive, "y");
    expect(asked).toMatchObject({ effect: "none", state: { dialog: { stage: "confirm", activeShown: true } } });
    expect(press(asked.state, nowActive, "y")).toMatchObject({ effect: "run", state: { dialog: { confirmed: true, activeShown: true } } });
  });

  test("an invalid selection explains itself", () => {
    const st = press(open, env, " ", { return: true }).state; // worktree off, branch still on
    expect(st.dialog?.note).toContain("select the worktree too");
  });

  test("esc closes the dialog; a row that vanished closes it too", () => {
    expect(press(open, env, { escape: true }).state.dialog).toBeNull();
    expect(press(open, envOf([], {}), "j").state.dialog).toBeNull();
  });

  test("the cursor follows its row through a re-sort, and is pulled back onto the list when rows go away", () => {
    const [a, b, c] = [row("a"), row("b"), row("c")];
    expect(syncCursor({ ...INITIAL_CLEANUP, cursor: 0, focus: "a" }, [b, c, a])).toMatchObject({ cursor: 2, focus: "a" });
    expect(syncCursor({ ...INITIAL_CLEANUP, cursor: 3, focus: "gone" }, [a, b])).toMatchObject({ cursor: 1, focus: "b" });
    expect(syncCursor({ ...INITIAL_CLEANUP, cursor: 3 }, [])).toMatchObject({ cursor: 0, focus: null });
    expect(syncCursor(INITIAL_CLEANUP, [a])).toMatchObject({ cursor: 0, focus: "a" });
    const st = { ...INITIAL_CLEANUP, cursor: 1, focus: "b" };
    expect(syncCursor(st, [a, b])).toBe(st);
  });

  test("running swallows keys; done shows the summary until a key, then refreshes", () => {
    const running = press(open, env, { return: true }).state;
    expect(press(running, env, { escape: true }).state).toBe(running);
    const done = finishRun(running, [{ ok: true, text: "removed" }]);
    expect(done.dialog).toMatchObject({ stage: "done", results: [{ ok: true, text: "removed" }] });
    expect(press(done, env, "x")).toMatchObject({ effect: "refresh", state: { dialog: null } });
    expect(finishRun(INITIAL_CLEANUP, [])).toBe(INITIAL_CLEANUP);
  });
});
