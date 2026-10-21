// How the list page and the pinned orchestrator block share the terminal
// (src/ui/hooks/useViewport.ts). e2e drives the TUI at one generous size, where
// both always fit; the arm where they don't — a short terminal, a block of
// five lines — only shows up here.
import { describe, expect, test } from "bun:test";
import { pageLayout } from "../src/ui/hooks/useViewport.ts";

describe("pageLayout", () => {
  test("room for both: the block is shown whole, and its lines come off the page", () => {
    expect(pageLayout(40, 6, 5)).toEqual({ pageSize: 29, pinsShown: 5 });
  });

  test("no block: the page has everything the chrome leaves", () => {
    expect(pageLayout(24, 6, 0)).toEqual({ pageSize: 18, pinsShown: 0 });
  });

  test("too short for both: the block gives way, and the frame is exactly the terminal", () => {
    const got = pageLayout(12, 6, 5);
    expect(got).toEqual({ pageSize: 3, pinsShown: 3 });
    expect(6 + got.pinsShown + got.pageSize).toBe(12);
  });

  test("too short even for the page's floor: no block at all, the floor holds", () => {
    expect(pageLayout(8, 6, 5)).toEqual({ pageSize: 3, pinsShown: 0 });
  });
});
