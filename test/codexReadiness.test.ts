// The codex pane classifier (src/tmux/codex.ts) over the real captures in
// e2e/fixtures. e2e/detection.spec.ts asserts the same verdicts, but it runs
// in Playwright's own process, outside the instrumented bun the CRAP
// measurement watches — so to the gate every line of `codexReadiness` was
// never entered. This is the same table, walked where it is counted.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { codexPane, codexReadiness } from "../src/tmux/codex.ts";
import { stripAnsi } from "../src/tmux/pane.ts";
import { paneReadiness } from "../src/tmux/paneReadiness.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "e2e", "fixtures", name), "utf-8");
const cursor = (name: string) => {
  const m = fixture(name).trim().match(/^(\d+)\s+(\d+)$/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};
const pane = (name: string) => {
  const p = codexPane(fixture(name));
  expect(p, `${name} must be recognised as a codex pane`).not.toBeNull();
  return p!;
};

const ESC = String.fromCharCode(27);

/** `/statusline` with the run-state field unchecked: blank the word out of the footer line only. */
function dropRunState(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!stripAnsi(lines[i]).trim()) continue;
    // The word is SGR-wrapped, so it sits at the end of an ESC-delimited
    // segment: `[0;2mReady`. Split on the byte to keep it out of the pattern.
    lines[i] = lines[i]
      .split(ESC)
      .map((seg) => seg.replace(/^(\[[0-9;]*m)(Ready|Working|Thinking)$/, "$1"))
      .join(ESC);
    break;
  }
  const out = lines.join("\n");
  const footer = stripAnsi(out).split("\n").filter((l) => l.trim()).pop() ?? "";
  expect(footer).not.toMatch(/\b(Ready|Working|Thinking)\b/);
  return out;
}

describe("codexReadiness", () => {
  test("settled reads ready, a typed draft queued — with and without the caret", () => {
    expect(codexReadiness(pane("codex-idle.ansi"))).toBe("ready");
    expect(codexReadiness(pane("codex-idle.ansi"), cursor("codex-idle.cursor"))).toBe("ready");
    expect(codexReadiness(pane("codex-done.ansi"))).toBe("ready");
    expect(codexReadiness(pane("codex-draft.ansi"), cursor("codex-draft.cursor"))).toBe("queued");
    expect(paneReadiness(fixture("codex-draft.ansi"))).toBe("queued");
  });

  test("mid-turn reads busy off the footer, and off the status line alone when run-state is off", () => {
    expect(codexReadiness(pane("codex-busy.ansi"))).toBe("busy");
    expect(codexReadiness(pane("codex-busy-approval.ansi"), cursor("codex-busy-approval.cursor"))).toBe("busy");
    expect(codexReadiness(codexPane(dropRunState(fixture("codex-busy.ansi")))!)).toBe("busy");
  });

  // The real dialog capture ends in the dialog's own footer, so the recogniser
  // rejects it and paneReadiness reaches "dialog" by the claude path instead.
  // The classifier's own ordering — dialog before run-state — is pinned on a
  // recognised pane whose capture holds the dialog.
  test("a dialog outranks a footer still saying Ready", () => {
    const dialog = fixture("codex-dialog.ansi");
    expect(stripAnsi(dialog)).toContain("Ready");
    expect(codexReadiness({ ...pane("codex-idle.ansi"), raw: dialog })).toBe("dialog");
    expect(paneReadiness(dialog, cursor("codex-dialog.cursor"))).toBe("dialog");
  });

  test("without a positive Ready, or without a box to measure, the answer is unknown", () => {
    // Run-state off and no turn running: the recogniser itself declines, and
    // the pane falls through to the claude path's "unknown".
    expect(codexPane(dropRunState(fixture("codex-idle.ansi")))).toBeNull();
    expect(paneReadiness(dropRunState(fixture("codex-idle.ansi")), cursor("codex-idle.cursor"))).toBe("unknown");
    // The classifier holds the same line on its own: no word, no "ready".
    const idle = pane("codex-idle.ansi");
    expect(codexReadiness({ ...idle, footer: { ...idle.footer, state: null } })).toBe("unknown");
    expect(codexReadiness({ ...idle, box: null })).toBe("unknown");
  });
});
