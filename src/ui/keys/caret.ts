// Caret arithmetic for the three single-line prompts (search, branch, clone).
//
// A prompt's cursor is an index into a JavaScript string, and a character
// outside the BMP — an emoji, some CJK extensions — occupies TWO indices there.
// Stepping by one index parks the caret BETWEEN a surrogate pair, and the next
// insert or delete then splits the pair: type 😀, press ←, type X and the value
// becomes "\ud83dX\ude00" — two unpaired surrogates.
//
// That is not a display artefact. The value is handed to git as one argv
// element of a `spawnSync` (`createWorktree` / `git clone`), and an unpaired
// surrogate has no UTF-8 encoding, so git receives U+FFFD in its place and acts
// on a name the user never typed. Backspace alone reaches it just as fast: one
// press after an emoji used to leave half of it behind.
//
// Icelandic — the reason those prompts accept non-ASCII at all — is entirely
// BMP and never touches this. The pairs come from anything else a terminal can
// paste or a keyboard can emit, which is why the fix belongs in the caret
// rather than in a guard on the input.
//
// Arrow keys and backspace need this. Most other caret moves in those prompts
// go to 0 or to `value.length`, which are always boundaries, so a caret that
// starts on one stays on one.
//
// The exception is the word-delete in search.ts (^W / ^Backspace / alt-backspace),
// which does its own index arithmetic and was deliberately NOT converted. It is
// safe for a reason worth writing down rather than rediscovering: it scans
// backwards and stops only at a character matching /\s/ or at 0, and every
// whitespace character is BMP — so it can only ever halt on a code-point
// boundary. That argument is load-bearing. Widen the predicate it stops on (to
// punctuation, say, which is NOT all BMP) and the site needs caretLeft.

/** The code-point boundary at or before `cursor` — i.e. one ← press. */
export function caretLeft(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  // codePointAt returns a value above 0xffff only when a full surrogate pair
  // starts at that index, which is exactly "the previous character is astral".
  const prev = value.codePointAt(cursor - 2);
  return prev !== undefined && prev > 0xffff ? cursor - 2 : cursor - 1;
}

/** The code-point boundary after `cursor` — i.e. one → press. */
export function caretRight(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const next = value.codePointAt(cursor);
  return next !== undefined && next > 0xffff ? cursor + 2 : cursor + 1;
}
