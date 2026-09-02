// One keystroke applied to a single-line text prompt — the clone URL, the
// new-repo name and its typed path. The edits themselves are the search
// prompt's (src/ui/keys/searchEdit.ts): the same caret moves, the same
// character delete, the same insertion. What the prompts add is ^U, backspace
// in every shape a terminal sends it, and a PASTE policy: a chunk that holds
// control characters is cleaned rather than rejected, because a URL copied as
// a whole line brings its newline along (see keys/clone.ts). Each prompt says
// how to clean, and nothing here knows about modes or React.

import type { Key } from "ink";
import { caretMoveFor, deleteCharBefore, insertion, type SearchEditFn } from "./searchEdit.ts";

/** The next value and caret of a prompt. */
export interface LineEdit {
  value: string;
  cursor: number;
}

/** How a prompt turns the text a key brought into the text it types. */
export type Clean = (input: string) => string;

/** ^U: clear the line. */
export function clearLine(): { text: string; cursor: number } {
  return { text: "", cursor: 0 };
}

/** Backspace: Ink's `backspace` (^H) and `delete` (\x7f), plus the raw bytes. */
export function isDeleteKey(input: string, key: Key): boolean {
  return key.backspace || key.delete || input === "\x7f" || input === "\b";
}

/**
 * Drop every control character — `\p{Cc}` is exactly C0 and C1, written as a
 * property escape so the pattern holds none of its own (`no-control-regex`).
 */
export function stripControls(input: string): string {
  return input.replace(/\p{Cc}+/gu, "");
}

/** The text edit a key asks for: a delete, ^U, or typing the cleaned text. */
function textEditFor(input: string, key: Key, clean: Clean): SearchEditFn | null {
  if (isDeleteKey(input, key)) return deleteCharBefore;
  if (key.ctrl) return input === "u" ? clearLine : null;
  const text = key.meta ? "" : clean(input);
  return text ? insertion(text) : null;
}

/**
 * The edit a key means on a single-line prompt (←, →, ^A, ^E, ^U, backspace,
 * typing), or null when it was not an editing key at all, so the caller can
 * decide what a stray key means on its screen.
 */
export function lineEditFor(input: string, key: Key, clean: Clean): SearchEditFn | null {
  return caretMoveFor(input, key) ?? textEditFor(input, key, clean);
}

/** Apply an edit to a prompt's value and caret. */
export function applyLineEdit(fn: SearchEditFn, value: string, cursor: number): LineEdit {
  const r = fn(value, cursor);
  return { value: r.text ?? value, cursor: r.cursor };
}

/**
 * One keystroke on the new-repo prompts, control characters stripped. Pure:
 * the caller applies the result inside a functional `setMode` update so two
 * keystrokes batched into one chunk each see the other's effect.
 */
export function editLine(input: string, key: Key, value: string, cursor: number): LineEdit | null {
  const fn = lineEditFor(input, key, stripControls);
  return fn ? applyLineEdit(fn, value, cursor) : null;
}
