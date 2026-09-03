// The identity picker's keys (src/ui/keys/identity.ts). The e2e suite opens
// the picker from settings and picks a teammate; it never escapes back to the
// list it can also be opened from, never wraps the cursor, never picks the
// signed-in user back (which clears the override), and never sees an empty
// roster or a cursor past the end of one.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { LoadedModel } from "../src/model.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { handleIdentityKeys, identityBack, pickIdentity, stepIdentity } from "../src/ui/keys/identity.ts";
import type { Identity } from "../src/types.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
const me: Identity = { id: "me", displayName: "Me", uniqueName: "me@example.test" };
const ann: Identity = { id: "ann", displayName: "Ann", uniqueName: "ann@example.test" };
const model = { me } as unknown as LoadedModel;
const picker = (cursor: number, fromSettings?: boolean): Mode => ({ kind: "identity", cursor, fromSettings });
const ctxIn = (mode: Mode, roster: Identity[] = [me, ann], loaded: LoadedModel | null = model) =>
  ({ mode, roster, model: loaded, setMode: mock(), setIdentity: mock(), persist: mock(), setCursor: mock() });
/** What the updater `setMode` was last given makes of `prev`. */
const updated = (ctx: ReturnType<typeof ctxIn>, prev: Mode): Mode => {
  const arg = ctx.setMode.mock.calls.at(-1)?.[0];
  expect(typeof arg).toBe("function");
  return (arg as (p: Mode) => Mode)(prev);
};

describe("identityBack", () => {
  test("settings when opened from there, else the list", () => {
    expect(identityBack({ kind: "identity", cursor: 1, fromSettings: true })).toEqual({ kind: "settings", cursor: 0 });
    expect(identityBack({ kind: "identity", cursor: 1 })).toEqual({ kind: "list" });
  });
});

describe("stepIdentity", () => {
  test("wraps both ways over the roster and leaves any other mode alone", () => {
    expect(stepIdentity(3, -1)(picker(0))).toEqual(picker(2));
    expect(stepIdentity(3, 1)(picker(2))).toEqual(picker(0));
    expect(stepIdentity(3, 1)(picker(0))).toEqual(picker(1));
    expect(stepIdentity(3, 1)({ kind: "list" })).toEqual({ kind: "list" });
  });
});

describe("pickIdentity", () => {
  test("a teammate becomes the override; the signed-in user clears it; both land on the list", () => {
    const pick = ctxIn(picker(1));
    pickIdentity(pick, 1);
    expect(pick.setIdentity).toHaveBeenCalledWith(ann);
    expect(pick.persist).toHaveBeenCalledWith({ identity: ann });
    expect(pick.setCursor).toHaveBeenCalledWith(0);
    expect(pick.setMode).toHaveBeenCalledWith({ kind: "list" });
    const self = ctxIn(picker(0));
    pickIdentity(self, 0);
    expect(self.setIdentity).toHaveBeenCalledWith(null);
    expect(self.persist).toHaveBeenCalledWith({ identity: null });
  });

  test("with no model loaded the pick stands as-is; a cursor past the roster picks nothing but still leaves", () => {
    const unloaded = ctxIn(picker(0), [me, ann], null);
    pickIdentity(unloaded, 0);
    expect(unloaded.setIdentity).toHaveBeenCalledWith(me);
    const past = ctxIn(picker(5));
    pickIdentity(past, 5);
    expect(past.setIdentity).not.toHaveBeenCalled();
    expect(past.persist).not.toHaveBeenCalled();
    expect(past.setMode).toHaveBeenCalledWith({ kind: "list" });
  });
});

describe("handleIdentityKeys", () => {
  test("not its mode: unhandled", () => {
    expect(handleIdentityKeys("j", key(), ctxIn({ kind: "list" }))).toBe(false);
  });

  test("escape goes back; an empty roster swallows everything else", () => {
    const esc = ctxIn(picker(1, true));
    expect(handleIdentityKeys("", key({ escape: true }), esc)).toBe(true);
    expect(esc.setMode).toHaveBeenCalledWith({ kind: "settings", cursor: 0 });
    const empty = ctxIn(picker(0), []);
    expect(handleIdentityKeys("", key({ return: true }), empty)).toBe(true);
    expect(handleIdentityKeys("j", key(), empty)).toBe(true);
    expect(empty.setMode).not.toHaveBeenCalled();
    expect(empty.setIdentity).not.toHaveBeenCalled();
  });

  test("the steps wrap, enter picks, and any other key is swallowed", () => {
    const up = ctxIn(picker(0));
    expect(handleIdentityKeys("k", key(), up)).toBe(true);
    expect(updated(up, picker(0))).toEqual(picker(1));
    const down = ctxIn(picker(1));
    handleIdentityKeys("", key({ downArrow: true }), down);
    expect(updated(down, picker(1))).toEqual(picker(0));
    const enter = ctxIn(picker(1));
    handleIdentityKeys("", key({ return: true }), enter);
    expect(enter.setIdentity).toHaveBeenCalledWith(ann);
    expect(enter.setMode).toHaveBeenCalledWith({ kind: "list" });
    const other = ctxIn(picker(1));
    expect(handleIdentityKeys("x", key(), other)).toBe(true);
    expect(other.setMode).not.toHaveBeenCalled();
  });
});
