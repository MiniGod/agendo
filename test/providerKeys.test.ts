// The backend picker's keys (src/ui/keys/provider.ts). The e2e suite opens the
// picker and picks a backend; it never wraps the cursor at either end, presses
// a key the picker swallows, or closes it back into Settings. Every arm sits
// beside the one next to it, on a context of mocks — the same shape as the
// settings keys' test, because the picker is the same shape as that page.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { PROVIDER_INFO } from "../src/provider.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { handleProviderKeys, moveProviderCursor, providerAction, providerBack } from "../src/ui/keys/provider.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });
const picker = (cursor: number, fromSettings?: boolean): Mode => ({ kind: "provider", cursor, fromSettings });
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), applyProvider: mock() });

describe("the parts", () => {
  test("what each key does; anything else is swallowed", () => {
    expect(providerAction("", key({ escape: true }))).toBe("close");
    expect(providerAction("", key({ upArrow: true }))).toBe("up");
    expect(providerAction("k", NONE)).toBe("up");
    expect(providerAction("", key({ downArrow: true }))).toBe("down");
    expect(providerAction("j", NONE)).toBe("down");
    expect(providerAction("", key({ return: true }))).toBe("activate");
    expect(providerAction("q", NONE)).toBeNull();
    expect(providerAction("", key({ tab: true }))).toBeNull();
  });

  test("the cursor wraps at both ends, and the updater leaves any other mode alone", () => {
    expect(moveProviderCursor(-1, 3)(picker(0))).toEqual(picker(2));
    expect(moveProviderCursor(1, 3)(picker(2))).toEqual(picker(0));
    expect(moveProviderCursor(1, 3)(picker(0, true))).toEqual(picker(1, true));
    const list: Mode = { kind: "list" };
    expect(moveProviderCursor(1, 3)(list)).toBe(list);
  });

  test("closing goes back to where the picker was opened from", () => {
    expect(providerBack(true)).toEqual({ kind: "settings", cursor: 0 });
    expect(providerBack(false)).toEqual({ kind: "list" });
    expect(providerBack(undefined)).toEqual({ kind: "list" });
  });
});

describe("handleProviderKeys", () => {
  test("declines every key when the picker is not up", () => {
    const c = ctxIn({ kind: "list" });
    expect(handleProviderKeys("", key({ escape: true }), c)).toBe(false);
    expect(c.setMode).not.toHaveBeenCalled();
  });

  test("escape closes, the arrows move, enter applies the backend under the cursor; the rest is swallowed", () => {
    const c = ctxIn(picker(1, true));
    expect(handleProviderKeys("", key({ escape: true }), c)).toBe(true);
    expect(c.setMode).toHaveBeenLastCalledWith({ kind: "settings", cursor: 0 });
    expect(handleProviderKeys("j", NONE, c)).toBe(true);
    expect((c.setMode.mock.calls.at(-1)![0] as (p: Mode) => Mode)(picker(1, true))).toEqual(picker(2 % PROVIDER_INFO.length, true));
    expect(handleProviderKeys("", key({ return: true }), c)).toBe(true);
    expect(c.applyProvider).toHaveBeenCalledWith(PROVIDER_INFO[1]!.name, { kind: "settings", cursor: 0 });
    expect(handleProviderKeys("x", NONE, c)).toBe(true);
    expect(c.setMode).toHaveBeenCalledTimes(2);
  });
});
