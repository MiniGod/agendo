import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";
import { listStep } from "./nav.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "roster" | "model" | "setIdentity" | "persist" | "setCursor">;
type IdentityMode = Extract<Mode, { kind: "identity" }>;

/** Where escape lands: the settings screen the picker was opened from, else the list. */
export function identityBack(mode: IdentityMode): Mode {
  return mode.fromSettings ? { kind: "settings", cursor: 0 } : { kind: "list" };
}

/**
 * The cursor one row on, wrapping over `len` rows. A functional update, so
 * rapidly-arriving keys (batched in one stdin chunk) each advance the cursor
 * instead of all reading the same stale value.
 */
export function stepIdentity(len: number, step: 1 | -1): (p: Mode) => Mode {
  return (p) => (p.kind === "identity" ? { ...p, cursor: (p.cursor + step + len) % len } : p);
}

/**
 * Pick the roster entry under the cursor. Selecting the authenticated user
 * clears the override so the launcher tracks whoever is logged in via az. A
 * picked identity reloads the data, so this always lands on the list.
 */
export function pickIdentity(ctx: Ctx, cursor: number): void {
  const picked = ctx.roster[cursor];
  if (picked) {
    const next = ctx.model && picked.id === ctx.model.me.id ? null : picked;
    ctx.setIdentity(next);
    ctx.persist({ identity: next });
    ctx.setCursor(0);
  }
  ctx.setMode({ kind: "list" });
}

// ── identity picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleIdentityKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "identity") return false;
  if (key.escape) { ctx.setMode(identityBack(mode)); return true; }
  if (ctx.roster.length === 0) return true;
  const step = listStep(input, key);
  if (step !== null) ctx.setMode(stepIdentity(ctx.roster.length, step));
  else if (key.return) pickIdentity(ctx, mode.cursor);
  return true;
}
