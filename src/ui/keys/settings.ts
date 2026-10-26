import type { Key } from "ink";
import { CONFIG_PATH } from "../../app/config.ts";
import {
  FIELD_SPECS, SETTINGS_ITEMS, fieldText, isConfigField, tildePath, toggledValue,
  type ConfigField, type TextField,
} from "../models/configFields.ts";
import type { KeyContext, Mode } from "./context.ts";

type Ctx = Pick<
  KeyContext,
  | "mode" | "setMode" | "settingsItems" | "enterProvider" | "enterIdentity" | "setAutoResume" | "persist"
  | "config" | "saveConfigPatch" | "enterTeamPicker"
>;
type SettingsItem = Ctx["settingsItems"][number];
type SettingsAction = "close" | "up" | "down" | "activate";

const INPUT_ACTIONS: Record<string, SettingsAction> = { k: "up", j: "down", " ": "activate" };

/** What a key does on the settings page, or null for one the page swallows. */
export function settingsAction(input: string, key: Key): SettingsAction | null {
  if (key.escape) return "close";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.return) return "activate";
  return INPUT_ACTIONS[input] ?? null;
}

/** A functional update moving the cursor by `delta` with wrap-around; a no-op off the page. */
export function moveSettingsCursor(delta: number, len: number): (p: Mode) => Mode {
  return (p) => (p.kind === "settings" ? { ...p, cursor: (p.cursor + delta + len) % len } : p);
}

/** The auto-resume toggle as a functional update that also persists the new value. */
export function toggleAutoResume(persist: Ctx["persist"]): (v: boolean) => boolean {
  return (v) => {
    const nv = !v;
    persist({ autoResume: nv });
    return nv;
  };
}

/** The settings page, its cursor back on `field`'s row. */
export function settingsAt(field: ConfigField, note?: { text: string; error?: boolean }): Mode {
  return { kind: "settings", cursor: SETTINGS_ITEMS.indexOf(field), ...(note ? { note } : {}) };
}

/** The settings page after a save from `field`'s row or editor: what was saved where, or why it wasn't. */
export function afterSave(field: ConfigField, error: string | null): Mode {
  if (error) return settingsAt(field, { text: error, error: true });
  return settingsAt(field, { text: `✓ ${FIELD_SPECS[field].label} saved to ${tildePath(CONFIG_PATH)}` });
}

/** `field`'s line editor, opened on its current value with the caret at the end. */
export function openEditor(field: TextField, config: Ctx["config"]): Mode {
  const value = fieldText(field, config);
  return { kind: "settingsEdit", field, value, cursor: value.length };
}

/** Enter on a config.json row: flip a toggle and save it, or open the team picker or the row's editor. */
export function activateConfigField(field: ConfigField, ctx: Ctx): void {
  if (field === "resumeDialogChoice" || field === "peerSocket") {
    ctx.setMode(afterSave(field, ctx.saveConfigPatch(toggledValue(field, ctx.config))));
  } else if (field === "team") ctx.enterTeamPicker(ctx.config.team);
  else ctx.setMode(openEditor(field, ctx.config));
}

/** Enter or space on the item under the cursor. */
export function activateSetting(item: SettingsItem | undefined, ctx: Ctx): void {
  if (item === "provider") ctx.enterProvider(true);
  else if (item === "identity") ctx.enterIdentity(true);
  else if (item === "autoResume") ctx.setAutoResume(toggleAutoResume(ctx.persist));
  else if (isConfigField(item)) activateConfigField(item, ctx);
}

// ── settings page ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleSettingsKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "settings") return false;
  const len = ctx.settingsItems.length;
  switch (settingsAction(input, key)) {
    case "close": ctx.setMode({ kind: "list" }); break;
    case "up": ctx.setMode(moveSettingsCursor(-1, len)); break;
    case "down": ctx.setMode(moveSettingsCursor(1, len)); break;
    case "activate": activateSetting(ctx.settingsItems[mode.cursor], ctx); break;
  }
  return true;
}
