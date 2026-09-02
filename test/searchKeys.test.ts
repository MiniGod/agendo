// The search prompt: the pure edits (src/ui/keys/searchEdit.ts) and the two
// focus handlers that pick one per key. The e2e suite types into the search
// box and presses ↓; it never reaches the caret moves, the word delete, the
// surrogate-pair delete, the control-character guard or the enter/tab
// fall-through rules — the half of the old handler that scored at 0.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { handleSearchCancelKeys, handleSearchInputKeys, handleSearchListKeys } from "../src/ui/keys/search.ts";
import { caretMoveFor, deleteCharBefore, deleteWordBefore, insertion, isPrintableChunk, moveLeft, moveRight, textEditFor, toEnd, toStart } from "../src/ui/keys/searchEdit.ts";

const NONE: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};
const key = (k: Partial<Key>): Key => ({ ...NONE, ...k });

describe("searchEdit", () => {
  test("caret moves step by code point and jump to the ends", () => {
    expect(moveLeft("a😀", 3)).toEqual({ cursor: 1 });
    expect(moveRight("a😀", 1)).toEqual({ cursor: 3 });
    expect(toStart()).toEqual({ cursor: 0 });
    expect(toEnd("abc")).toEqual({ cursor: 3 });
  });

  test("word delete eats trailing whitespace then the word, and stops at 0", () => {
    expect(deleteWordBefore("foo bar  ", 9)).toEqual({ text: "foo ", cursor: 4 });
    expect(deleteWordBefore("foo bar", 3)).toEqual({ text: " bar", cursor: 0 });
    expect(deleteWordBefore("foo bar", 0)).toEqual({ text: "foo bar", cursor: 0 });
  });

  test("char delete removes a whole astral character, and is a no-op at 0", () => {
    expect(deleteCharBefore("a😀b", 3)).toEqual({ text: "ab", cursor: 1 });
    expect(deleteCharBefore("ab", 1)).toEqual({ text: "b", cursor: 0 });
    expect(deleteCharBefore("ab", 0)).toEqual({ cursor: 0 });
  });

  test("insertion types at the caret", () => {
    expect(insertion("þ")("ab", 1)).toEqual({ text: "aþb", cursor: 2 });
  });

  test("printable means no control character and no modifier — Icelandic yes, a bracketed paste no", () => {
    expect(isPrintableChunk("þ", NONE)).toBe(true);
    expect(isPrintableChunk("[200~", NONE)).toBe(true); // Ink already stripped the ESC
    expect(isPrintableChunk("[200~hi\x1b[201~", NONE)).toBe(false);
    expect(isPrintableChunk("", NONE)).toBe(false);
    expect(isPrintableChunk("a", key({ ctrl: true }))).toBe(false);
    expect(isPrintableChunk("a", key({ meta: true }))).toBe(false);
  });

  test("which key means which move or edit", () => {
    expect(caretMoveFor("", key({ leftArrow: true }))).toBe(moveLeft);
    expect(caretMoveFor("", key({ rightArrow: true }))).toBe(moveRight);
    expect(caretMoveFor("a", key({ ctrl: true }))).toBe(toStart);
    expect(caretMoveFor("e", key({ ctrl: true }))).toBe(toEnd);
    expect(caretMoveFor("x", key({ ctrl: true }))).toBeNull();
    expect(caretMoveFor("a", NONE)).toBeNull();
    expect(textEditFor("", key({ backspace: true }))).toBe(deleteWordBefore);
    expect(textEditFor("", key({ meta: true, delete: true }))).toBe(deleteWordBefore);
    expect(textEditFor("w", key({ ctrl: true }))).toBe(deleteWordBefore);
    expect(textEditFor("", key({ delete: true }))).toBe(deleteCharBefore);
    expect(textEditFor("\x7f", NONE)).toBe(deleteCharBefore);
    expect(textEditFor("x", NONE)!("", 0)).toEqual({ text: "x", cursor: 1 });
    expect(textEditFor("x", key({ ctrl: true }))).toBeNull();
  });
});

function ctxWith(searchFocus: "input" | "list" | null, extra: Record<string, unknown> = {}) {
  return {
    mode: { kind: "list" },
    searchFocus,
    setSearchFocus: mock(),
    search: { text: "", cursor: 0 },
    editSearch: mock(),
    clearSearch: mock(),
    selectableIdx: [4, 6],
    cursor: 4,
    setCursor: mock(),
    exit: mock(),
    ...extra,
  };
}

