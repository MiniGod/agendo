import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";
import { applyLineEdit, lineEditFor } from "./lineEdit.ts";
import type { SearchEditFn } from "./searchEdit.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "beginClone">;
type CloningCtx = Pick<KeyContext, "mode" | "cancelClone">;

/**
 * A PASTE arrives as one chunk, and copying a URL as a whole line brings
 * its trailing newline along. Ink doesn't read that chunk as Enter (the
 * `\r` isn't alone), so a printable-only guard like the branch prompt's
 * would reject the entire paste and insert nothing at all — on the one
 * prompt whose whole instruction is "paste a URL". Strip the control
 * characters and keep the rest. Deliberately NOT treated as submit: the
 * destination preview exists so no clone starts unreviewed.
 *
 * Only CONTROL characters are dropped — deliberately not "everything
 * outside printable ASCII". An ADO project name is routinely non-ASCII
 * (`…/innovamps/Þróun/_git/hmi-framework`, and Chrome's omnibox hands
 * that over unencoded), and stripping those letters doesn't reject the
 * URL — it quietly turns it into a *different, still valid* one
 * (`…/innovamps/run/_git/…`), which then previews a destination for a
 * repo the user never named and fails at clone time as "not found".
 */
export function stripPasteControls(input: string): string {
  return input.replace(/[\x00-\x1f\x7f]+/g, "");
}

/** The functional `setMode` update one edit makes, a no-op off the clone prompt. */
export function cloneEdit(fn: SearchEditFn): (p: Mode) => Mode {
  return function editClonePrompt(p: Mode): Mode {
    if (p.kind !== "clone") return p;
    // Any edit clears a stale error — it described the *previous* value.
    return { ...p, ...applyLineEdit(fn, p.value, p.cursor), error: undefined };
  };
}

// ── clone: paste a repo URL ──
// Same editable single-line input as the branch prompt (see there for why the
// updates are functional). Owns every key while it is up. Whole code points,
// not string indices — this prompt takes PASTES, so a non-BMP character in
// one is not exotic here (see caret.ts).
export function handleCloneKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "clone") return false;
  if (key.escape) { ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 }); return true; }
  if (key.return) {
    if (mode.value.trim()) ctx.beginClone(mode.target, mode.agent, mode.value.trim());
    return true;
  }
  const fn = lineEditFor(input, key, stripPasteControls);
  if (fn) ctx.setMode(cloneEdit(fn));
  return true;
}

// ── clone in progress ── (esc kills git and removes the partial directory;
// everything else is ignored so a stray keystroke can't abandon the clone)
export function handleCloningKeys(_input: string, key: Key, ctx: CloningCtx): boolean {
  if (ctx.mode.kind !== "cloning") return false;
  if (key.escape) ctx.cancelClone();
  return true;
}
