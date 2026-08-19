import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "roster" | "model" | "setIdentity" | "persist" | "setCursor">;

// ── identity picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleIdentityKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "identity") return false;
  const back: Mode = mode.fromSettings ? { kind: "settings", cursor: 0 } : { kind: "list" };
  if (key.escape) { ctx.setMode(back); return true; }
  const len = ctx.roster.length;
  if (len === 0) return true;
  // Functional updates so rapidly-arriving keys (batched in one stdin chunk)
  // each advance the cursor instead of all reading the same stale value.
  if (key.upArrow || input === "k") {
    ctx.setMode((p) => (p.kind === "identity" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
    return true;
  }
  if (key.downArrow || input === "j") {
    ctx.setMode((p) => (p.kind === "identity" ? { ...p, cursor: (p.cursor + 1) % len } : p));
    return true;
  }
  if (key.return) {
    const picked = ctx.roster[mode.cursor];
    if (picked) {
      // Selecting the authenticated user clears the override so the launcher
      // tracks whoever is logged in via az.
      const next = ctx.model && picked.id === ctx.model.me.id ? null : picked;
      ctx.setIdentity(next);
      ctx.persist({ identity: next });
      ctx.setCursor(0);
    }
    // A picked identity reloads the data, so always land on the list.
    ctx.setMode({ kind: "list" });
    return true;
  }
  return true;
}
