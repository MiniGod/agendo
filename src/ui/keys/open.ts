import type { Key } from "ink";
import { V } from "../vocabState.ts";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "openInBrowser" | "exit">;

// ── open-in-browser dialog (p = PR, i = issue, esc/q = cancel) ──
// The dialog owns every key while it is up: unhandled ones are swallowed, never
// passed on to the list below.
export function handleOpenKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "open") return false;
  if (key.escape || input === "q") { ctx.setMode({ kind: "list" }); return true; }
  if (input === "p" && mode.targets.pr) { ctx.openInBrowser(mode.targets.pr, `PR ${V.prPrefix}${mode.targets.pr.id}`); return true; }
  if (input === "i" && mode.targets.workItem) { ctx.openInBrowser(mode.targets.workItem, `#${mode.targets.workItem.id}`); return true; }
  if (key.ctrl && input === "c") ctx.exit();
  return true;
}
