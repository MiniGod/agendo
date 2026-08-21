import type { Key } from "ink";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "moveToProfile">;

// ── Claude profile picker (move a session between ~/.claude* dirs) ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleProfileKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "profile") return false;
  if (key.escape) { ctx.setMode({ kind: "list" }); return true; }
  // Only the profiles the session ISN'T in are selectable; its own is on
  // screen for orientation, so the cursor steps over it in both directions.
  const targets = mode.choices.flatMap((c, i) => (c.current ? [] : [i]));
  if (targets.length === 0) return true;
  const step = (dir: number) =>
    ctx.setMode((p) => {
      if (p.kind !== "profile") return p;
      const at = targets.indexOf(p.cursor);
      const next = at < 0 ? targets[0] : targets[(at + dir + targets.length) % targets.length];
      return { ...p, cursor: next };
    });
  if (key.upArrow || input === "k") { step(-1); return true; }
  if (key.downArrow || input === "j") { step(1); return true; }
  if (key.return) {
    const picked = mode.choices[mode.cursor];
    if (picked && !picked.current) ctx.moveToProfile(mode.session, picked.profile);
    return true;
  }
  return true;
}
