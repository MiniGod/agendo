// The profile picker's keys (src/ui/keys/profile.ts). The e2e suite opens the
// picker and picks the one other profile; it never steps the cursor over the
// session's own row, never wraps, never presses enter on that row, and never
// opens the picker on a session with nowhere to go.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { ClaudeProfile, ProfileChoice } from "../src/profiles.ts";
import type { AgentSession } from "../src/types.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { handleProfileKeys, nextProfileCursor, profileTargets } from "../src/ui/keys/profile.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
const profile = (name: string): ClaudeProfile => ({ configDir: `/p/${name}`, projects: `/p/${name}/projects`, name, realProjects: `/p/${name}/projects` });
const choice = (name: string, current = false): ProfileChoice => ({ profile: profile(name), current });
const session = { id: "s", source: "claude", cwd: "/w", title: "t", lastUsed: new Date(0) } as AgentSession;
const picker = (choices: ProfileChoice[], cursor: number): Mode => ({ kind: "profile", session, choices, cursor });
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), moveToProfile: mock() });
const updated = (ctx: ReturnType<typeof ctxIn>, prev: Mode): Mode => {
  const arg = ctx.setMode.mock.calls.at(-1)?.[0];
  expect(typeof arg).toBe("function");
  return (arg as (p: Mode) => Mode)(prev);
};
const three = [choice("a"), choice("b", true), choice("c")];

describe("profileTargets and nextProfileCursor", () => {
  test("the session's own row is skipped in both directions, wrapping", () => {
    const targets = profileTargets(three);
    expect(targets).toEqual([0, 2]);
    expect(nextProfileCursor(targets, 0, 1)).toBe(2);
    expect(nextProfileCursor(targets, 2, 1)).toBe(0);
    expect(nextProfileCursor(targets, 0, -1)).toBe(2);
    expect(nextProfileCursor(targets, 1, 1)).toBe(0);
    expect(profileTargets([choice("only", true)])).toEqual([]);
  });
});

describe("handleProfileKeys", () => {
  test("not its mode: unhandled", () => {
    expect(handleProfileKeys("j", key(), ctxIn({ kind: "list" }))).toBe(false);
  });

  test("escape closes it; nowhere to go swallows every key", () => {
    const esc = ctxIn(picker(three, 0));
    expect(handleProfileKeys("", key({ escape: true }), esc)).toBe(true);
    expect(esc.setMode).toHaveBeenCalledWith({ kind: "list" });
    const stuck = ctxIn(picker([choice("only", true)], 0));
    expect(handleProfileKeys("j", key(), stuck)).toBe(true);
    handleProfileKeys("", key({ return: true }), stuck);
    expect(stuck.setMode).not.toHaveBeenCalled();
    expect(stuck.moveToProfile).not.toHaveBeenCalled();
  });

  test("the steps move the cursor over the other profiles; enter moves the session, never onto its own row", () => {
    const down = ctxIn(picker(three, 0));
    handleProfileKeys("j", key(), down);
    expect(updated(down, picker(three, 0))).toEqual(picker(three, 2));
    expect(updated(down, { kind: "list" })).toEqual({ kind: "list" });
    const up = ctxIn(picker(three, 0));
    handleProfileKeys("", key({ upArrow: true }), up);
    expect(updated(up, picker(three, 0))).toEqual(picker(three, 2));
    const pick = ctxIn(picker(three, 2));
    handleProfileKeys("", key({ return: true }), pick);
    expect(pick.moveToProfile).toHaveBeenCalledWith(session, profile("c"));
    const own = ctxIn(picker(three, 1));
    handleProfileKeys("", key({ return: true }), own);
    expect(own.moveToProfile).not.toHaveBeenCalled();
    const swallowed = ctxIn(picker(three, 0));
    expect(handleProfileKeys("x", key(), swallowed)).toBe(true);
    expect(swallowed.setMode).not.toHaveBeenCalled();
  });
});
