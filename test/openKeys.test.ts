// The open-in-browser dialog's keys (src/ui/keys/open.ts). The e2e suite opens
// the dialog and follows the PR link; it never presses `i`, never cancels with
// `q`, never presses a letter the dialog has no link for, and never sends
// ctrl-c into it.
import { describe, expect, mock, test } from "bun:test";
import type { Key } from "ink";
import type { Mode } from "../src/ui/keys/context.ts";
import { handleOpenKeys, openTargetOf } from "../src/ui/keys/open.ts";
import { V } from "../src/ui/vocabState.ts";

const NONE: Key = {
  upArrow: false, downArrow: false, leftArrow: false, rightArrow: false, pageDown: false, pageUp: false,
  return: false, escape: false, ctrl: false, shift: false, tab: false, backspace: false, delete: false, meta: false,
};
const key = (k: Partial<Key> = {}): Key => ({ ...NONE, ...k });
const pr = { id: 7, url: "https://example.test/pr/7" };
const workItem = { id: 42, url: "https://example.test/wi/42" };
const dialog = (targets: { pr?: typeof pr; workItem?: typeof workItem }): Mode => ({ kind: "open", targets, title: "t" });
const ctxIn = (mode: Mode) => ({ mode, setMode: mock(), openInBrowser: mock(), exit: mock() });

describe("openTargetOf", () => {
  test("p is the PR and i the issue, each only when the dialog has it", () => {
    expect(openTargetOf("p", { pr, workItem })).toEqual({ target: pr, label: `PR ${V.prPrefix}7` });
    expect(openTargetOf("i", { pr, workItem })).toEqual({ target: workItem, label: "#42" });
    expect(openTargetOf("p", { workItem })).toBeNull();
    expect(openTargetOf("i", { pr })).toBeNull();
    expect(openTargetOf("x", { pr, workItem })).toBeNull();
  });
});

describe("handleOpenKeys", () => {
  test("not its mode: untouched and unhandled", () => {
    const ctx = ctxIn({ kind: "list" });
    expect(handleOpenKeys("p", key(), ctx)).toBe(false);
    expect(ctx.openInBrowser).not.toHaveBeenCalled();
  });

  test("escape and q close it; a letter opens its link; ctrl-c exits; anything else is swallowed", () => {
    const esc = ctxIn(dialog({ pr }));
    expect(handleOpenKeys("", key({ escape: true }), esc)).toBe(true);
    expect(esc.setMode).toHaveBeenCalledWith({ kind: "list" });
    const q = ctxIn(dialog({ pr }));
    handleOpenKeys("q", key(), q);
    expect(q.setMode).toHaveBeenCalledWith({ kind: "list" });
    const open = ctxIn(dialog({ pr, workItem }));
    handleOpenKeys("i", key(), open);
    expect(open.openInBrowser).toHaveBeenCalledWith(workItem, "#42");
    expect(open.setMode).not.toHaveBeenCalled();
    const quit = ctxIn(dialog({ pr }));
    handleOpenKeys("c", key({ ctrl: true }), quit);
    expect(quit.exit).toHaveBeenCalledTimes(1);
    const swallowed = ctxIn(dialog({ pr }));
    expect(handleOpenKeys("i", key(), swallowed)).toBe(true);
    expect(swallowed.openInBrowser).not.toHaveBeenCalled();
    expect(swallowed.exit).not.toHaveBeenCalled();
    expect(swallowed.setMode).not.toHaveBeenCalled();
  });
});
