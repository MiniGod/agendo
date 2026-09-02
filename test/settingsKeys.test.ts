// The settings page's keys (src/ui/keys/settings.ts). The e2e suite opens the
// page, moves once and toggles auto-resume; it never wraps the cursor at
// either end, presses a key the page swallows, or enters the provider and
// identity pickers from here. Every arm sits beside the one next to it, on a
// context of mocks.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { Mode } from "../src/ui/keys/context.ts";
import {
  activateSetting, handleSettingsKeys, moveSettingsCursor, settingsAction, toggleAutoResume,
} from "../src/ui/keys/settings.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });
const settings = (cursor: number): Mode => ({ kind: "settings", cursor });
const ctxIn = (mode: Mode) => ({
  mode,
  setMode: mock(),
  settingsItems: ["provider", "identity", "autoResume"] as Array<"provider" | "identity" | "autoResume">,
  enterProvider: mock(),
  enterIdentity: mock(),
  setAutoResume: mock(),
  persist: mock(),
});

describe("the parts", () => {
  test("what each key does; anything else is swallowed", () => {
    expect(settingsAction("", key({ escape: true }))).toBe("close");
    expect(settingsAction("", key({ upArrow: true }))).toBe("up");
    expect(settingsAction("k", NONE)).toBe("up");
    expect(settingsAction("", key({ downArrow: true }))).toBe("down");
    expect(settingsAction("j", NONE)).toBe("down");
    expect(settingsAction("", key({ return: true }))).toBe("activate");
    expect(settingsAction(" ", NONE)).toBe("activate");
    expect(settingsAction("q", NONE)).toBeNull();
    expect(settingsAction("", key({ tab: true }))).toBeNull();
  });

  test("the cursor wraps both ways and the update is a no-op off the page", () => {
    expect(moveSettingsCursor(-1, 3)(settings(0))).toEqual(settings(2));
    expect(moveSettingsCursor(1, 3)(settings(2))).toEqual(settings(0));
    expect(moveSettingsCursor(1, 3)(settings(0))).toEqual(settings(1));
    const list: Mode = { kind: "list" };
    expect(moveSettingsCursor(1, 3)(list)).toBe(list);
  });

  test("the auto-resume toggle flips the value and persists what it flipped to", () => {
    const persist = mock();
    expect(toggleAutoResume(persist)(false)).toBe(true);
    expect(toggleAutoResume(persist)(true)).toBe(false);
    expect(persist.mock.calls).toEqual([[{ autoResume: true }], [{ autoResume: false }]]);
  });

  test("activating an item enters its picker from the settings page, or toggles; nothing under the cursor does nothing", () => {
    const ctx = ctxIn(settings(0));
    activateSetting("provider", ctx);
    activateSetting("identity", ctx);
    activateSetting("autoResume", ctx);
    activateSetting(undefined, ctx);
    expect(ctx.enterProvider.mock.calls).toEqual([[true]]);
    expect(ctx.enterIdentity.mock.calls).toEqual([[true]]);
    expect(ctx.setAutoResume).toHaveBeenCalledTimes(1);
  });
});

describe("handleSettingsKeys", () => {
  test("declines off the page; on it, owns every key", () => {
    expect(handleSettingsKeys("k", NONE, ctxIn({ kind: "list" }))).toBe(false);
    const ctx = ctxIn(settings(1));
    expect(handleSettingsKeys("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.setMode.mock.calls[0]).toEqual([{ kind: "list" }]);
    expect(handleSettingsKeys("j", NONE, ctx)).toBe(true);
    expect((ctx.setMode.mock.calls[1][0] as (m: Mode) => Mode)(settings(1))).toEqual(settings(2));
    expect(handleSettingsKeys("", key({ upArrow: true }), ctx)).toBe(true);
    expect((ctx.setMode.mock.calls[2][0] as (m: Mode) => Mode)(settings(0))).toEqual(settings(2));
    expect(handleSettingsKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.enterIdentity).toHaveBeenCalledTimes(1);
    expect(handleSettingsKeys("x", NONE, ctx)).toBe(true);
    expect(ctx.setMode).toHaveBeenCalledTimes(3);
  });
});
