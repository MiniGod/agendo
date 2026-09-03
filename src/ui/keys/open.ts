import type { Key } from "ink";
import type { OpenTargets } from "../targets.ts";
import { V } from "../vocabState.ts";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "openInBrowser" | "exit">;

/** The link a letter opens — `p` the PR, `i` the issue — with its label; null when the dialog has no such link. */
export function openTargetOf(input: string, targets: OpenTargets): { target: { id: number; url: string }; label: string } | null {
  if (input === "p" && targets.pr) return { target: targets.pr, label: `PR ${V.prPrefix}${targets.pr.id}` };
  if (input === "i" && targets.workItem) return { target: targets.workItem, label: `#${targets.workItem.id}` };
  return null;
}

// ── open-in-browser dialog (p = PR, i = issue, esc/q = cancel) ──
// The dialog owns every key while it is up: unhandled ones are swallowed, never
// passed on to the list below.
export function handleOpenKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "open") return false;
  if (key.escape || input === "q") { ctx.setMode({ kind: "list" }); return true; }
  const link = openTargetOf(input, mode.targets);
  if (link) ctx.openInBrowser(link.target, link.label);
  else if (key.ctrl && input === "c") ctx.exit();
  return true;
}