describe("handleSearchInputKeys", () => {
  test("declines unless the input is focused in list mode", () => {
    expect(handleSearchInputKeys("x", NONE, ctxWith("list") as any)).toBe(false);
    expect(handleSearchInputKeys("x", NONE, ctxWith("input", { mode: { kind: "open" } }) as any)).toBe(false);
  });

  test("↓ hands focus to the first result when there is one; ↑ is swallowed", () => {
    const ctx = ctxWith("input");
    expect(handleSearchInputKeys("", key({ downArrow: true }), ctx as any)).toBe(true);
    expect(ctx.setSearchFocus.mock.calls).toEqual([["list"]]);
    expect(ctx.setCursor.mock.calls).toEqual([[4]]);
    const empty = ctxWith("input", { selectableIdx: [] });
    expect(handleSearchInputKeys("", key({ downArrow: true }), empty as any)).toBe(true);
    expect(empty.setSearchFocus).not.toHaveBeenCalled();
    expect(handleSearchInputKeys("", key({ upArrow: true }), ctx as any)).toBe(true);
  });

  test("a caret move edits without resetting the cursor; a text edit resets it first", () => {
    const ctx = ctxWith("input");
    expect(handleSearchInputKeys("", key({ leftArrow: true }), ctx as any)).toBe(true);
    expect(ctx.editSearch.mock.calls).toEqual([[moveLeft]]);
    expect(ctx.setCursor).not.toHaveBeenCalled();
    expect(handleSearchInputKeys("þ", NONE, ctx as any)).toBe(true);
    expect(ctx.setCursor.mock.calls).toEqual([[0]]);
    expect(ctx.editSearch.mock.calls[1][0]("a", 1)).toEqual({ text: "aþ", cursor: 2 });
  });

  test("enter falls through only with a query; tab always; everything else is swallowed", () => {
    expect(handleSearchInputKeys("", key({ return: true }), ctxWith("input") as any)).toBe(true);
    expect(handleSearchInputKeys("", key({ return: true }), ctxWith("input", { search: { text: " q ", cursor: 0 } }) as any)).toBe(false);
    expect(handleSearchInputKeys("", key({ tab: true }), ctxWith("input") as any)).toBe(false);
    expect(handleSearchInputKeys("", key({ escape: true }), ctxWith("input") as any)).toBe(true);
    expect(handleSearchInputKeys("\x1b", NONE, ctxWith("input") as any)).toBe(true);
  });
});

describe("handleSearchListKeys and handleSearchCancelKeys", () => {
  test("q cancels, / refocuses the input, ↑ or k on the first result refocuses too; the rest falls through", () => {
    const q = ctxWith("list");
    expect(handleSearchListKeys("q", NONE, q as any)).toBe(true);
    expect(q.clearSearch).toHaveBeenCalledTimes(1);
    expect(q.setCursor.mock.calls).toEqual([[0]]);
    const slash = ctxWith("list");
    expect(handleSearchListKeys("/", NONE, slash as any)).toBe(true);
    expect(slash.setSearchFocus.mock.calls).toEqual([["input"]]);
    const first = ctxWith("list");
    expect(handleSearchListKeys("k", NONE, first as any)).toBe(true);
    expect(first.setSearchFocus.mock.calls).toEqual([["input"]]);
    const deeper = ctxWith("list", { cursor: 6 });
    expect(handleSearchListKeys("", key({ upArrow: true }), deeper as any)).toBe(false);
    expect(handleSearchListKeys("o", NONE, ctxWith("list") as any)).toBe(false);
    expect(handleSearchListKeys("q", NONE, ctxWith("input") as any)).toBe(false);
  });

  test("esc cancels from either focus, ctrl-c quits, and nothing happens outside a search", () => {
    const esc = ctxWith("input");
    expect(handleSearchCancelKeys("", key({ escape: true }), esc as any)).toBe(true);
    expect(esc.clearSearch).toHaveBeenCalledTimes(1);
    const quit = ctxWith("list");
    expect(handleSearchCancelKeys("c", key({ ctrl: true }), quit as any)).toBe(true);
    expect(quit.exit).toHaveBeenCalledTimes(1);
    expect(handleSearchCancelKeys("x", NONE, ctxWith("list") as any)).toBe(false);
    expect(handleSearchCancelKeys("", key({ escape: true }), ctxWith(null) as any)).toBe(false);
  });
});
