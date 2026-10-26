// How the Settings page and its team picker fit a short terminal
// (src/ui/models/settingsLayout.ts). The e2e suite opens the page once in a
// terminal too short for its rows and walks to the last one; the window's
// clamping at both ends and the hidden-row line's every shape sit here.
import { describe, expect, test } from "bun:test";
import { hiddenRowsText, settingsChrome, settingsWindow } from "../src/ui/models/settingsLayout.ts";

describe("settingsChrome", () => {
  test("everything but the rows, plus Ink's last line; the note only when there is one", () => {
    expect(settingsChrome(2, false)).toBe(11);
    expect(settingsChrome(2, true)).toBe(12);
  });

  test("the page's twelve rows fit a classic 24-line terminal, note included", () => {
    expect(settingsWindow(11, 12, 24 - settingsChrome(2, true))).toEqual({ start: 0, end: 12 });
  });
});

describe("settingsWindow", () => {
  test("every row when they fit", () => {
    expect(settingsWindow(5, 12, 12)).toEqual({ start: 0, end: 12 });
  });

  test("otherwise a window one line shorter than the room, the cursor in its middle", () => {
    expect(settingsWindow(6, 12, 6)).toEqual({ start: 4, end: 9 });
  });

  test("clamped at both ends, the cursor always inside", () => {
    expect(settingsWindow(0, 12, 6)).toEqual({ start: 0, end: 5 });
    expect(settingsWindow(11, 12, 6)).toEqual({ start: 7, end: 12 });
  });

  test("never less than one row, however little room", () => {
    expect(settingsWindow(3, 12, 0)).toEqual({ start: 3, end: 4 });
    expect(settingsWindow(3, 12, -5)).toEqual({ start: 3, end: 4 });
  });
});

describe("hiddenRowsText", () => {
  test("names what is above and below, and is absent when nothing is hidden", () => {
    expect(hiddenRowsText(0, 0)).toBeNull();
    expect(hiddenRowsText(2, 0)).toBe("  ↑ 2 more");
    expect(hiddenRowsText(0, 4)).toBe("  ↓ 4 more");
    expect(hiddenRowsText(2, 4)).toBe("  ↑ 2 more · ↓ 4 more");
  });
});
