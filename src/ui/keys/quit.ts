import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "exit">;

/**
 * Modes where `q` / ctrl-c must NOT quit the app.
 *
 * `branch` and `clone` are text inputs — `q` is an ordinary character in a
 * branch name, and in a repo URL it's unavoidable (`github.com/qmk/qmk_firmware`,
 * anything with "quarkus", "requests", "sequelize" in it). Quitting on it would
 * make those repos literally untypeable.
 *
 * `cloning` is in this set for a different reason: a `git clone` is mid-write,
 * so `q` should not walk away from it — esc cancels, which cleans up.
 *
 * Note this only holds `q`. Ink handles ctrl-c itself (`exitOnCtrlC` defaults
 * on) and never forwards it here, so ctrl-c still quits from every mode — the
 * `key.ctrl` half below is unreachable, kept only to mirror the `branch`
 * prompt's long-standing shape. What makes that safe is the unmount cleanup,
 * which kills the clone and removes the partial directory on the way out.
 */
export const HOLDS_QUIT_KEYS = new Set<Mode["kind"]>(["branch", "clone", "cloning"]);

/**
 * The global quit guards. Not a mode branch of its own, but its POSITION in the
 * chain is load-bearing: it runs after the search blocks (so `q` typed into a
 * query is a character, not a quit) and before every dialog (so `q` closes the
 * app from any of them that doesn't hold the key). Both guards fall through when
 * they don't fire.
 */
export function handleQuitKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (!HOLDS_QUIT_KEYS.has(ctx.mode.kind) && (input === "q" || (key.ctrl && input === "c"))) {
    ctx.exit();
    return true;
  }
  if (ctx.mode.kind === "list" && key.escape) {
    ctx.exit();
    return true;
  }
  return false;
}
