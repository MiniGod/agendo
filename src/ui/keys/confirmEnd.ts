import type { Key } from "ink";
import { confirmKill } from "../actions/sessionEnd.ts";
import { confirmKillStale } from "../actions/staleKill.ts";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "setNotice" | "rows" | "cursor" | "reload" | "model" | "exit">;

const CANCEL = new Set(["n", "q"]);

// ── kill confirmation (y = kill, n / esc / q = cancel) ──
// One handler for both questions: `x` / `X` on a row, and `K` on the extra
// orchestrators the pinned ⚠ line names.
// Owns every key while it is up, like the open dialog: nothing reaches the list
// underneath, so a stray `x` or `enter` can never act on a row behind the
// question. `q` cancels rather than quitting — it sits before the quit guard in
// the chain for that reason — because walking away from a y/n should be the
// safe answer, not the app closing. ctrl-c still quits, as it does everywhere.
export function handleConfirmEndKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "confirmEnd" && mode.kind !== "confirmEndStale") return false;
  const k = input.toLowerCase();
  if (key.ctrl && k === "c") ctx.exit();
  else if (k === "y") {
    if (mode.kind === "confirmEndStale") confirmKillStale(ctx, mode, mode.sessions, mode.skipped);
    else confirmKill(ctx, mode.session, mode.force, mode.waived);
  }
  else if (key.escape || CANCEL.has(k)) {
    ctx.setMode({ kind: "list" });
    ctx.setNotice("Kill cancelled — nothing was ended.");
  }
  return true;
}
