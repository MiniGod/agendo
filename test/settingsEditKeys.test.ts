// The config.json value editor's keys (src/ui/keys/settingsEdit.ts). The e2e
// suite types a team and saves it, and types a value that fails validation;
// it never presses esc in the editor, has a save itself fail, or presses a key
// the editor swallows. Each arm here runs on a context of mocks.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { ConfigPatch } from "../src/app/configSave.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { afterSave, settingsAt } from "../src/ui/keys/settings.ts";
import { handleSettingsEditKeys, settingsEditUpdate, submitSettingsEdit } from "../src/ui/keys/settingsEdit.ts";
import { insertion } from "../src/ui/keys/searchEdit.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });
type EditMode = Extract<Mode, { kind: "settingsEdit" }>;
const editing = (value: string, extra: Partial<EditMode> = {}): EditMode => ({ kind: "settingsEdit", field: "team", value, cursor: value.length, ...extra });
const ctxIn = (mode: Mode, saveError: string | null = null) => ({ mode, setMode: mock(), saveConfigPatch: mock((_patch: ConfigPatch) => saveError) });

describe("settingsEditUpdate", () => {
  test("applies the edit and drops the last error; a no-op off the editor", () => {
    expect(settingsEditUpdate(insertion("x"))(editing("Prism", { error: "nope" }))).toEqual(editing("Prismx"));
    const list: Mode = { kind: "list" };
    expect(settingsEditUpdate(insertion("x"))(list)).toBe(list);
  });
});

describe("submitSettingsEdit", () => {
  test("a value that doesn't parse stays in the editor, saying why, and saves nothing", () => {
    const mode = editing("abc", { field: "stalledAfterMinutes" });
    const ctx = ctxIn(mode);
    submitSettingsEdit(mode, ctx);
    expect(ctx.saveConfigPatch).not.toHaveBeenCalled();
    expect(ctx.setMode.mock.calls[0][0]).toEqual({ ...mode, error: "enter a positive number of minutes (e.g. 240)" });
  });

  test("a valid value saves its patch and goes back to the page on its row", () => {
    const mode = editing(" Prisma ");
    const ctx = ctxIn(mode);
    submitSettingsEdit(mode, ctx);
    expect(ctx.saveConfigPatch.mock.calls).toEqual([[{ team: "Prisma" }]]);
    expect(ctx.setMode.mock.calls[0][0]).toEqual(afterSave("team", null));
  });

  test("a save that fails keeps the typed value, with the reason under it", () => {
    const mode = editing("Prisma");
    const ctx = ctxIn(mode, "couldn't save: EACCES");
    submitSettingsEdit(mode, ctx);
    expect(ctx.setMode.mock.calls[0][0]).toEqual({ ...mode, error: "couldn't save: EACCES" });
  });
});

describe("handleSettingsEditKeys", () => {
  test("declines off the editor", () => {
    expect(handleSettingsEditKeys("x", NONE, ctxIn({ kind: "list" }))).toBe(false);
  });

  test("esc goes back to the field's row unsaved; enter submits", () => {
    const mode = editing("Prisma");
    const ctx = ctxIn(mode);
    expect(handleSettingsEditKeys("", key({ escape: true }), ctx)).toBe(true);
    expect(ctx.setMode.mock.calls[0][0]).toEqual(settingsAt("team"));
    expect(ctx.saveConfigPatch).not.toHaveBeenCalled();
    expect(handleSettingsEditKeys("", key({ return: true }), ctx)).toBe(true);
    expect(ctx.saveConfigPatch.mock.calls).toEqual([[{ team: "Prisma" }]]);
  });

  test("typing edits the value, q included and control characters stripped; a non-editing key is swallowed", () => {
    const ctx = ctxIn(editing("a"));
    expect(handleSettingsEditKeys("q\n", NONE, ctx)).toBe(true);
    expect((ctx.setMode.mock.calls[0][0] as (m: Mode) => Mode)(editing("a"))).toEqual(editing("aq"));
    expect(handleSettingsEditKeys("", key({ tab: true }), ctx)).toBe(true);
    expect(handleSettingsEditKeys("", key({ upArrow: true }), ctx)).toBe(true);
    expect(ctx.setMode).toHaveBeenCalledTimes(1);
  });
});
