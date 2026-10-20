import { describe, expect, test } from "bun:test";
import {
  boxLabel, defaultSelection, emptySelection, isRisky, lossLines, needsConfirm, offersFor, riskGrew, selectionProblem,
} from "../src/cleanup/classify.ts";
import type { CleanupRow, GitState } from "../src/cleanup/types.ts";
import type { AgentSession } from "../src/shared/types.ts";

const WT = "/r/.claude/worktrees/x";
const session = { id: "s1", source: "claude", cwd: WT, title: "t", lastUsed: new Date(0), logPath: "/p/s1.jsonl" } as AgentSession;
const row = (over: Partial<CleanupRow> = {}): CleanupRow => ({
  key: "k", title: "t", session, repoRoot: "/r", worktree: WT, path: WT, branchHint: null,
  updated: new Date(0), created: new Date(0), run: "idle", ...over,
});
const CLEAN: GitState = {
  worktreeExists: true, isMain: false, branch: "worktree-x", mainBranch: "master", head: "h1",
  dirty: 0, ignored: [], changed: [], submodules: 0, unpushed: 0, merged: true, base: "origin/master",
};

describe("offersFor", () => {
  test("an idle session in a clean worktree offers everything", () => {
    const o = offersFor(row(), CLEAN);
    expect(Object.values(o).every((x) => x.enabled)).toBe(true);
  });

  test("a running session offers nothing, and says to pause or kill it", () => {
    const o = offersFor(row({ run: "running" }), CLEAN);
    expect(Object.values(o).every((x) => !x.enabled && x.reason?.includes("pause or kill"))).toBe(true);
  });

  test("another running session in the same worktree blocks the worktree and branch only", () => {
    const o = offersFor(row(), CLEAN, true);
    expect(o.worktree.reason).toContain("a running session uses");
    expect(o.branch.enabled).toBe(false);
    expect(o.transcript.enabled).toBe(true);
  });

  test("the worktree box: unmanaged, still probing, gone, the main checkout", () => {
    expect(offersFor(row({ worktree: null }), CLEAN).worktree.reason).toContain(".claude/worktrees");
    expect(offersFor(row(), undefined).worktree.reason).toBe("checking…");
    expect(offersFor(row(), null).worktree.reason).toBe("no worktree on disk");
    expect(offersFor(row(), { ...CLEAN, worktreeExists: false }).worktree.enabled).toBe(false);
    expect(offersFor(row(), { ...CLEAN, isMain: true }).worktree.reason).toContain("main checkout");
  });

  test("the branch box: probing, detached, the main checkout's, the default branch", () => {
    expect(offersFor(row(), undefined).branch.reason).toBe("checking…");
    expect(offersFor(row(), { ...CLEAN, branch: null }).branch.reason).toBe("no branch");
    expect(offersFor(row(), { ...CLEAN, branch: "master" }).branch.reason).toContain("main checkout");
    expect(offersFor(row(), { ...CLEAN, isMain: true }).branch.enabled).toBe(false);
    expect(offersFor(row(), { ...CLEAN, branch: "master", mainBranch: "dev" }).branch.reason).toBe("the default branch");
    expect(offersFor(row(), { ...CLEAN, base: null }).branch.enabled).toBe(true);
  });

  test("the transcript and tmp boxes need a session; tmp needs a claude one", () => {
    const bare = offersFor(row({ session: null }), CLEAN);
    expect(bare.transcript.reason).toBe("no session");
    expect(bare.tmp.reason).toBe("no session");
    expect(offersFor(row({ session: { ...session, logPath: undefined } }), CLEAN).transcript.enabled).toBe(false);
    // A log whose name doesn't carry the id is not offered: the run would refuse it anyway.
    expect(offersFor(row({ session: { ...session, logPath: "/p/other.jsonl" } }), CLEAN).transcript).toEqual({ enabled: false, reason: "its transcript can't be told apart safely" });
    expect(offersFor(row({ session: { ...session, source: "codex" } }), CLEAN).tmp.reason).toContain("codex");
  });
});

