import type { Key } from "ink";
import type { KeyContext } from "./context.ts";
import { caretLeft, caretRight } from "./caret.ts";

type Ctx = Pick<
  KeyContext,
  "mode" | "searchFocus" | "setSearchFocus" | "search" | "editSearch" | "clearSearch" | "selectableIdx" | "cursor" | "setCursor" | "exit"
>;

// ── fuzzy search (sessions / PRs / work items) ───────────────────────────
// A search owns one query shared by two focus states. These blocks sit ahead
// of the global q/esc handlers but ONLY handle the keys that differ while
// searching — caret editing and focus changes. Every real list action (o, g,
// s, n, enter, arrows, expand) is left to fall through to its single handler
// below; it is never reimplemented here. All three list views search the same
// way, so these blocks gate on `searchFocus` (set only while searching) rather
// than a specific view.
//
// The three blocks stay separate functions in the same order they ran inline:
// each one may decline the key and let the next (and ultimately the list
// handlers) see it, which is the whole point of the design.
export function handleSearchKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (handleSearchCancelKeys(input, key, ctx)) return true;
  if (handleSearchInputKeys(input, key, ctx)) return true;
  if (handleSearchListKeys(input, key, ctx)) return true;
  return false;
}

// Shared: esc cancels the search from either focus; ctrl-c still quits.
function handleSearchCancelKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (ctx.mode.kind === "list" && ctx.searchFocus) {
    if (key.ctrl && input === "c") { ctx.exit(); return true; }
    if (key.escape) { ctx.clearSearch(); ctx.setCursor(0); return true; }
  }
  return false;
}

// INPUT focused: keystrokes edit the query. ←/→ move the caret (the list is
// not focused while typing); ↓ hands focus to the results; enter/tab fall
// through (resume the top match / switch view); everything else is swallowed.
function handleSearchInputKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (ctx.mode.kind === "list" && ctx.searchFocus === "input") {
    if (key.downArrow) {
      if (ctx.selectableIdx.length > 0) { ctx.setSearchFocus("list"); ctx.setCursor(ctx.selectableIdx[0]); }
      return true;
    }
    if (key.upArrow) return true; // single-line input — nothing above
    // Whole code points, not string indices — see caret.ts.
    if (key.leftArrow) { ctx.editSearch((v, c) => ({ cursor: caretLeft(v, c) })); return true; }
    if (key.rightArrow) { ctx.editSearch((v, c) => ({ cursor: caretRight(v, c) })); return true; }
    if (key.ctrl && input === "a") { ctx.editSearch(() => ({ cursor: 0 })); return true; }
    if (key.ctrl && input === "e") { ctx.editSearch((v) => ({ cursor: v.length })); return true; }
    // Delete the previous word: Ctrl+Backspace (^H → key.backspace in Ink),
    // Alt/Meta+Backspace, or Ctrl+W.
    if (key.backspace || (key.meta && key.delete) || (key.ctrl && input === "w")) {
      ctx.setCursor(0);
      ctx.editSearch((v, c) => {
        let i = c;
        while (i > 0 && /\s/.test(v[i - 1]!)) i--;
        while (i > 0 && !/\s/.test(v[i - 1]!)) i--;
        return { text: v.slice(0, i) + v.slice(c), cursor: i };
      });
      return true;
    }
    // Delete the previous character: plain Backspace (\x7f → key.delete in Ink).
    // The whole character, both halves of a surrogate pair (see caret.ts).
    if (key.delete || input === "\x7f") {
      ctx.setCursor(0);
      ctx.editSearch((v, c) => {
        if (c === 0) return { cursor: 0 };
        const i = caretLeft(v, c);
        return { text: v.slice(0, i) + v.slice(c), cursor: i };
      });
      return true;
    }
    // Printable means "not a control character", NOT "ASCII". The clone prompt
    // (src/ui/keys/clone.ts) carries the long version of why that distinction
    // is not cosmetic here: repo names, branches and ADO work-item titles are
    // routinely Icelandic — þ ð æ ö á í ó ú ý — and an ASCII-only class drops
    // those keystrokes with no character, no beep and no error, so the one row
    // visible on screen is the one row that cannot be searched for.
    //
    // `\p{Cc}` is exactly the C0 and C1 control ranges (U+0000–U+001F,
    // U+007F–U+009F), written as a property escape so the pattern holds no
    // control character of its own (see `no-control-regex` in .oxlintrc.json).
    // A chunk containing one is rejected WHOLE rather than stripped, which is
    // precisely the old ASCII guard's behaviour.
    //
    // Be exact about what that does and does not buy, because it is easy to
    // overclaim. Ink strips ONE leading ESC before handing the chunk over
    // (`input.slice(1)` in ink/hooks/use-input.js), so an unrecognised escape
    // sequence arrives already decapitated: `\x1b[200~` becomes `[200~`, which
    // holds no control character and is therefore ACCEPTED and typed into the
    // query. The old ASCII-only guard accepted it too — `[200~` is printable
    // ASCII — so nothing regressed here, but the guard is not what keeps such
    // a remnant out, and no guard on this line does. What rejecting-whole does
    // buy is the chunk that still CONTAINS a control character after that one
    // strip, e.g. a bracketed paste arriving as `[200~hi\x1b[201~`: stripping
    // the controls would type the markers as literal text, while rejecting the
    // chunk types nothing. clone.ts strips instead, deliberately, because a
    // pasted URL with a trailing newline is its entire job; a search query has
    // no such paste to protect.
    if (input && !key.ctrl && !key.meta && !/\p{Cc}/u.test(input)) {
      ctx.setCursor(0);
      ctx.editSearch((v, c) => ({ text: v.slice(0, c) + input + v.slice(c), cursor: c + input.length }));
      return true;
    }
    // With an empty query there is no top match to resume, so swallow enter
    // rather than act on the (hidden) list selection. With a query it falls
    // through to resume the top result; tab falls through to switch view.
    if (key.return && !ctx.search.text.trim()) return true;
    // enter (resume top match) and tab (switch view) fall through; swallow the rest
    if (!(key.return || key.tab)) return true;
  }
  return false;
}

// LIST focused (query active): only the search-specific keys are handled
// here — `q` cancels, `/` re-focuses the input, and ↑ on the first result
// hands focus back to the input. Everything else falls through to the normal
// list handlers (o, g, s, n, enter, arrows, expand) below — not duplicated.
function handleSearchListKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (ctx.mode.kind === "list" && ctx.searchFocus === "list") {
    if (input === "q") { ctx.clearSearch(); ctx.setCursor(0); return true; }
    if (input === "/") { ctx.setSearchFocus("input"); return true; }
    if ((key.upArrow || input === "k") && ctx.cursor === ctx.selectableIdx[0]) { ctx.setSearchFocus("input"); return true; }
  }
  return false;
}
