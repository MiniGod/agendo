import type { Key } from "ink";
import type { KeyContext } from "./context.ts";

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
    if (key.leftArrow) { ctx.editSearch((_v, c) => ({ cursor: Math.max(0, c - 1) })); return true; }
    if (key.rightArrow) { ctx.editSearch((v, c) => ({ cursor: Math.min(v.length, c + 1) })); return true; }
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
    if (key.delete || input === "\x7f") {
      ctx.setCursor(0);
      ctx.editSearch((v, c) => (c === 0 ? { cursor: 0 } : { text: v.slice(0, c - 1) + v.slice(c), cursor: c - 1 }));
      return true;
    }
    if (input && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
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