describe("defaults and risk", () => {
  test("a clean, pushed, merged checkout starts with the worktree and branch ticked, the session kept", () => {
    expect(defaultSelection(offersFor(row(), CLEAN), CLEAN)).toEqual({ worktree: true, branch: true, transcript: false, tmp: false });
  });

  test("anything at stake — or no probe — starts with nothing ticked", () => {
    for (const g of [{ ...CLEAN, dirty: 1 }, { ...CLEAN, unpushed: 2 }, { ...CLEAN, merged: false }]) {
      expect(defaultSelection(offersFor(row(), g), g)).toEqual(emptySelection());
    }
    expect(defaultSelection(offersFor(row(), null), null)).toEqual(emptySelection());
  });

  test("a disabled box never starts ticked", () => {
    expect(defaultSelection(offersFor(row({ run: "running" }), CLEAN), CLEAN)).toEqual(emptySelection());
  });

  test("lossLines names every risk, with counts", () => {
    expect(lossLines(CLEAN)).toEqual([]);
    const blind = { ...CLEAN, statusError: "fatal: index file corrupt" };
    expect(lossLines(blind)).toEqual(["unknown local changes — git status failed: fatal: index file corrupt"]);
    expect(isRisky(blind)).toBe(true);
    expect(riskGrew(CLEAN, blind)).toBe(true);
    expect(lossLines({ ...CLEAN, submodules: 2 })).toEqual(["2 checked-out submodules, whose own work is not checked"]);
    expect(isRisky({ ...CLEAN, submodules: 1 })).toBe(true);
    expect(riskGrew({ ...CLEAN, submodules: 1 }, { ...CLEAN, submodules: 2 })).toBe(true);
    expect(lossLines(null)).toEqual([]);
    expect(lossLines({ ...CLEAN, dirty: 1, unpushed: 1, merged: false })).toEqual([
      "1 dirty file (uncommitted or untracked)",
      "1 unpushed commit",
      "branch not merged into origin/master",
    ]);
    expect(lossLines({ ...CLEAN, dirty: 3, unpushed: 2 })).toEqual(["3 dirty files (uncommitted or untracked)", "2 unpushed commits"]);
    expect(lossLines({ ...CLEAN, merged: false, base: null })[0]).toContain("no origin default branch");
  });

  test("the second confirmation is needed only for a risky worktree or branch", () => {
    const risky = { ...CLEAN, dirty: 1 };
    expect(needsConfirm({ ...emptySelection(), worktree: true }, risky)).toBe(true);
    expect(needsConfirm({ ...emptySelection(), branch: true }, { ...CLEAN, merged: false })).toBe(true);
    expect(needsConfirm({ ...emptySelection(), transcript: true }, risky)).toBe(false);
    expect(needsConfirm({ ...emptySelection(), worktree: true }, CLEAN)).toBe(false);
    expect(isRisky(CLEAN)).toBe(false);
  });

  test("ignored files are at stake: nothing starts ticked, they are named, and deleting needs the confirmation", () => {
    const g = { ...CLEAN, ignored: [".env", "notes/", "a", "b"] };
    expect(isRisky(g)).toBe(true);
    expect(defaultSelection(offersFor(row(), g), g)).toEqual(emptySelection());
    expect(lossLines(g)).toEqual(["4 ignored files git would not keep (.env, notes/, a, …)"]);
    expect(lossLines({ ...CLEAN, ignored: [".env"] })).toEqual(["1 ignored file git would not keep (.env)"]);
    expect(needsConfirm({ ...emptySelection(), worktree: true }, g)).toBe(true);
    expect(riskGrew(CLEAN, { ...CLEAN, ignored: [".env"] })).toBe(true);
    expect(riskGrew(g, { ...CLEAN, ignored: [".env"] })).toBe(false);
  });

  test("a session written to moments ago may be running outside agendo: nothing starts ticked, anything needs the confirmation", () => {
    expect(defaultSelection(offersFor(row(), CLEAN), CLEAN, true)).toEqual(emptySelection());
    expect(needsConfirm({ ...emptySelection(), transcript: true }, CLEAN, true)).toBe(true);
    expect(needsConfirm(emptySelection(), CLEAN, true)).toBe(false);
    expect(needsConfirm({ ...emptySelection(), worktree: true }, CLEAN, false)).toBe(false);
  });

  test("riskGrew refuses a different branch or HEAD even when nothing else changed", () => {
    expect(riskGrew(CLEAN, { ...CLEAN, branch: "worktree-y" })).toBe(true);
    expect(riskGrew(CLEAN, { ...CLEAN, head: "h2" })).toBe(true);
  });

  test("riskGrew sees a different file behind the same count", () => {
    const one = { ...CLEAN, dirty: 1, changed: ["scratch.txt"], ignored: [".env"] };
    expect(riskGrew(one, { ...one, changed: ["important.txt"] })).toBe(true);
    expect(riskGrew(one, { ...one, ignored: ["prod.env"] })).toBe(true);
    expect(riskGrew(one, { ...one, dirty: 0, changed: [], submodules: 0, ignored: [] })).toBe(false);
    expect(riskGrew(one, one)).toBe(false);
  });

  test("a branch checked out in a worktree the view can't remove is not offered either", () => {
    const outside = offersFor(row({ worktree: null, path: "/elsewhere/feat" }), CLEAN);
    expect(outside.worktree.enabled).toBe(false);
    expect(outside.branch).toEqual({ enabled: false, reason: "checked out in a worktree that can't be removed here" });
    expect(defaultSelection(outside, CLEAN)).toEqual(emptySelection());
    // Once the checkout is gone, its branch alone can go.
    expect(offersFor(row({ worktree: null }), { ...CLEAN, worktreeExists: false }).branch.enabled).toBe(true);
  });

  test("riskGrew compares the fresh probe against the confirmed one", () => {
    expect(riskGrew(CLEAN, CLEAN)).toBe(false);
    expect(riskGrew(CLEAN, { ...CLEAN, dirty: 1 })).toBe(true);
    expect(riskGrew({ ...CLEAN, dirty: 2 }, { ...CLEAN, dirty: 1 })).toBe(false);
    expect(riskGrew(CLEAN, { ...CLEAN, unpushed: 1 })).toBe(true);
    expect(riskGrew(CLEAN, { ...CLEAN, merged: false })).toBe(true);
    expect(riskGrew(null, CLEAN)).toBe(false);
    expect(riskGrew(undefined, { ...CLEAN, dirty: 1 })).toBe(true);
  });
});

describe("selectionProblem", () => {
  const offers = offersFor(row(), CLEAN);
  test("nothing selected, a disabled box, a branch still checked out in its worktree", () => {
    expect(selectionProblem(emptySelection(), offers, CLEAN)).toBe("nothing selected");
    expect(selectionProblem({ ...emptySelection(), tmp: true }, offersFor(row({ session: null }), CLEAN), CLEAN)).toBe("tmp/scratch files: no session");
    expect(selectionProblem({ ...emptySelection(), branch: true }, offers, CLEAN)).toContain("select the worktree too");
    expect(selectionProblem({ ...emptySelection(), branch: true }, offers, { ...CLEAN, worktreeExists: false })).toBeNull();
    expect(selectionProblem({ ...emptySelection(), worktree: true, branch: true }, offers, CLEAN)).toBeNull();
  });

  test("labels", () => {
    expect(boxLabel("transcript")).toBe("session transcript");
  });
});
