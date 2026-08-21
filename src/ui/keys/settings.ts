import type { Key } from "ink";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<
  KeyContext,
  "mode" | "setMode" | "settingsItems" | "enterProvider" | "enterIdentity" | "setAutoResume" | "persist"
>;

// ── settings page ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleSettingsKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "settings") return false;
  const len = ctx.settingsItems.length;
  if (key.escape) { ctx.setMode({ kind: "list" }); return true; }
  if (key.upArrow || input === "k") {
    ctx.setMode((p) => (p.kind === "settings" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
    return true;
  }
  if (key.downArrow || input === "j") {
    ctx.setMode((p) => (p.kind === "settings" ? { ...p, cursor: (p.cursor + 1) % len } : p));
    return true;
  }
  if (key.return || input === " ") {
    const item = ctx.settingsItems[mode.cursor];
    if (item === "provider") { ctx.enterProvider(true); return true; }
    if (item === "identity") { ctx.enterIdentity(true); return true; }
    if (item === "autoResume") {
      ctx.setAutoResume((v) => {
        const nv = !v;
        ctx.persist({ autoResume: nv });
        return nv;
      });
      return true;
    }
  }
  return true;
}
