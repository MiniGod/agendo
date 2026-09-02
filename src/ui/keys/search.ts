import type { Key } from "ink";
import type { KeyContext } from "./context.ts";
import { caretMoveFor, textEditFor } from "./searchEdit.ts";

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

// A search is live only in list mode; `focus` says which half has the keys.
function searching(ctx: Pick<Ctx, "mode" | "searchFocus">, focus: "input" | "list"): boolean {
  return ctx.mode.kind === "list" && ctx.searchFocus === focus;
}

// Shared: esc cancels the search from either focus; ctrl-c still quits.
export function handleSearchCancelKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (ctx.mode.kind === "list" && ctx.searchFocus) {
    if (key.ctrl && input === "c") { ctx.exit(); return true; }
    if (key.escape) { ctx.clearSearch(); ctx.setCursor(0); return true; }
  }
  return false;
}

// INPUT focused: keystrokes edit the query. ←/→ move the caret (the list is
// not focused while typing); ↓ hands focus to the results; enter/tab fall
// through (resume the top match / switch view); everything else is swallowed.
// Which edit a key means lives in searchEdit.ts; this is the choreography.
export function handleSearchInputKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (!searching(ctx, "input")) return false;
  if (key.downArrow) {
    focusResults(ctx);
    return true;
  }
  if (key.upArrow) return true; // single-line input — nothing above
  const move = caretMoveFor(input, key);
  if (move) {
    ctx.editSearch(move);
    return true;
  }
  const edit = textEditFor(input, key);
  if (edit) {
    ctx.setCursor(0);
    ctx.editSearch(edit);
    return true;
  }
  return !fallsThrough(key, ctx.search.text);
}

// ↓ from the input selects the first result, if there is one.
function focusResults(ctx: Pick<Ctx, "selectableIdx" | "setSearchFocus" | "setCursor">): void {
  if (ctx.selectableIdx.length === 0) return;
  ctx.setSearchFocus("list");
  ctx.setCursor(ctx.selectableIdx[0]);
}

// With an empty query there is no top match to resume, so enter is swallowed
// rather than acting on the (hidden) list selection. With a query it falls
// through to resume the top result; tab falls through to switch view. Every
// other key is swallowed.
function fallsThrough(key: Key, text: string): boolean {
  return key.tab || (key.return && Boolean(text.trim()));
}

// LIST focused (query active): only the search-specific keys are handled
// here — `q` cancels, `/` re-focuses the input, and ↑ on the first result
// hands focus back to the input. Everything else falls through to the normal
// list handlers (o, g, s, n, enter, arrows, expand) below — not duplicated.
export function handleSearchListKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (!searching(ctx, "list")) return false;
  if (input === "q") {
    ctx.clearSearch();
    ctx.setCursor(0);
    return true;
  }
  if (input === "/") {
    ctx.setSearchFocus("input");
    return true;
  }
  if ((key.upArrow || input === "k") && ctx.cursor === ctx.selectableIdx[0]) {
    ctx.setSearchFocus("input");
    return true;
  }
  return false;
}
