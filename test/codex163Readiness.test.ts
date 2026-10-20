// The codex classifier over codex 0.163's layout: real captures in
// e2e/fixtures/codex163-*.ansi, taken from a throwaway session on a private tmux
// server and sterilized (the scratch cwd swapped for a /home/user path of the
// SAME length, so the bar truncates exactly where it did live).
//
// What 0.163 changed, and what each capture pins:
//   - codex163-idle / -done      a key-hint row (`? for shortcuts`, `⚠ 2 warnings
//                                · f2 to view`) now sits UNDER the status bar, so
//                                the bar is no longer the last line. Both read
//                                "unknown" before, so `wait` never settled.
//   - codex163-busy / -busy-tail the turn, and its last few hundred ms: the busy
//                                line already gone, the bar still `Working`.
//   - codex163-sent              Enter taken, the message echoed, the box empty —
//                                and the bar STILL `Ready`. Why `send` waits for
//                                the turn to show before returning.
//   - codex163-*-truncated       a 160-column pane: the bar cut at `· Rea…`/`Wor…`.
//   - codex163-starting          `Starting` while MCP servers boot.
//   - codex163-startup-wait      a message sent during that boot: held, with
//                                `Waiting for startup  · esc cancel` on the hint
//                                row and the bar truncated before its run-state.
//   - codex163-trust             the folder-trust list, reworded to `enter continue
//                                · esc quit`, which `isDialog` doesn't know.
//   - codex163-draft / -pasted / -draft-multiline / -mention-popup
//                                drafts: short, a paste collapsed to `[Pasted
//                                Content 3023 chars]`, a six-paragraph paste whose
//                                prompt row sits fourteen rows above the bar, and
//                                an `@READ` completion popup drawn above the box.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { codexComposerText, codexPane, codexReadiness, codexStartupHeld } from "../src/runtime/tmux/codex.ts";
import { stripAnsi } from "../src/runtime/tmux/pane.ts";
import { paneReadiness } from "../src/runtime/tmux/paneReadiness.ts";
import type { Readiness } from "../src/runtime/tmux/readiness.ts";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "..", "e2e", "fixtures", `codex163-${name}.ansi`), "utf-8");
const cursor = (name: string) => {
  const [x, y] = readFileSync(join(import.meta.dirname, "..", "e2e", "fixtures", `codex163-${name}.cursor`), "utf-8").trim().split(/\s+/).map(Number);
  return { x, y };
};
/** The verdict with and without the caret, which must agree on every capture here. */
const verdicts = (name: string) => [paneReadiness(fixture(name)), paneReadiness(fixture(name), cursor(name))];

/** Rewrite the one line of `raw` that contains `find`. */
function onLine(raw: string, find: string, edit: (line: string) => string): string {
  const lines = raw.split("\n");
  const i = lines.findIndex((l) => l.includes(find));
  expect(i, `no line contains ${find}`).toBeGreaterThanOrEqual(0);
  lines[i] = edit(lines[i]);
  return lines.join("\n");
}

/** Replace the box's prompt row (the last line starting `›`) with `rows`. */
function withBox(raw: string, rows: string[]): string {
  const lines = raw.split("\n");
  const i = lines.findLastIndex((l) => stripAnsi(l).startsWith("›"));
  lines.splice(i, 1, ...rows);
  return lines.join("\n");
}

