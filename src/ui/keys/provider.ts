import type { Key } from "ink";
import { PROVIDER_INFO } from "../../provider.ts";
import type { KeyContext, Mode } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "applyProvider">;
type ProviderAction = "close" | "up" | "down" | "activate";

/** What a key does in the backend picker; null for a key it swallows. */
export function providerAction(input: string, key: Key): ProviderAction | null {
  if (key.escape) return "close";
  if (key.upArrow || input === "k") return "up";
  if (key.downArrow || input === "j") return "down";
  if (key.return) return "activate";
  return null;
}

/** The mode updater that moves the picker's cursor by `delta`, wrapping; a no-op once the picker is gone. */
export function moveProviderCursor(delta: number, len: number): (p: Mode) => Mode {
  return (p) => (p.kind === "provider" ? { ...p, cursor: (p.cursor + delta + len) % len } : p);
}

/** Where closing the picker goes: back to Settings when it was opened from there, else the list. */
export function providerBack(fromSettings: boolean | undefined): Mode {
  return fromSettings ? { kind: "settings", cursor: 0 } : { kind: "list" };
}

// ── backend picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleProviderKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "provider") return false;
  const back = providerBack(mode.fromSettings);
  const len = PROVIDER_INFO.length;
  switch (providerAction(input, key)) {
    case "close": ctx.setMode(back); break;
    case "up": ctx.setMode(moveProviderCursor(-1, len)); break;
    case "down": ctx.setMode(moveProviderCursor(1, len)); break;
    case "activate": ctx.applyProvider(PROVIDER_INFO[mode.cursor].name, back); break;
    default: break;
  }
  return true;
}
