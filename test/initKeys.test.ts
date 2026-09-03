// The new-repo prompts' keys (src/ui/keys/init.ts). The e2e suite types a name,
// picks a parent from the list and creates the repo; it never escapes from the
// list back to the name, never wraps the list cursor, never opens the typed-path
// prompt and never comes back out of it either way.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { Mode } from "../src/ui/keys/context.ts";
import { backToName, handleInitKeys, nextInitCursor } from "../src/ui/keys/init.ts";
import type { FreshTarget } from "../src/ui/targets.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
type InitName = Extract<Mode, { kind: "initName" }>;
type InitDir = Extract<Mode, { kind: "initDir" }>;
type InitPath = Extract<Mode, { kind: "initPath" }>;
const target: FreshTarget = { tmuxName: "t", title: "t", kind: "free", defaultBranch: "main", orchestrator: false };
const name = (value: string, error?: string): InitName => ({ kind: "initName", target, agent: "claude", value, cursor: value.length, error });
const dir = (candidates: string[], cursor: number): InitDir =>
  ({ kind: "initDir", target, agent: "claude", name: "proj", candidates, cursor, error: "e", existing: "/x" });
const path = (candidates: string[], value: string): InitPath =>
  ({ kind: "initPath", target, agent: "claude", name: "proj", candidates, value, cursor: value.length, error: "e", existing: "/x" });
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), beginInitDir: mock(), beginInit: mock() });
/** What the updater `setMode` was last given makes of `prev`. */
const updated = (ctx: ReturnType<typeof ctxIn>, prev: Mode): Mode => {
  const arg = ctx.setMode.mock.calls.at(-1)?.[0];
  expect(typeof arg).toBe("function");
  return (arg as (p: Mode) => Mode)(prev);
};

describe("nextInitCursor", () => {
  test("wraps over the candidates plus the Other row", () => {
    expect(nextInitCursor(2, 0, -1)).toBe(2);
    expect(nextInitCursor(2, 2, 1)).toBe(0);
    expect(nextInitCursor(0, 0, 1)).toBe(0);
  });
});

describe("handleInitKeys", () => {
  test("not its mode: unhandled", () => {
    expect(handleInitKeys("x", key(), ctxIn({ kind: "list" }))).toBe(false);
  });

  test("name: escape returns to the repo picker, enter needs a name, typing edits and clears the error", () => {
    const esc = ctxIn(name("proj"));
    expect(handleInitKeys("", key({ escape: true }), esc)).toBe(true);
    expect(esc.setMode).toHaveBeenCalledWith({ kind: "repo", target, agent: "claude", cursor: 0 });
    const blank = ctxIn(name("  "));
    handleInitKeys("", key({ return: true }), blank);
    expect(blank.beginInitDir).not.toHaveBeenCalled();
    const enter = ctxIn(name("proj"));
    handleInitKeys("", key({ return: true }), enter);
    expect(enter.beginInitDir).toHaveBeenCalledWith(target, "claude", "proj");
    const typed = ctxIn(name("pro", "taken"));
    handleInitKeys("j", key(), typed);
    expect(updated(typed, name("pro", "taken"))).toEqual(name("proj"));
    expect(updated(typed, { kind: "list" })).toEqual({ kind: "list" });
    const noop = ctxIn(name("pro"));
    handleInitKeys("", key({ tab: true }), noop);
    expect(updated(noop, name("pro", "taken"))).toEqual(name("pro", "taken"));
  });

  test("list: escape goes back to the name, the steps wrap and forget the row, enter picks or opens the prompt", () => {
    const esc = ctxIn(dir(["/a", "/b"], 1));
    handleInitKeys("", key({ escape: true }), esc);
    expect(esc.setMode).toHaveBeenCalledWith(name("proj"));
    const up = ctxIn(dir(["/a", "/b"], 0));
    handleInitKeys("k", key(), up);
    expect(updated(up, dir(["/a", "/b"], 0))).toEqual({ ...dir(["/a", "/b"], 2), error: undefined, existing: undefined });
    const down = ctxIn(dir(["/a", "/b"], 2));
    handleInitKeys("", key({ downArrow: true }), down);
    expect(updated(down, dir(["/a", "/b"], 2))).toEqual({ ...dir(["/a", "/b"], 0), error: undefined, existing: undefined });
    expect(updated(down, { kind: "list" })).toEqual({ kind: "list" });
    const pick = ctxIn(dir(["/a", "/b"], 1));
    handleInitKeys("", key({ return: true }), pick);
    expect(pick.beginInit).toHaveBeenCalledWith(dir(["/a", "/b"], 1), "/b");
    const other = ctxIn(dir(["/a", "/b"], 2));
    handleInitKeys("", key({ return: true }), other);
    expect(other.setMode).toHaveBeenCalledWith({ ...path(["/a", "/b"], ""), error: undefined, existing: undefined });
    const swallowed = ctxIn(dir(["/a"], 0));
    expect(handleInitKeys("x", key(), swallowed)).toBe(true);
    expect(swallowed.setMode).not.toHaveBeenCalled();
  });

  test("typed path: escape returns to the list's Other row, or to the name when there was no list", () => {
    const list = ctxIn(path(["/a", "/b"], "/c"));
    handleInitKeys("", key({ escape: true }), list);
    expect(list.setMode).toHaveBeenCalledWith({ kind: "initDir", target, agent: "claude", name: "proj", candidates: ["/a", "/b"], cursor: 2 });
    const first = ctxIn(path([], "/c"));
    handleInitKeys("", key({ escape: true }), first);
    expect(first.setMode).toHaveBeenCalledWith(name("proj"));
    expect(backToName(path([], "/c"))).toEqual(name("proj"));
  });

  test("typed path: enter needs a value, typing edits and forgets the row", () => {
    const blank = ctxIn(path([], " "));
    handleInitKeys("", key({ return: true }), blank);
    expect(blank.beginInit).not.toHaveBeenCalled();
    const enter = ctxIn(path([], "/c"));
    handleInitKeys("", key({ return: true }), enter);
    expect(enter.beginInit).toHaveBeenCalledWith(path([], "/c"), "/c");
    const typed = ctxIn(path([], "/"));
    handleInitKeys("c", key(), typed);
    expect(updated(typed, path([], "/"))).toEqual({ ...path([], "/c"), error: undefined, existing: undefined });
    expect(updated(typed, { kind: "list" })).toEqual({ kind: "list" });
    const noop = ctxIn(path([], "/"));
    handleInitKeys("", key({ tab: true }), noop);
    expect(updated(noop, path([], "/"))).toEqual(path([], "/"));
  });
});
