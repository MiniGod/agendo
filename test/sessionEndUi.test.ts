// The list's `p` / `x` / `X` (src/ui/actions/sessionEnd.ts) and the y/n they put
// up (src/ui/keys/confirmEnd.ts): which rows the keys mean nothing on, the
// question each inspection asks, and the notice each outcome becomes. The e2e
// suite pauses and kills real fixture sessions; every wording arm a fixture
// can't cheaply reach — an error that no force lifts, a tab that never came
// back — is pinned here, where nothing reaches tmux.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { askStep, isPaused, killHovered, killQuestion, outcomeNotice, pauseHovered, rowLabel, rowRefusal } from "../src/ui/actions/sessionEnd.ts";
import { handleConfirmEndKeys } from "../src/ui/keys/confirmEnd.ts";
import { dispatchKey } from "../src/ui/keys/chain.ts";
import { keySeq } from "../src/ui/keys/keySeq.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import type { Row } from "../src/ui/models/rows.ts";
import type { AgentSession } from "../src/shared/types.ts";
import type { EndPlan, Refusal } from "../src/app/sessionEnd/index.ts";

const session = { id: "s1", source: "claude", cwd: "/w", title: "Fix login", lastUsed: new Date() } as AgentSession;
const sessRow = (running: boolean, placeholder = false): Row =>
  ({ kind: "session", key: "k", session, running, expanded: false, placeholder }) as Row;
const itemRow = { kind: "item" } as Row;
const prRow = { kind: "pr" } as Row;
const header: Row = { kind: "header", label: "h" };

const found = { s: session, sid: "s1", label: "s1" };
const refusal = (code: 1 | 2, screen?: string[]): Refusal => ({ kind: "refused", code, message: "m", reason: 'session looks "busy"', screen });
const plan = (placeholder = false, waived: string[] = []) => ({ kind: "plan", placeholder, waived }) as EndPlan;

describe("which rows the keys mean nothing on", () => {
  test("a non-session row is named in the notice", () => {
    expect([itemRow, prRow, header, undefined].map(rowLabel)).toEqual(["a work item", "a pull request", "not a session", "not a session"]);
    expect(rowRefusal(itemRow, "pause")).toBe("p pauses a running session — this row is a work item.");
    expect(rowRefusal(header, "kill")).toBe("x kills a running session — this row is not a session.");
  });

  test("a running session goes ahead; a paused tab can be killed but not paused; an idle one neither", () => {
    expect(rowRefusal(sessRow(true), "pause")).toBeNull();
    expect(rowRefusal(sessRow(true), "kill")).toBeNull();
    expect(rowRefusal(sessRow(false, true), "pause")).toBe("Fix login is already paused — enter wakes it.");
    expect(rowRefusal(sessRow(false, true), "kill")).toBeNull();
    expect(rowRefusal(sessRow(false), "pause")).toBe("Fix login isn't running — nothing to pause.");
    expect(rowRefusal(sessRow(false), "kill")).toBe("Fix login isn't running — nothing to kill.");
    expect(rowRefusal(sessRow(false), "pause", true)).toBe("Fix login is already paused — enter wakes it.");
  });

  test("paused is read off the model's placeholder set, whatever the row carries", () => {
    const model = { livePlaceholders: new Set(["cl-claude-s1"]) } as never;
    expect(isPaused({ model }, session)).toBe(true);
    expect(isPaused({ model: null }, session)).toBe(false);
  });

  test("p and x on such a row only say why, and never ask", () => {
    const ctx = { rows: [itemRow], cursor: 0, setNotice: mock(), setMode: mock(), reload: mock(), model: null };
    pauseHovered(ctx);
    killHovered(ctx, true);
    expect(ctx.setNotice.mock.calls).toEqual([
      ["p pauses a running session — this row is a work item."],
      ["x kills a running session — this row is a work item."],
    ]);
    expect(ctx.setMode).not.toHaveBeenCalled();
    expect(ctx.reload).not.toHaveBeenCalled();
  });
});

describe("the question a kill asks", () => {
  test("x asks only about a plan; X names every refusal it would force past, or that there is none", () => {
    expect(killQuestion(plan(), "Fix login", false)).toBe("Kill Fix login?");
    expect(killQuestion(plan(), "Fix login", true)).toBe("Nothing in flight — force kill Fix login?");
    expect(killQuestion(plan(true), "Fix login", true)).toBe("Close Fix login's paused tab for good?");
    expect(killQuestion(plan(false, ["window w is shared", 'session looks "busy"']), "Fix login", true)).toBe(
      'window w is shared; session looks "busy" — force kill Fix login?',
    );
    // A paused tab forced past an ambiguous name says so, rather than asking the plain question.
    expect(killQuestion(plan(true, ["2 live windows are named t"]), "Fix login", true)).toBe(
      "2 live windows are named t — force close Fix login's paused tab for good?",
    );
    expect(killQuestion(plan(true), "Fix login", false)).toBe("Close Fix login's paused tab for good?");
    expect(killQuestion(refusal(2), "Fix login", false)).toBeNull();
    expect(killQuestion(refusal(1), "Fix login", true)).toBeNull();
    expect(killQuestion({ kind: "notRunning", found }, "Fix login", true)).toBeNull();
  });
});

