// The worktree-or-main choice's keys (src/ui/keys/wtchoice.ts). The e2e suite
// takes the worktree row for a free session and the main-checkout row for an
// orchestrator; it never escapes back to the repo picker, never wraps the
// cursor, never opens the prompt for the main checkout, and never has an
// orchestrator worktree already in the repo for the seed to step past.
import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Key } from "ink";
import { ORCHESTRATOR_SLUG } from "../src/orchestrator.ts";
import type { RepoInfo } from "../src/repos.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { branchPrompt, branchSeed, chooseWorktree, handleWtchoiceKeys } from "../src/ui/keys/wtchoice.ts";
import type { FreshTarget } from "../src/ui/targets.ts";
import { worktreePath } from "../src/worktree.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
type Wtchoice = Extract<Mode, { kind: "wtchoice" }>;
/** Not a git repo, so no branch exists and only a worktree directory can take a name. */
const root = mkdtempSync(join(tmpdir(), "agendo-wtchoice-"));
const repo: RepoInfo = { root, name: "repo", total: 0, claude: 0, copilot: 0, codex: 0 };
const plain: FreshTarget = { tmuxName: "t", title: "t", kind: "free", defaultBranch: "", orchestrator: false };
const named: FreshTarget = { ...plain, defaultBranch: "feat" };
const orchestrator: FreshTarget = { ...plain, defaultBranch: ORCHESTRATOR_SLUG, orchestrator: true };
const choice = (target: FreshTarget, cursor: number): Wtchoice => ({ kind: "wtchoice", target, agent: "claude", repo, cursor });
const prompt = (target: FreshTarget, worktree: boolean, seed: string): Mode =>
  ({ kind: "branch", target, agent: "claude", repo, value: seed, cursor: seed.length, worktree, seed: seed || undefined });
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), startFresh: mock() });
/** What the updater `setMode` was last given makes of `prev`. */
const updated = (ctx: ReturnType<typeof ctxIn>, prev: Mode): Mode => {
  const arg = ctx.setMode.mock.calls.at(-1)?.[0];
  expect(typeof arg).toBe("function");
  return (arg as (p: Mode) => Mode)(prev);
};

describe("branchSeed", () => {
  test("a worktree takes the default name stepped past any worktree already holding it; the main checkout and a nameless session take it as-is", () => {
    expect(branchSeed(choice(named, 0), true)).toBe("feat");
    mkdirSync(worktreePath(root, "feat"), { recursive: true });
    expect(branchSeed(choice(named, 0), true)).toBe("feat-2");
    expect(branchSeed(choice(named, 1), false)).toBe("feat");
    expect(branchSeed(choice(plain, 0), true)).toBe("");
  });
});

describe("branchPrompt", () => {
  test("opens on the seed, cursor at its end, and remembers a non-empty seed", () => {
    expect(branchPrompt(choice(named, 0), true, "feat-3")).toEqual(prompt(named, true, "feat-3"));
    expect(branchPrompt(choice(plain, 1), false, "")).toEqual(prompt(plain, false, ""));
  });
});

describe("chooseWorktree", () => {
  test("an orchestrator in the main checkout launches at once; everything else opens the prompt", () => {
    const main = ctxIn(choice(orchestrator, 1));
    chooseWorktree(main, choice(orchestrator, 1));
    expect(main.startFresh).toHaveBeenCalledWith(orchestrator, repo, ORCHESTRATOR_SLUG, false, "claude");
    expect(main.setMode).not.toHaveBeenCalled();
    const wt = ctxIn(choice(orchestrator, 0));
    chooseWorktree(wt, choice(orchestrator, 0));
    expect(wt.startFresh).not.toHaveBeenCalled();
    expect(wt.setMode).toHaveBeenCalledWith(prompt(orchestrator, true, ORCHESTRATOR_SLUG));
    const plainMain = ctxIn(choice(plain, 1));
    chooseWorktree(plainMain, choice(plain, 1));
    expect(plainMain.setMode).toHaveBeenCalledWith(prompt(plain, false, ""));
  });
});

describe("handleWtchoiceKeys", () => {
  test("not its mode: unhandled", () => {
    expect(handleWtchoiceKeys("j", key(), ctxIn({ kind: "list" }))).toBe(false);
  });

  test("escape returns to the repo picker; the steps swap rows; enter chooses; the rest is swallowed", () => {
    const esc = ctxIn(choice(plain, 1));
    expect(handleWtchoiceKeys("", key({ escape: true }), esc)).toBe(true);
    expect(esc.setMode).toHaveBeenCalledWith({ kind: "repo", target: plain, agent: "claude", cursor: 0 });
    const up = ctxIn(choice(plain, 0));
    expect(handleWtchoiceKeys("k", key(), up)).toBe(true);
    expect(updated(up, choice(plain, 0))).toEqual(choice(plain, 1));
    expect(updated(up, { kind: "list" })).toEqual({ kind: "list" });
    const down = ctxIn(choice(plain, 1));
    handleWtchoiceKeys("", key({ downArrow: true }), down);
    expect(updated(down, choice(plain, 1))).toEqual(choice(plain, 0));
    const enter = ctxIn(choice(named, 1));
    expect(handleWtchoiceKeys("", key({ return: true }), enter)).toBe(true);
    expect(enter.setMode).toHaveBeenCalledWith(prompt(named, false, "feat"));
    const other = ctxIn(choice(named, 1));
    expect(handleWtchoiceKeys("x", key(), other)).toBe(true);
    expect(other.setMode).not.toHaveBeenCalled();
    expect(other.startFresh).not.toHaveBeenCalled();
  });
});
