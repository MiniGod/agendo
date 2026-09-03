// The repo picker's keys (src/ui/keys/repo.ts). The e2e suite opens the picker,
// walks it, and picks a repo, the clone row and the new-repo row; it never
// escapes out of the orchestrator flow's picker (the exit that also drops a
// clone note), never moves the cursor after the mode has changed underneath
// the updater, and never presses enter on an empty list.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { RepoInfo } from "../src/repos.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import type { FreshTarget } from "../src/ui/targets.ts";
import { CLONE_ROW, handleRepoKeys, INIT_ROW, nextRepoCursor, repoAction, repoOrder } from "../src/ui/keys/repo.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
const target = (orchestrator = false): FreshTarget => ({ tmuxName: "t", title: "t", kind: "free", defaultBranch: "main", orchestrator });
const repo = (name: string): RepoInfo => ({ root: `/r/${name}`, name, total: 0, claude: 0, copilot: 0, codex: 0 });
const picker = (cursor: number, orchestrator = false): Mode => ({ kind: "repo", target: target(orchestrator), agent: "claude", cursor });
const ctxIn = (mode: Mode, repos: RepoInfo[], canClone = true) => ({
  mode, canClone, setMode: mock(), setCloneNote: mock(), cloneNoteRef: { current: "✓ cloned x" as string | null },
  reposForTarget: mock(() => repos), chooseRepo: mock(),
});

describe("repoAction", () => {
  test("escape, the arrows and their vi twins, the letters, and enter by row", () => {
    expect(repoAction("", key({ escape: true }), 0, true, true)).toBe("back");
    expect(repoAction("", key({ upArrow: true }), 0, true, true)).toBe("up");
    expect(repoAction("k", key(), 0, true, true)).toBe("up");
    expect(repoAction("", key({ downArrow: true }), 0, true, true)).toBe("down");
    expect(repoAction("j", key(), 0, true, true)).toBe("down");
    expect(repoAction("c", key(), 0, true, true)).toBe("clone");
    expect(repoAction("c", key(), 0, false, true)).toBe("none");
    expect(repoAction("i", key(), 0, false, true)).toBe("init");
    expect(repoAction("", key({ return: true }), CLONE_ROW, true, false)).toBe("clone");
    expect(repoAction("", key({ return: true }), CLONE_ROW, false, false)).toBe("none");
    expect(repoAction("", key({ return: true }), INIT_ROW, false, false)).toBe("init");
    expect(repoAction("", key({ return: true }), 0, true, true)).toBe("choose");
    expect(repoAction("", key({ return: true }), 0, true, false)).toBe("none");
    expect(repoAction("x", key(), 0, true, true)).toBe("none");
  });
});

describe("repoOrder and nextRepoCursor", () => {
  test("the repos, the clone row when on offer, the new-repo row always; an empty list still has one slot", () => {
    expect(repoOrder(2, true)).toEqual([0, 1, CLONE_ROW, INIT_ROW]);
    expect(repoOrder(2, false)).toEqual([0, 1, INIT_ROW]);
    expect(repoOrder(0, false)).toEqual([0, INIT_ROW]);
  });
  test("steps wrap through the order, and an unknown cursor steps from the top", () => {
    const order = repoOrder(2, true);
    expect(nextRepoCursor(order, 1, 1)).toBe(CLONE_ROW);
    expect(nextRepoCursor(order, INIT_ROW, 1)).toBe(0);
    expect(nextRepoCursor(order, 0, -1)).toBe(INIT_ROW);
    expect(nextRepoCursor(order, 42, -1)).toBe(INIT_ROW);
    expect(nextRepoCursor(order, 42, 1)).toBe(1);
  });
});

describe("handleRepoKeys", () => {
  const repos = [repo("a"), repo("b")];

  test("not its mode: untouched and unhandled", () => {
    const ctx = ctxIn({ kind: "list" }, repos);
    expect(handleRepoKeys("j", key(), ctx)).toBe(false);
    expect(ctx.setMode).not.toHaveBeenCalled();
  });

  test("escape from the plain flow goes back to the agent step and keeps the clone note", () => {
    const ctx = ctxIn(picker(1), repos);
    expect(handleRepoKeys("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.setMode).toHaveBeenCalledWith({ kind: "agent", target: target(), cursor: 0 });
    expect(ctx.setCloneNote).not.toHaveBeenCalled();
    expect(ctx.cloneNoteRef.current).toBe("✓ cloned x");
  });

  test("escape from the orchestrator flow is the last exit: the clone note goes, and so does the picker", () => {
    const ctx = ctxIn(picker(1, true), repos);
    expect(handleRepoKeys("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.setCloneNote).toHaveBeenCalledWith(null);
    expect(ctx.cloneNoteRef.current).toBeNull();
    expect(ctx.setMode).toHaveBeenCalledWith({ kind: "list" });
  });

  test("a move is an updater that walks the order and leaves a mode that is no longer the picker alone", () => {
    const ctx = ctxIn(picker(1), repos);
    handleRepoKeys("j", key(), ctx);
    const update = ctx.setMode.mock.calls[0][0] as (m: Mode) => Mode;
    expect(update(picker(1))).toEqual(picker(CLONE_ROW));
    expect(update({ kind: "list" })).toEqual({ kind: "list" });
  });

  test("enter on a repo chooses it and drops the clone note; on the action rows it opens them; a swallowed key is still handled", () => {
    const ctx = ctxIn(picker(1), repos);
    expect(handleRepoKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.chooseRepo).toHaveBeenCalledWith(target(), repos[1], "claude");
    expect(ctx.setCloneNote).toHaveBeenCalledWith(null);
    expect(ctx.cloneNoteRef.current).toBeNull();
    const onClone = ctxIn(picker(CLONE_ROW), repos);
    handleRepoKeys("", key({ return: true }), onClone);
    expect(onClone.setMode).toHaveBeenCalledWith({ kind: "clone", target: target(), agent: "claude", value: "", cursor: 0 });
    const onInit = ctxIn(picker(INIT_ROW), repos, false);
    handleRepoKeys("i", key(), onInit);
    expect(onInit.setMode).toHaveBeenCalledWith({ kind: "initName", target: target(), agent: "claude", value: "", cursor: 0 });
    const empty = ctxIn(picker(0), []);
    expect(handleRepoKeys("", key({ return: true }), empty)).toBe(true);
    expect(empty.chooseRepo).not.toHaveBeenCalled();
    expect(empty.setMode).not.toHaveBeenCalled();
  });
});
