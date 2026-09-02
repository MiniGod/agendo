import type { Key } from "ink";
import { caretLeft, caretRight } from "./caret.ts";

/**
 * One keystroke applied to a single-line text prompt: the caret moves, the
 * ctrl-a/e/u chords, backspace, and insertion of whatever printable text
 * arrived (a paste is one chunk, control characters stripped — see
 * keys/clone.ts for why that is not "printable ASCII only"). Returns the new
 * value and caret, or null when the key was not an editing key at all, so the
 * caller can decide what a stray key means on its screen.
 *
 * Pure: the caller applies the result inside a functional `setMode` update so
 * two keystrokes batched into one chunk each see the other's effect.
 */
export function editLine(
  input: string,
  key: Key,
  value: string,
  cursor: number,
): { value: string; cursor: number } | null {
  // Whole code points, not string indices — see caret.ts.
  if (key.leftArrow) return { value, cursor: caretLeft(value, cursor) };
  if (key.rightArrow) return { value, cursor: caretRight(value, cursor) };
  if (key.ctrl && input === "a") return { value, cursor: 0 };
  if (key.ctrl && input === "e") return { value, cursor: value.length };
  if (key.ctrl && input === "u") return { value: "", cursor: 0 };
  if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
    if (cursor === 0) return { value, cursor: 0 };
    const i = caretLeft(value, cursor);
    return { value: value.slice(0, i) + value.slice(cursor), cursor: i };
  }
  if (input && !key.ctrl && !key.meta) {
    const text = input.replace(/\p{Cc}+/gu, "");
    if (!text) return null;
    return { value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length };
  }
  return null;
}