describe("what an inspection becomes once it is back", () => {
  test("a plan puts the question up, naming what X forces past", () => {
    expect(askStep(plan(false, ['session looks "busy"']), session, true, false)).toEqual({
      notice: null,
      mode: { kind: "confirmEnd", session, force: true, prompt: 'session looks "busy" — force kill Fix login?', waived: ['session looks "busy"'] },
    });
  });

  test("a key pressed while it was checked means no question — the next key must not answer it", () => {
    expect(askStep(plan(), session, false, true)).toEqual({ notice: "Not asked: keys were pressed while Fix login was checked — x asks again." });
    expect(askStep(plan(), session, true, true).mode).toBeUndefined();
  });

  test("anything but a plan is only a notice", () => {
    expect(askStep(refusal(2), session, false, false)).toEqual({ notice: 'Not killed: session looks "busy". X force-kills (asks first).' });
    expect(askStep({ kind: "notRunning", found }, session, true, false).mode).toBeUndefined();
  });
});

describe("the notice an outcome becomes", () => {
  test("refusals say why, and what overrides them when something does", () => {
    expect(outcomeNotice(refusal(2), "Fix login", "kill")).toBe('Not killed: session looks "busy". X force-kills (asks first).');
    expect(outcomeNotice(refusal(2), "Fix login", "kill", true)).toBe('Not killed: session looks "busy".');
    expect(outcomeNotice(refusal(2, ["screen"]), "Fix login", "pause")).toBe('Not paused: session looks "busy" — work is in flight.');
    // A forceable refusal that is not about the pane names only its own reason.
    expect(outcomeNotice(refusal(2), "Fix login", "pause")).toBe('Not paused: session looks "busy".');
    expect(outcomeNotice(refusal(1), "Fix login", "pause")).toBe('Not paused: session looks "busy".');
    const moved: Refusal = { kind: "refused", code: 1, message: "m", reason: "tmux renumbered its window while it was checked — nothing was killed, try again" };
    expect(outcomeNotice(moved, "Fix login", "kill")).toBe("Not killed: tmux renumbered its window while it was checked — nothing was killed, try again.");
    // A pause that ended the agent but not its tab is no "Not paused".
    const halfway: Refusal = { kind: "refused", code: 1, message: "m", reason: "ended t, but tmux did not take the paused tab", halfway: true };
    expect(outcomeNotice(halfway, "Fix login", "pause")).toBe(
      "Paused only halfway: ended t, but tmux did not take the paused tab — enter on its row resumes it.",
    );
  });

  test("the settled states and the two kinds of success", () => {
    const done = { kind: "done", found, target: "cl-wi-7", readiness: null } as const;
    expect(outcomeNotice({ kind: "notRunning", found }, "Fix login", "kill")).toBe("Fix login isn't running any more — nothing to end.");
    expect(outcomeNotice({ kind: "alreadyPaused", found, target: "t" }, "Fix login", "pause")).toBe("Fix login is already paused — enter wakes it.");
    expect(outcomeNotice({ ...done, action: "pause", placeholder: false }, "Fix login", "pause")).toBe(
      "⏸ paused Fix login — enter (or any key in its tab) wakes it.",
    );
    expect(outcomeNotice({ ...done, action: "close", placeholder: true }, "Fix login", "kill")).toBe(
      "✕ closed Fix login's paused tab — worktree, branch and transcript kept.",
    );
    expect(outcomeNotice({ ...done, action: "close", placeholder: false }, "Fix login", "kill")).toBe(
      "✕ killed Fix login — worktree, branch and transcript kept.",
    );
  });
});

describe("the y/n dialog", () => {
  const key = (k: Partial<Key>) => ({ escape: false, ...k }) as Key;
  const over = (mode: Mode) => ({ mode, setMode: mock(), setNotice: mock(), rows: [], cursor: 0, reload: mock(), model: null, exit: mock() });

  test("is not up outside its mode", () => {
    expect(handleConfirmEndKeys("y", key({}), over({ kind: "list" }))).toBe(false);
  });

  test("n, esc and q cancel and say nothing was ended; any other key is swallowed", () => {
    const mode: Mode = { kind: "confirmEnd", session, force: false, prompt: "Kill Fix login?", waived: [] };
    for (const [input, k] of [["n", {}], ["N", {}], ["q", {}], ["Q", {}], ["", { escape: true }]] as const) {
      const ctx = over(mode);
      expect(handleConfirmEndKeys(input, key(k), ctx)).toBe(true);
      expect(ctx.setMode.mock.calls).toEqual([[{ kind: "list" }]]);
      expect(ctx.setNotice.mock.calls).toEqual([["Kill cancelled — nothing was ended."]]);
    }
    const ctx = over(mode);
    expect(handleConfirmEndKeys("x", key({}), ctx)).toBe(true);
    expect(handleConfirmEndKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.setMode).not.toHaveBeenCalled();
    expect(ctx.setNotice).not.toHaveBeenCalled();
    expect(ctx.exit).not.toHaveBeenCalled();
  });

  test("ctrl-c still quits from under the question", () => {
    const ctx = over({ kind: "confirmEnd", session, force: true, prompt: "p", waived: [] });
    expect(handleConfirmEndKeys("c", key({ ctrl: true }), ctx)).toBe(true);
    expect(ctx.exit).toHaveBeenCalledTimes(1);
    expect(ctx.setMode).not.toHaveBeenCalled();
  });
});

describe("the key count a pending question is checked against", () => {
  test("every dispatched key counts, whether or not a handler takes it", () => {
    const before = keySeq();
    dispatchKey("a", {} as Key, {} as never, [() => true]);
    dispatchKey("b", {} as Key, {} as never, []);
    expect(keySeq()).toBe(before + 2);
  });
});
