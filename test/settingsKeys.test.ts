// The settings page's keys (src/ui/keys/settings.ts). The e2e suite opens the
// page, moves once and toggles auto-resume, and edits the team; it never wraps
// the cursor at either end, presses a key the page swallows, enters the
// provider and identity pickers from here, or flips a config toggle whose save
// fails. Every arm sits beside the one next to it, on a context of mocks.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { DEFAULT_CONFIG } from "../src/app/config.ts";
import type { ConfigPatch } from "../src/app/configSave.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import {
  activateConfigField, activateSetting, afterSave, handleSettingsKeys, moveSettingsCursor, openEditor, settingsAction,
  settingsAt, toggleAutoResume,
} from "../src/ui/keys/settings.ts";
import { SETTINGS_ITEMS } from "../src/ui/models/configFields.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });
const settings = (cursor: number): Mode => ({ kind: "settings", cursor });
const config = { ...DEFAULT_CONFIG, team: "Team DES", closedStates: ["Closed", "Done"] };
const ctxIn = (mode: Mode, saveError: string | null = null) => ({
  mode,
  setMode: mock(),
  settingsItems: SETTINGS_ITEMS,
  enterProvider: mock(),
  enterIdentity: mock(),
  setAutoResume: mock(),
  persist: mock(),
  config,
  saveConfigPatch: mock((_patch: ConfigPatch) => saveError),
  enterTeamPicker: mock(),
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

describe("the config.json rows", () => {
  test("settingsAt puts the cursor on the field's row, with the note when there is one", () => {
    expect(settingsAt("org")).toEqual({ kind: "settings", cursor: 3 });
    expect(settingsAt("focusTerminal", { text: "x", error: true })).toEqual({ kind: "settings", cursor: SETTINGS_ITEMS.length - 1, note: { text: "x", error: true } });
  });

  test("afterSave says where it saved, or why it didn't", () => {
    const ok = afterSave("team", null);
    expect(ok).toMatchObject({ kind: "settings", cursor: SETTINGS_ITEMS.indexOf("team") });
    expect(ok.kind === "settings" && ok.note?.text).toMatch(/^✓ Team saved to .*\.agendo\/config\.json$/);
    expect(afterSave("org", "couldn't save: EACCES")).toEqual(settingsAt("org", { text: "couldn't save: EACCES", error: true }));
  });

  test("openEditor opens on the current value with the caret at its end", () => {
    expect(openEditor("closedStates", config)).toEqual({ kind: "settingsEdit", field: "closedStates", value: "Closed, Done", cursor: 12 });
    expect(openEditor("focusTerminal", config)).toEqual({ kind: "settingsEdit", field: "focusTerminal", value: "", cursor: 0 });
  });

  test("a toggle saves the flipped value and lands back on its row, saying how it went", () => {
    const ctx = ctxIn(settings(10));
    activateConfigField("peerSocket", ctx);
    expect(ctx.saveConfigPatch.mock.calls).toEqual([[{ peerSocket: false }]]);
    expect(ctx.setMode.mock.calls[0][0]).toEqual(afterSave("peerSocket", null));
    const failing = ctxIn(settings(9), "couldn't save: disk full");
    activateConfigField("resumeDialogChoice", failing);
    expect(failing.saveConfigPatch.mock.calls).toEqual([[{ resumeDialogChoice: "as-is" }]]);
    expect(failing.setMode.mock.calls[0][0]).toEqual(afterSave("resumeDialogChoice", "couldn't save: disk full"));
  });

  test("a hand-edited team that isn't text opens the picker on an empty name rather than crashing it", () => {
    const ctx = { ...ctxIn(settings(5)), config: { ...config, team: null as never } };
    activateConfigField("team", ctx);
    expect(ctx.enterTeamPicker.mock.calls).toEqual([[""]]);
  });

  test("team opens its picker on the current team; every other field opens its editor", () => {
    const ctx = ctxIn(settings(5));
    activateSetting("team", ctx);
    expect(ctx.enterTeamPicker.mock.calls).toEqual([["Team DES"]]);
    activateSetting("stalledAfterMinutes", ctx);
    expect(ctx.setMode.mock.calls[0][0]).toEqual({ kind: "settingsEdit", field: "stalledAfterMinutes", value: "240", cursor: 3 });
    expect(ctx.saveConfigPatch).not.toHaveBeenCalled();
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
    expect((ctx.setMode.mock.calls[2][0] as (m: Mode) => Mode)(settings(0))).toEqual(settings(SETTINGS_ITEMS.length - 1));
    expect(handleSettingsKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.enterIdentity).toHaveBeenCalledTimes(1);
    expect(handleSettingsKeys("x", NONE, ctx)).toBe(true);
    expect(ctx.setMode).toHaveBeenCalledTimes(3);
  });
});
