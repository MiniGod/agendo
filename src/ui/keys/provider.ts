import type { Key } from "ink";
import { PROVIDER_INFO } from "../../provider.ts";
import type { KeyContext, Mode } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "applyProvider">;

// ── backend picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleProviderKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "provider") return false;
  const back: Mode = mode.fromSettings ? { kind: "settings", cursor: 0 } : { kind: "list" };
  const len = PROVIDER_INFO.length;
  if (key.escape) { ctx.setMode(back); return true; }
  if (key.upArrow || input === "k") {
    ctx.setMode((p) => (p.kind === "provider" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
    return true;
  }
  if (key.downArrow || input === "j") {
    ctx.setMode((p) => (p.kind === "provider" ? { ...p, cursor: (p.cursor + 1) % len } : p));
    return true;
  }
  if (key.return) { ctx.applyProvider(PROVIDER_INFO[mode.cursor].name, back); return true; }
  return true;
}
