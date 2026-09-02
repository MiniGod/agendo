// The single-line prompts: the shared edit vocabulary (src/ui/keys/lineEdit.ts)
// and the clone-URL handler that dispatches on it. The e2e suite types a URL
// and a folder name and presses enter; it never reaches the caret moves, ^U,
// backspace at the start, a paste with a newline, or a key that is not an
// edit, which is where the untested half of the two old handlers lived.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { cloneEdit, handleCloneKeys, handleCloningKeys, stripPasteControls } from "../src/ui/keys/clone.ts";
import type { Mode } from "../src/ui/keys/context.ts";
import { applyLineEdit, clearLine, editLine, isDeleteKey, lineEditFor, stripControls } from "../src/ui/keys/lineEdit.ts";
import { deleteCharBefore, moveLeft, toEnd } from "../src/ui/keys/searchEdit.ts";

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

describe("lineEdit", () => {
  test("backspace in every shape a terminal sends it", () => {
    expect(isDeleteKey("", key({ backspace: true }))).toBe(true);
    expect(isDeleteKey("", key({ delete: true }))).toBe(true);
    expect(isDeleteKey("\x7f", NONE)).toBe(true);
    expect(isDeleteKey("\b", NONE)).toBe(true);
    expect(isDeleteKey("x", NONE)).toBe(false);
  });

  test("which key means which edit", () => {
    expect(lineEditFor("", key({ leftArrow: true }), stripControls)).toBe(moveLeft);
    expect(lineEditFor("e", key({ ctrl: true }), stripControls)).toBe(toEnd);
    expect(lineEditFor("u", key({ ctrl: true }), stripControls)).toBe(clearLine);
    expect(lineEditFor("", key({ delete: true }), stripControls)).toBe(deleteCharBefore);
    expect(lineEditFor("x", key({ ctrl: true }), stripControls)).toBeNull();
    expect(lineEditFor("x", key({ meta: true }), stripControls)).toBeNull();
    expect(lineEditFor("", NONE, stripControls)).toBeNull();
    expect(lineEditFor("\r\n", NONE, stripControls)).toBeNull();
    expect(lineEditFor("þ", NONE, stripControls)!("a", 1)).toEqual({ text: "aþ", cursor: 2 });
  });

  test("an edit without a text keeps the value; ^U empties it", () => {
    expect(applyLineEdit(moveLeft, "ab", 2)).toEqual({ value: "ab", cursor: 1 });
    expect(applyLineEdit(clearLine, "ab", 2)).toEqual({ value: "", cursor: 0 });
  });

  test("stripControls drops C0, DEL and C1, and nothing else", () => {
    expect(stripControls("a\r\nb\x7fþ")).toBe("abþ");
  });
});

describe("editLine", () => {
  test("caret moves step by code point and jump to the ends", () => {
    expect(editLine("", key({ leftArrow: true }), "a😀", 3)).toEqual({ value: "a😀", cursor: 1 });
    expect(editLine("", key({ rightArrow: true }), "a😀", 1)).toEqual({ value: "a😀", cursor: 3 });
    expect(editLine("a", key({ ctrl: true }), "abc", 2)).toEqual({ value: "abc", cursor: 0 });
    expect(editLine("e", key({ ctrl: true }), "abc", 1)).toEqual({ value: "abc", cursor: 3 });
  });

  test("backspace removes a whole character, is a no-op at 0; ^U clears", () => {
    expect(editLine("", key({ backspace: true }), "a😀b", 3)).toEqual({ value: "ab", cursor: 1 });
    expect(editLine("\b", NONE, "ab", 0)).toEqual({ value: "ab", cursor: 0 });
    expect(editLine("u", key({ ctrl: true }), "ab", 1)).toEqual({ value: "", cursor: 0 });
  });

  test("typing inserts at the caret with the controls stripped; a chunk of only controls is not an edit", () => {
    expect(editLine("þ\n", NONE, "ab", 1)).toEqual({ value: "aþb", cursor: 2 });
    expect(editLine("\n", NONE, "ab", 1)).toBeNull();
    expect(editLine("x", key({ ctrl: true }), "ab", 1)).toBeNull();
  });
});

