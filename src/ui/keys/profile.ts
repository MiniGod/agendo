import type { Key } from "ink";
import type { ProfileChoice } from "../../profiles.ts";
import type { KeyContext, Mode } from "./context.ts";
import { listStep } from "./nav.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "moveToProfile">;
type ProfileMode = Extract<Mode, { kind: "profile" }>;

/**
 * The rows the cursor may land on: only the profiles the session ISN'T in are
 * selectable; its own is on screen for orientation, so the cursor steps over
 * it in both directions.
 */
export function profileTargets(choices: ProfileChoice[]): number[] {
  return choices.flatMap((c, i) => (c.current ? [] : [i]));
}

/** The next selectable row from `cursor`, wrapping; the first when the cursor is not on one. */
export function nextProfileCursor(targets: number[], cursor: number, dir: 1 | -1): number {
  const at = targets.indexOf(cursor);
  return at < 0 ? targets[0] : targets[(at + dir + targets.length) % targets.length];
}

/** Enter: move the session to the profile under the cursor, unless that is where it already is. */
function pickProfile(mode: ProfileMode, ctx: Ctx): void {
  const picked = mode.choices[mode.cursor];
  if (picked && !picked.current) ctx.moveToProfile(mode.session, picked.profile);
}

// ── Claude profile picker (move a session between ~/.claude* dirs) ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleProfileKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "profile") return false;
  if (key.escape) { ctx.setMode({ kind: "list" }); return true; }
  const targets = profileTargets(mode.choices);
  if (targets.length === 0) return true;
  const dir = listStep(input, key);
  if (dir !== null) {
    ctx.setMode((p) => (p.kind === "profile" ? { ...p, cursor: nextProfileCursor(targets, p.cursor, dir) } : p));
    return true;
  }
  if (key.return) pickProfile(mode, ctx);
  return true;
}
