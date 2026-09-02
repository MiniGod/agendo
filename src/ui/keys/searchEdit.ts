// The edits a keystroke makes to the search query, as pure functions from
// (text, cursor) to the next (text, cursor). search.ts decides which one a key
// means; nothing here knows about keys, focus or React.

import type { Key } from "ink";
import { caretLeft, caretRight } from "./caret.ts";

/** What `editSearch` applies: a new cursor, and optionally a new text. */
export interface SearchEdit {
  text?: string;
  cursor: number;
}
export type SearchEditFn = (text: string, cursor: number) => SearchEdit;

// ── caret moves ─────────────────────────────────────────────────────────────
// Whole code points, not string indices — see caret.ts.

export function moveLeft(v: string, c: number): SearchEdit {
  return { cursor: caretLeft(v, c) };
}

export function moveRight(v: string, c: number): SearchEdit {
  return { cursor: caretRight(v, c) };
}

export function toStart(): SearchEdit {
  return { cursor: 0 };
}

export function toEnd(v: string): SearchEdit {
  return { cursor: v.length };
}

// ── edits ───────────────────────────────────────────────────────────────────

/**
 * Delete the word before the caret: trailing whitespace first, then the run of
 * non-whitespace. Index arithmetic rather than caretLeft, and safely so: it
 * only ever halts on a character matching /\s/ or at 0, and every whitespace
 * character is BMP, so it cannot stop inside a surrogate pair. That argument
 * is load-bearing (see caret.ts); widen the predicate and this needs caretLeft.
 */
export function deleteWordBefore(v: string, c: number): SearchEdit {
  let i = c;
  while (i > 0 && /\s/.test(v[i - 1]!)) i--;
  while (i > 0 && !/\s/.test(v[i - 1]!)) i--;
  return { text: v.slice(0, i) + v.slice(c), cursor: i };
}

/** Delete the character before the caret — the whole character, both halves of a surrogate pair. */
export function deleteCharBefore(v: string, c: number): SearchEdit {
  if (c === 0) return { cursor: 0 };
  const i = caretLeft(v, c);
  return { text: v.slice(0, i) + v.slice(c), cursor: i };
}

/** An edit that types `input` at the caret. */
export function insertion(input: string): SearchEditFn {
  return function insertAt(v: string, c: number): SearchEdit {
    return { text: v.slice(0, c) + input + v.slice(c), cursor: c + input.length };
  };
}

// ── which key means which edit ──────────────────────────────────────────────

/** Ctrl+Backspace (^H → key.backspace in Ink), Alt/Meta+Backspace, or Ctrl+W. */
export function isWordDelete(input: string, key: Key): boolean {
  return key.backspace || (key.meta && key.delete) || (key.ctrl && input === "w");
}

/** Plain Backspace (\x7f → key.delete in Ink). */
export function isCharDelete(input: string, key: Key): boolean {
  return key.delete || input === "\x7f";
}

/**
 * Printable means "not a control character", NOT "ASCII". The clone prompt
 * (src/ui/keys/clone.ts) carries the long version of why that distinction
 * is not cosmetic here: repo names, branches and ADO work-item titles are
 * routinely Icelandic — þ ð æ ö á í ó ú ý — and an ASCII-only class drops
 * those keystrokes with no character, no beep and no error, so the one row
 * visible on screen is the one row that cannot be searched for.
 *
 * `\p{Cc}` is exactly the C0 and C1 control ranges (U+0000–U+001F,
 * U+007F–U+009F), written as a property escape so the pattern holds no
 * control character of its own (see `no-control-regex` in .oxlintrc.json).
 * A chunk containing one is rejected WHOLE rather than stripped, which is
 * precisely the old ASCII guard's behaviour.
 *
 * Be exact about what that does and does not buy, because it is easy to
 * overclaim. Ink strips ONE leading ESC before handing the chunk over
 * (`input.slice(1)` in ink/hooks/use-input.js), so an unrecognised escape
 * sequence arrives already decapitated: `\x1b[200~` becomes `[200~`, which
 * holds no control character and is therefore ACCEPTED and typed into the
 * query. The old ASCII-only guard accepted it too — `[200~` is printable
 * ASCII — so nothing regressed here, but the guard is not what keeps such
 * a remnant out, and no guard on this line does. What rejecting-whole does
 * buy is the chunk that still CONTAINS a control character after that one
 * strip, e.g. a bracketed paste arriving as `[200~hi\x1b[201~`: stripping
 * the controls would type the markers as literal text, while rejecting the
 * chunk types nothing. clone.ts strips instead, deliberately, because a
 * pasted URL with a trailing newline is its entire job; a search query has
 * no such paste to protect.
 */
export function isPrintableChunk(input: string, key: Key): boolean {
  return Boolean(input) && !key.ctrl && !key.meta && !/\p{Cc}/u.test(input);
}

const CTRL_MOVES = new Map<string, SearchEditFn>([
  ["a", toStart],
  ["e", toEnd],
]);

/** The caret move a key asks for (←, →, ^A, ^E), or null. */
export function caretMoveFor(input: string, key: Key): SearchEditFn | null {
  if (key.leftArrow) return moveLeft;
  if (key.rightArrow) return moveRight;
  return key.ctrl ? (CTRL_MOVES.get(input) ?? null) : null;
}

/** The text edit a key asks for (word delete, char delete, typing), or null. */
export function textEditFor(input: string, key: Key): SearchEditFn | null {
  if (isWordDelete(input, key)) return deleteWordBefore;
  if (isCharDelete(input, key)) return deleteCharBefore;
  return isPrintableChunk(input, key) ? insertion(input) : null;
}