describe("codex 0.163 layout", () => {
  test("idle and finished read ready, with the hint row under the bar", () => {
    const tail = stripAnsi(fixture("idle")).trimEnd().split("\n").slice(-2);
    expect(tail[0]).toContain(" · Ready · ");
    expect(tail[1]).toContain("? for shortcuts");
    expect(verdicts("idle")).toEqual(["ready", "ready"]);
    expect(verdicts("done")).toEqual(["ready", "ready"]);
  });

  test("a running turn reads busy, through its tail where only the bar still says so", () => {
    expect(verdicts("busy")).toEqual(["busy", "busy"]);
    expect(stripAnsi(fixture("busy-tail"))).not.toMatch(/esc to interrupt/);
    expect(verdicts("busy-tail")).toEqual(["busy", "busy"]);
  });

  test("the submit-to-busy gap reads ready: the message is gone from the box before the bar changes", () => {
    expect(stripAnsi(fixture("sent"))).toContain("› Reply with exactly the word: ok");
    expect(verdicts("sent")).toEqual(["ready", "ready"]);
    expect(codexComposerText(fixture("sent"))).toBe("");
  });

  test("a bar truncated at the pane edge still names its run-state", () => {
    expect(stripAnsi(fixture("idle-truncated"))).toMatch(/ · Rea…\n/);
    expect(verdicts("idle-truncated")).toEqual(["ready", "ready"]);
    expect(stripAnsi(fixture("busy-truncated"))).toMatch(/ · Wor…\n/);
    expect(verdicts("busy-truncated")).toEqual(["busy", "busy"]);
    expect(paneReadiness(onLine(fixture("idle-truncated"), "Rea…", (l) => l.replace("Rea…", "Sta…")))).toBe("busy");
    // Cut just after the word, the separator's `·` and spaces can land before the
    // ellipsis too (codex163-startup-wait ends `play ·…`).
    const cuts: [string, Readiness][] = [["Ready ·…", "ready"], ["Ready …", "ready"], ["Ready…", "ready"], ["Working ·…", "busy"]];
    for (const [tail, verdict] of cuts) {
      expect(paneReadiness(onLine(fixture("idle-truncated"), "Rea…", (l) => l.replace("Rea…", tail))), tail).toBe(verdict);
    }
  });

  test("a truncated stem only counts when it is long enough, capitalised, and last", () => {
    const idle = fixture("idle-truncated");
    // One letter could be anything; lower case is a path or a branch.
    expect(codexPane(onLine(idle, "Rea…", (l) => l.replace("Rea…", "R…")))).toBeNull();
    expect(codexPane(onLine(idle, "Rea…", (l) => l.replace("Rea…", "rea…")))).toBeNull();
    // Not the last field: a cut-short word mid-bar is not a truncation.
    expect(codexPane(onLine(idle, "Rea…", (l) => l.replace("Rea…", "Rea… · Approve for me")))).toBeNull();
    // Cut before the run-state entirely: nothing to read, so not recognised —
    // and the claude path that takes over has no box either.
    const gone = onLine(idle, "Rea…", (l) => l.replace(" · \u001b[38;2;200;169;238mRea…", " ·…"));
    expect(stripAnsi(gone)).toMatch(/play ·…\n/);
    expect(codexPane(gone)).toBeNull();
    expect(paneReadiness(gone)).toBe("unknown");
  });

  test("Starting, and a message held for startup, both read busy", () => {
    expect(stripAnsi(fixture("starting"))).toContain(" · Starting · ");
    expect(verdicts("starting")).toEqual(["busy", "busy"]);
    // The bar is cut before its run-state here, so the hint row is all there is.
    expect(stripAnsi(fixture("startup-wait"))).toMatch(/play ·…\n\s+Waiting for startup/);
    expect(verdicts("startup-wait")).toEqual(["busy", "busy"]);
  });

  test("the reworded folder-trust list is a dialog", () => {
    expect(stripAnsi(fixture("trust"))).toContain("enter continue · esc quit");
    expect(verdicts("trust")).toEqual(["dialog", "dialog"]);
    expect(codexComposerText(fixture("trust"))).toBeNull();
    // With the cursor on the second option, the first is the neighbour.
    const second = onLine(onLine(fixture("trust"), "1. Trust", (l) => l.replace("›", " ")), "2. Quit", (l) => l.replace("  2.", "› 2."));
    expect(paneReadiness(second)).toBe("dialog");
  });

  test("a draft that looks like a numbered list is still a draft", () => {
    // The box sits right above the bar, so its `› 1.` is not a selection
    // cursor — even with a second numbered row and an enter/esc hint below it.
    const listy = withBox(fixture("draft"), ["› 1. first", "  2. second"]);
    const hinted = onLine(listy, "2 warnings", () => "  enter send · esc clear");
    expect(paneReadiness(hinted)).toBe("queued");
    // A lone option row with nothing next to it isn't a list either.
    const lone = onLine(fixture("trust"), "2. Quit", () => "");
    expect(paneReadiness(lone)).toBe("unknown");
    // And the selected row must be the BOTTOM-most `›`: a transcript echo below
    // it (column 0) means the list is history.
    const history = onLine(fixture("trust"), "esc", (l) => `${l}\n› next message\n  enter continue · esc quit`);
    expect(paneReadiness(history)).toBe("unknown");
  });

  test("drafts read queued: short, collapsed paste, tall, and under a completion popup", () => {
    expect(verdicts("draft")).toEqual(["queued", "queued"]);
    expect(verdicts("pasted")).toEqual(["queued", "queued"]);
    expect(verdicts("draft-multiline")).toEqual(["queued", "queued"]);
    expect(verdicts("mention-popup")).toEqual(["queued", "queued"]);
  });

  test("the box walk stops at transcript, however tall the draft", () => {
    // No `›` row between the bar and a column-0 transcript line: no box.
    const noBox = withBox(fixture("idle"), ["• a reply line at column 0"]);
    expect(codexPane(noBox)?.box ?? null).toBeNull();
    expect(paneReadiness(noBox)).toBe("unknown");
    // Forty short lines: well under the paste placeholder's size, and all measured.
    const rows = Array.from({ length: 40 }, (_, i) => `  row ${i}`);
    const tall = withBox(fixture("draft"), ["› top", ...rows]);
    expect(paneReadiness(tall)).toBe("queued");
    expect(codexComposerText(tall)!.split("\n").map((l) => l.trim())).toEqual(["top", ...rows.map((r) => r.trim())]);
    // Its prompt row scrolled off the top: nothing to anchor on.
    const lines = tall.split("\n");
    const scrolled = lines.slice(lines.findIndex((l) => l === "  row 0")).join("\n");
    expect(codexPane(scrolled)?.box ?? null).toBeNull();
    expect(paneReadiness(scrolled)).toBe("unknown");
  });

  test("only the row under the bar can say codex is holding a message for its startup", () => {
    expect(codexPane(fixture("startup-wait"))!.held).toBe(true);
    expect(codexStartupHeld(fixture("startup-wait"))).toBe(true);
    expect(codexStartupHeld(fixture("idle"))).toBe(false);
    // The same words wrapped onto a row of the last reply, right above the box:
    // prose, which must not pin a finished turn to busy.
    const lines = fixture("done").split("\n");
    const box = lines.findLastIndex((l) => stripAnsi(l).startsWith("›"));
    lines.splice(box - 1, 0, "  the database container is slow to boot.", "  Waiting for startup checks took about 3s.");
    const quoting = lines.join("\n");
    expect(codexPane(quoting)!.held).toBe(false);
    expect(paneReadiness(quoting)).toBe("ready");
  });

  test("a message that mentions a dialog's key hint is not a dialog", () => {
    // Codex draws no rule under its box, so `isDialog` alone would take the
    // bottom-most `Press Enter to continue` anywhere — here the draft itself.
    for (const text of ["When the installer prints Press Enter to continue, press it", "It says Enter to confirm, Esc to cancel"]) {
      const draft = withBox(fixture("draft"), [`› ${text}`]);
      expect(paneReadiness(draft), text).toBe("queued");
      expect(codexComposerText(draft), text).toBe(text);
      // And once sent, its echo in the transcript.
      const sent = onLine(fixture("sent"), "Reply with exactly", (l) => l.replace("Reply with exactly the word: ok", text));
      expect(paneReadiness(sent), text).toBe("ready");
    }
  });

  test("a draft that starts `1.` is read from the bar too; only a list over a bar without a run-state is not", () => {
    const rows = ["› 1. Run the installer", "  2. When it prints Press Enter to continue, press it"];
    const numbered = withBox(fixture("draft"), rows);
    expect(paneReadiness(numbered)).toBe("queued");
    expect(codexComposerText(numbered)).toContain("Press Enter to continue");
    // The same shape with the run-state gone from the bar is how a selection list
    // sits, and the hint among its rows is read.
    const list = withBox(fixture("idle"), ["› 1. Yes, proceed", "  2. No, tell Codex what to do", "", "  Press enter to confirm or esc to cancel"]);
    const stateless = list.split("\n").map((l) => (stripAnsi(l).includes(" · Ready · ") ? stripAnsi(l).replace(" · Ready", "") : l)).join("\n");
    expect(stripAnsi(stateless)).not.toContain(" · Ready");
    expect(paneReadiness(stateless)).toBe("dialog");
  });

  test("a claude pane whose statusLine ends in a run-state word is still claude's", () => {
    // The row above the last on a claude pane is the user's statusLine, over its
    // mode row. 0.163's two-row footer search must not read it as codex's bar.
    const raw = readFileSync(join(import.meta.dirname, "..", "e2e", "fixtures", "limit-notice-task-panel.ansi"), "utf-8");
    const verdict = paneReadiness(raw);
    for (const statusLine of ["  Opus 5 · ~/git/example · Working", "  Opus 5 · ~/git/example · Sta…", "  Opus 5 · ~/git/example · Ready"]) {
      const swapped = onLine(raw, "12:40:00", () => statusLine);
      expect(codexPane(swapped), statusLine).toBeNull();
      expect(paneReadiness(swapped), statusLine).toBe(verdict);
    }
  });

  test("a draft quoting the busy line is a draft, not a turn", () => {
    // The rows between the prompt and the bar are the box itself, not status.
    const quoting = withBox(fixture("draft"), ["› look at this:", "  • Working (5s • esc to interrupt)"]);
    expect(paneReadiness(quoting)).toBe("queued");
  });
});

