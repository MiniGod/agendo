// The order a key is offered to the handlers (src/ui/keys/chain.ts). Every
// e2e keypress runs the real chain; what it cannot pin is the rule itself —
// that the walk stops at the first taker and that the list's handler is the
// last link — without a handler that behaves to order.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import { KEY_HANDLERS, dispatchKey, type KeyHandler } from "../src/ui/keys/chain.ts";
import type { KeyContext } from "../src/ui/keys/context.ts";
import { handleCleanupModeKeys } from "../src/ui/keys/cleanup.ts";
import { handleListKeys } from "../src/ui/keys/list.ts";
import { handleOpenKeys } from "../src/ui/keys/open.ts";

const ctx = {} as KeyContext;
const key = {} as Key;

describe("dispatchKey", () => {
  test("stops at the first handler that takes the key; one nobody takes visits every link", () => {
    const taken: KeyHandler[] = [mock(() => false), mock(() => true), mock(() => false)];
    dispatchKey("x", key, ctx, taken);
    expect(taken.map((h) => (h as ReturnType<typeof mock>).mock.calls.length)).toEqual([1, 1, 0]);
    expect(taken[0]).toHaveBeenCalledWith("x", key, ctx);
    const nobody: KeyHandler[] = [mock(() => false), mock(() => false)];
    dispatchKey("x", key, ctx, nobody);
    expect(nobody.map((h) => (h as ReturnType<typeof mock>).mock.calls.length)).toEqual([1, 1]);
  });
});

describe("KEY_HANDLERS", () => {
  test("the cleanup view's guard is asked first, the open prompt next, and the list last", () => {
    // The cleanup view reads its own keys; the guard keeps every other handler
    // — the search, the global q/esc, the list — from seeing them too.
    expect(KEY_HANDLERS[0]).toBe(handleCleanupModeKeys);
    expect(KEY_HANDLERS[1]).toBe(handleOpenKeys);
    expect(KEY_HANDLERS.at(-1)).toBe(handleListKeys);
    expect(new Set(KEY_HANDLERS).size).toBe(KEY_HANDLERS.length);
  });
});
