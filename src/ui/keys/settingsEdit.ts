import type { Key } from "ink";
import { parseField } from "../models/configFields.ts";
import type { KeyContext, Mode } from "./context.ts";
import { applyLineEdit, lineEditFor, stripControls } from "./lineEdit.ts";
import type { SearchEditFn } from "./searchEdit.ts";
import { afterSave, settingsAt } from "./settings.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "saveConfigPatch">;
type EditMode = Extract<Mode, { kind: "settingsEdit" }>;

/**
 * The functional `setMode` update one edit makes, a no-op off the editor.
 * Typing clears the last error, which was about the value as it stood.
 * Control characters are stripped rather than rejected, as on the clone
 * prompt: a value pasted as a whole line brings its newline along.
 */
export function settingsEditUpdate(fn: SearchEditFn): (p: Mode) => Mode {
  return function editSettingsValue(p: Mode): Mode {
    if (p.kind !== "settingsEdit") return p;
    return { kind: "settingsEdit", field: p.field, ...applyLineEdit(fn, p.value, p.cursor) };
  };
}

/** Enter: check the value, save it, and go back to the page — or stay, saying why not. */
export function submitSettingsEdit(mode: EditMode, ctx: Ctx): void {
  const parsed = parseField(mode.field, mode.value);
  if ("error" in parsed) {
    ctx.setMode({ ...mode, error: parsed.error });
    return;
  }
  const error = ctx.saveConfigPatch(parsed.patch);
  ctx.setMode(error ? { ...mode, error } : afterSave(mode.field, null));
}

// ── config.json value editor ──
// Owns every key while it is up — unhandled ones are swallowed. `q` is a
// character here (see HOLDS_QUIT_KEYS).
export function handleSettingsEditKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "settingsEdit") return false;
  if (key.escape) ctx.setMode(settingsAt(mode.field));
  else if (key.return) submitSettingsEdit(mode, ctx);
  else {
    const fn = lineEditFor(input, key, stripControls);
    if (fn) ctx.setMode(settingsEditUpdate(fn));
  }
  return true;
}