type CloneMode = Extract<Mode, { kind: "clone" }>;
const clone = { kind: "clone", target: { kind: "item" }, agent: "claude", value: "ab", cursor: 2, error: ["stale"] } as unknown as CloneMode;
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), beginClone: mock(), cancelClone: mock() });

describe("handleCloneKeys", () => {
  test("declines off the clone prompt", () => {
    const ctx = ctxIn({ kind: "list" } as Mode);
    expect(handleCloneKeys("x", NONE, ctx as any)).toBe(false);
    expect(ctx.setMode).not.toHaveBeenCalled();
  });

  test("esc goes back to the repo list; enter clones the trimmed URL, or nothing", () => {
    const esc = ctxIn(clone);
    expect(handleCloneKeys("", key({ escape: true }), esc as any)).toBe(true);
    expect(esc.setMode.mock.calls).toEqual([[{ kind: "repo", target: { kind: "item" }, agent: "claude", cursor: 0 }]]);
    const enter = ctxIn({ ...clone, value: " u " } as Mode);
    expect(handleCloneKeys("", key({ return: true }), enter as any)).toBe(true);
    expect(enter.beginClone.mock.calls).toEqual([[{ kind: "item" }, "claude", "u"]]);
    const blank = ctxIn({ ...clone, value: "  " } as Mode);
    expect(handleCloneKeys("", key({ return: true }), blank as any)).toBe(true);
    expect(blank.beginClone).not.toHaveBeenCalled();
  });

  test("an edit is a functional update that clears the stale error, and a no-op off the prompt", () => {
    const ctx = ctxIn(clone);
    expect(handleCloneKeys("þ", NONE, ctx as any)).toBe(true);
    const update = ctx.setMode.mock.calls[0][0] as (p: Mode) => Mode;
    expect(update(clone)).toEqual({ ...clone, value: "abþ", cursor: 3, error: undefined });
    const other = { kind: "list" } as Mode;
    expect(update(other)).toBe(other);
    expect(cloneEdit(clearLine)(clone)).toEqual({ ...clone, value: "", cursor: 0, error: undefined });
  });

  test("a paste keeps its letters and loses its newline; a key that is not an edit is swallowed", () => {
    expect(stripPasteControls("https://x/Þróun/_git/r\r\n")).toBe("https://x/Þróun/_git/r");
    const paste = ctxIn(clone);
    handleCloneKeys("u\r\n", NONE, paste as any);
    expect((paste.setMode.mock.calls[0][0] as (p: Mode) => Mode)(clone)).toMatchObject({ value: "abu", cursor: 3 });
    const newline = ctxIn(clone);
    expect(handleCloneKeys("\r\n", NONE, newline as any)).toBe(true);
    expect(newline.setMode).not.toHaveBeenCalled();
    const stray = ctxIn(clone);
    expect(handleCloneKeys("x", key({ ctrl: true }), stray as any)).toBe(true);
    expect(stray.setMode).not.toHaveBeenCalled();
  });
});

describe("handleCloningKeys", () => {
  test("esc cancels; every other key is ignored; declines when no clone is running", () => {
    const cloning = { kind: "cloning" } as Mode;
    const esc = ctxIn(cloning);
    expect(handleCloningKeys("", key({ escape: true }), esc as any)).toBe(true);
    expect(esc.cancelClone).toHaveBeenCalledTimes(1);
    const stray = ctxIn(cloning);
    expect(handleCloningKeys("q", NONE, stray as any)).toBe(true);
    expect(stray.cancelClone).not.toHaveBeenCalled();
    expect(handleCloningKeys("", key({ escape: true }), ctxIn(clone) as any)).toBe(false);
  });
});
