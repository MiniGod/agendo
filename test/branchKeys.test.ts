// The new-branch / session-name prompt (src/ui/keys/branch.ts) on the shared
// line-edit table. The e2e suite types a name and presses enter or escape on
// a work-item target; it never reaches the free-target escape, the caret
// moves, a rejected control chunk, or the unbound ^U.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { branchEdit, branchEditFor, handleBranchKeys, rejectControls } from "../src/ui/keys/branch.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { clearLine } from "../src/ui/keys/lineEdit.ts";
import { deleteCharBefore, moveLeft, toStart } from "../src/ui/keys/searchEdit.ts";

const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });

type BranchMode = Extract<Mode, { kind: "branch" }>;
const repo = { path: "/r", name: "r" };
const branch = { kind: "branch", target: { kind: "item" }, agent: "claude", repo, value: "ab", cursor: 2, worktree: true, seed: "s" } as unknown as BranchMode;
const free = { ...branch, target: { kind: "free" } } as unknown as BranchMode;
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), startFresh: mock() });

describe("branch prompt edits", () => {
  test("a chunk holding a control character is rejected whole, never stripped", () => {
    expect(rejectControls("þ")).toBe("þ");
    expect(rejectControls("[200~hi\x1b[201~")).toBe("");
  });

  test("the shared table minus ^U", () => {
    expect(branchEditFor("", key({ leftArrow: true }))).toBe(moveLeft);
    expect(branchEditFor("a", key({ ctrl: true }))).toBe(toStart);
    expect(branchEditFor("", key({ delete: true }))).toBe(deleteCharBefore);
    expect(branchEditFor("u", key({ ctrl: true }))).toBeNull();
    expect(branchEditFor("x", key({ ctrl: true }))).toBeNull();
    expect(branchEditFor("a\n", NONE)).toBeNull();
    expect(branchEditFor("þ", NONE)!("a", 1)).toEqual({ text: "aþ", cursor: 2 });
  });

  test("an edit is a functional update, and a no-op off the prompt", () => {
    expect(branchEdit(clearLine)(branch)).toEqual({ ...branch, value: "", cursor: 0 });
    const other = { kind: "list" } as Mode;
    expect(branchEdit(clearLine)(other)).toBe(other);
  });
});

describe("handleBranchKeys", () => {
  test("declines off the branch prompt", () => {
    const ctx = ctxIn({ kind: "list" } as Mode);
    expect(handleBranchKeys("x", NONE, ctx as any)).toBe(false);
    expect(ctx.setMode).not.toHaveBeenCalled();
  });

  test("esc returns a free target to the worktree choice, on the row it came from; any other target to the repo list", () => {
    const wt = ctxIn(free);
    expect(handleBranchKeys("", key({ escape: true }), wt as any)).toBe(true);
    expect(wt.setMode.mock.calls).toEqual([[{ kind: "wtchoice", target: { kind: "free" }, agent: "claude", repo, cursor: 0 }]]);
    const checkout = ctxIn({ ...free, worktree: false });
    handleBranchKeys("", key({ escape: true }), checkout as any);
    expect(checkout.setMode.mock.calls[0][0]).toMatchObject({ kind: "wtchoice", cursor: 1 });
    const item = ctxIn(branch);
    handleBranchKeys("", key({ escape: true }), item as any);
    expect(item.setMode.mock.calls).toEqual([[{ kind: "repo", target: { kind: "item" }, agent: "claude", cursor: 0 }]]);
  });

  test("enter starts the session with the name as typed, or nothing on a blank one", () => {
    const go = ctxIn({ ...branch, value: " n " });
    expect(handleBranchKeys("", key({ return: true }), go as any)).toBe(true);
    expect(go.startFresh.mock.calls).toEqual([[{ kind: "item" }, repo, " n ", true, "claude", "s"]]);
    const blank = ctxIn({ ...branch, value: " " });
    expect(handleBranchKeys("", key({ return: true }), blank as any)).toBe(true);
    expect(blank.startFresh).not.toHaveBeenCalled();
  });

  test("an edit goes through setMode; a rejected chunk, ^U and an unbound chord are swallowed untouched", () => {
    const typed = ctxIn(branch);
    expect(handleBranchKeys("þ", NONE, typed as any)).toBe(true);
    expect((typed.setMode.mock.calls[0][0] as (p: Mode) => Mode)(branch)).toEqual({ ...branch, value: "abþ", cursor: 3 });
    for (const [input, k] of [["a\n", NONE], ["u", key({ ctrl: true })], ["x", key({ meta: true })]] as const) {
      const ctx = ctxIn(branch);
      expect(handleBranchKeys(input, k, ctx as any)).toBe(true);
      expect(ctx.setMode).not.toHaveBeenCalled();
    }
  });
});
