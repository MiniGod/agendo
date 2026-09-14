// The agent picker's keys (src/ui/keys/agent.ts). The e2e suite drives it
// through a real fresh/orchestrator flow; this covers the pure choice-filtering
// and cursor arithmetic the picker leans on, including the one thing e2e can't
// cheaply prove for every combination: that Copilot never appears for an
// orchestrator target, no matter what else is set on it.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { AGENT_CHOICES, agentChoicesFor, handleAgentKeys } from "../src/ui/keys/agent.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import type { FreshTarget } from "../src/ui/models/targets.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
const target = (orchestrator = false): FreshTarget => ({ tmuxName: "t", title: "t", kind: "free", defaultBranch: "main", orchestrator });
const picker = (cursor: number, orchestrator = false): Mode => ({ kind: "agent", target: target(orchestrator), cursor });
const ctxIn = (mode: Mode) => ({
  mode, setMode: mock(), setCloneNote: mock(), cloneNoteRef: { current: "✓ cloned x" as string | null }, proceedFresh: mock(),
});

describe("agentChoicesFor", () => {
  test("an ordinary target offers all three agents", () => {
    expect(agentChoicesFor(target())).toBe(AGENT_CHOICES);
  });

  test("an orchestrator target drops Copilot — it has no --append-system-prompt equivalent", () => {
    const choices = agentChoicesFor(target(true));
    expect(choices.map((c) => c.source)).toEqual(["claude", "codex"]);
  });
});

describe("handleAgentKeys", () => {
  test("not its mode: untouched and unhandled", () => {
    const ctx = ctxIn({ kind: "list" });
    expect(handleAgentKeys("j", key(), ctx)).toBe(false);
    expect(ctx.setMode).not.toHaveBeenCalled();
  });

  test("escape drops the clone note and returns to the list", () => {
    const ctx = ctxIn(picker(0));
    expect(handleAgentKeys("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.setCloneNote).toHaveBeenCalledWith(null);
    expect(ctx.cloneNoteRef.current).toBeNull();
    expect(ctx.setMode).toHaveBeenCalledWith({ kind: "list" });
  });

  test("up/down (and vi keys) wrap the cursor over the offered choices, not the full list", () => {
    // Orchestrator target: only 2 choices (Claude, Codex), so wrap happens at 2,
    // not at AGENT_CHOICES.length (3) — a stale length here would let the cursor
    // land on the filtered-out Copilot row.
    const ctx = ctxIn(picker(1, true));
    handleAgentKeys("", key({ downArrow: true }), ctx);
    const update = ctx.setMode.mock.calls[0][0] as (m: Mode) => Mode;
    expect(update(picker(1, true))).toEqual(picker(0, true));
    expect(update({ kind: "list" })).toEqual({ kind: "list" });
  });

  test("k/up steps back, wrapping past the top", () => {
    const ctx = ctxIn(picker(0, true));
    handleAgentKeys("k", key(), ctx);
    const update = ctx.setMode.mock.calls[0][0] as (m: Mode) => Mode;
    expect(update(picker(0, true))).toEqual(picker(1, true));
  });

  test("enter proceeds with the choice under the cursor, respecting the same filtering", () => {
    const ctx = ctxIn(picker(1, true)); // orchestrator: index 1 is Codex, not Copilot
    expect(handleAgentKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.proceedFresh).toHaveBeenCalledWith(target(true), "codex");
  });

  test("an unrecognized key is still swallowed", () => {
    const ctx = ctxIn(picker(0));
    expect(handleAgentKeys("x", key(), ctx)).toBe(true);
    expect(ctx.proceedFresh).not.toHaveBeenCalled();
  });
});