describe("codexComposerText", () => {
  test("reads what the box holds, placeholder as empty", () => {
    expect(codexComposerText(fixture("idle"))).toBe("");
    expect(codexComposerText(fixture("busy"))).toBe("");
    expect(codexComposerText(fixture("draft"))).toBe("Reply with exactly the word: ok");
    expect(codexComposerText(fixture("pasted"))).toBe("[Pasted Content 3023 chars]");
    expect(codexComposerText(fixture("mention-popup"))).toBe("Reply with exactly the word: ok, see @READ");
    const tall = codexComposerText(fixture("draft-multiline"))!;
    expect(tall.startsWith("Reply with exactly the word: ok")).toBe(true);
    expect(tall.match(/This is filler context/g)?.length).toBe(6);
  });

  test("a `›` inside the draft reads back as `>`", () => {
    expect(codexComposerText(withBox(fixture("draft"), ["\u001b[1m›\u001b[0m quote › this"]))).toBe("quote > this");
  });

  test("null wherever the box can't be measured", () => {
    expect(codexComposerText("")).toBeNull();
    expect(codexComposerText(fixture("trust"))).toBeNull();
    // Recognised by its hint row, but the bar's run-state is cut away.
    expect(codexComposerText(fixture("startup-wait"))).toBeNull();
    expect(codexComposerText(withBox(fixture("idle"), ["• transcript"]))).toBeNull();
  });
});

describe("codexReadiness on a recognised pane", () => {
  test("a footerless dialog pane is still a dialog", () => {
    const p = codexPane(fixture("trust"))!;
    expect(codexReadiness({ ...p, footer: null })).toBe("dialog");
  });
});
