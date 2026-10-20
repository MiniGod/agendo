// Codex delivery with read-back (src/runtime/tmux/codexDelivery.ts), driven
// against a simulated codex instead of tmux: every frame it serves is the real
// codex 0.163 idle capture with the box row and the bar's run-state rewritten,
// so the read-back goes through the same classifier a live pane does. The clock
// is simulated too: `sleep` advances it, so the bounded waits run instantly.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  CODEX_ENTER_WAITS_MS, CODEX_INGEST_MS, codexPasteText, deliverToCodex, pasteLanded, submitView, type CodexIo,
} from "../src/runtime/tmux/codexDelivery.ts";
import { stripAnsi } from "../src/runtime/tmux/pane.ts";

const IDLE = readFileSync(join(import.meta.dirname, "..", "e2e", "fixtures", "codex163-idle.ansi"), "utf-8").split("\n");
const BOX_ROW = IDLE.findLastIndex((l) => stripAnsi(l).startsWith("›"));
const BAR_ROW = IDLE.findIndex((l) => stripAnsi(l).includes(" · Ready · "));
const HINT_ROW = BAR_ROW + 1;
const ESC = "\u001b";

/**
 * A codex 0.163 screen with `box` in the input box (dim placeholder when empty;
 * one row per line, continuation rows indented two columns as codex draws them)
 * and `state` on the bar. `held` puts the startup hold on the hint row.
 */
function frame(box: string, state: "Ready" | "Working", held = false): string {
  const lines = [...IDLE];
  lines[BAR_ROW] = lines[BAR_ROW].replace("Ready", state);
  if (held) lines[HINT_ROW] = `  ${ESC}[1mWaiting for startup${ESC}[0m  · ${ESC}[1mesc${ESC}[0m cancel`;
  // With a draft in the box, codex clears the hint's left half (codex163-draft).
  else if (box !== "") lines[HINT_ROW] = lines[HINT_ROW].replace(`${ESC}[1m?${ESC}[0m for shortcuts`, " ".repeat(15));
  const [first, ...rest] = box.split("\n");
  const rows = box === "" ? [`${ESC}[1m›${ESC}[0m ${ESC}[2mAsk Codex to do anything${ESC}[0m`] : [`${ESC}[1m›${ESC}[0m ${first}`, ...rest.map((l) => `  ${l}`)];
  lines.splice(BOX_ROW, 1, ...rows);
  return lines.join("\n");
}

/** Knobs for the simulated codex. Counts are in pane reads, the sim's clock. */
interface SimOpts {
  /** Reads before a paste shows in the box; Infinity never. */
  ingestReads?: number;
  /** Enters swallowed outright before one is taken. */
  dropEnters?: number;
  /** Instead of submitting, the first Enter rewrites the box to this (a completion). */
  rewriteTo?: string;
  /** After a taken Enter, reads that still show `Ready` before `Working`; Infinity never. */
  lagReads?: number;
  /** After an Enter, the pane reads blank (something we can't classify). */
  blankAfterEnter?: boolean;
  /** One stray frame with this in the box, right after the first Enter. */
  glitch?: string;
  /** The box before anything is typed. */
  initial?: string;
  /** The very first read fails (blank). */
  unreadable?: boolean;
  /** A taken Enter is held for codex's startup for this many reads before the turn runs. */
  holdReads?: number;
  /** The startup hold is already showing before anything is typed (someone else's message). */
  heldAlready?: boolean;
}

function sim(opts: SimOpts = {}) {
  const log: string[] = [];
  let box = opts.initial ?? "";
  let pending: { text: string; reads: number } | null = null;
  let drops = opts.dropEnters ?? 0;
  let busyIn: number | null = null;
  let glitch: string | null = null;
  let blank = false;
  let hold = 0;
  let t = 0;
  let reads = 0;
  const io: CodexIo = {
    read() {
      reads++;
      if (opts.unreadable && reads === 1) return "";
      if (pending && --pending.reads <= 0) {
        box += pending.text;
        pending = null;
      }
      if (busyIn !== null && busyIn > 0) busyIn--;
      if (hold > 0 && --hold === 0) {
        log.push(`submitted:${box}`);
        box = "";
        busyIn = 0;
      }
      if (blank) return "";
      if (glitch !== null) {
        const g = glitch;
        glitch = null;
        return frame(g, "Ready");
      }
      return frame(box, busyIn === 0 ? "Working" : "Ready", hold > 0 || opts.heldAlready);
    },
    paste(text) {
      log.push(`paste:${text}`);
      pending = { text, reads: opts.ingestReads ?? 1 };
    },
    enter() {
      log.push(`enter:${box}`);
      if (opts.blankAfterEnter) blank = true;
      if (opts.glitch !== undefined && !log.includes("glitched")) {
        log.push("glitched");
        glitch = opts.glitch;
      }
      if (pending !== null || box === "") return; // nothing in the box to submit yet
      if (opts.rewriteTo !== undefined) {
        box = opts.rewriteTo;
        return;
      }
      if (drops > 0) {
        drops--;
        return;
      }
      if (opts.holdReads !== undefined) {
        // Codex is still starting: the message stays in the box, held.
        if (hold === 0) hold = opts.holdReads;
        return;
      }
      log.push(`submitted:${box}`);
      box = "";
      busyIn = (opts.lagReads ?? 2) + 1;
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
  };
  return { io, log, elapsed: () => t };
}

const pastes = (log: string[]) => log.filter((l) => l.startsWith("paste:")).length;
const enters = (log: string[]) => log.filter((l) => l.startsWith("enter:"));

describe("deliverToCodex", () => {
  test("pastes once, presses Enter once the text is in the box, and sees the turn start", async () => {
    const s = sim();
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toEqual({ ok: true, enters: 1, turnStarted: true, held: false, composer: "" });
    expect(pastes(s.log)).toBe(1);
    // Enter went out against a box that already held the message.
    expect(enters(s.log)).toEqual(["enter:Reply with ok"]);
    expect(s.log).toContain("submitted:Reply with ok");
  });

  test("slow ingestion: Enter waits for the paste to show, however late", async () => {
    const s = sim({ ingestReads: 25 });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d.ok).toBe(true);
    expect(d.enters).toBe(1);
    expect(enters(s.log)).toEqual(["enter:Reply with ok"]);
  });

  test("a dropped Enter is pressed again — the message is never typed twice", async () => {
    const s = sim({ dropEnters: 2 });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d.ok).toBe(true);
    expect(d.enters).toBe(3);
    expect(pastes(s.log)).toBe(1);
    expect(s.log.filter((l) => l.startsWith("submitted:"))).toEqual(["submitted:Reply with ok"]);
  });

  test("an Enter that never takes is a failure after a bounded number of presses", async () => {
    const s = sim({ dropEnters: Infinity });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toMatchObject({ ok: false, reason: "not-submitted", enters: CODEX_ENTER_WAITS_MS.length, composer: "Reply with ok" });
    expect(pastes(s.log)).toBe(1);
    // Bounded in time as well as in presses.
    const budget = CODEX_INGEST_MS + CODEX_ENTER_WAITS_MS.reduce((a, b) => a + b, 0);
    expect(s.elapsed()).toBeLessThanOrEqual(budget);
  });

  test("a paste that never shows gets no Enter at all", async () => {
    const s = sim({ ingestReads: Infinity });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toMatchObject({ ok: false, reason: "not-ingested", enters: 0, composer: "" });
    expect(enters(s.log)).toEqual([]);
    expect(s.elapsed()).toBeGreaterThanOrEqual(CODEX_INGEST_MS);
  });

  test("a completion that rewrites the draft stops delivery without another Enter", async () => {
    const s = sim({ rewriteTo: "see @README.md " });
    const d = await deliverToCodex(s.io, "see @READ!");
    expect(d).toMatchObject({ ok: false, reason: "draft-rewritten", enters: 1, composer: "see @README.md" });
  });

  test("one stray frame after Enter is not mistaken for a rewrite", async () => {
    const s = sim({ glitch: "Reply wi" });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d.ok).toBe(true);
  });

  test("a box that can't be read after Enter ends it: no Enter into an unknown screen", async () => {
    const s = sim({ blankAfterEnter: true });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toMatchObject({ ok: false, reason: "lost-sight", enters: 1, composer: null });
  });

  test("an unreadable box before typing: nothing typed", async () => {
    const s = sim({ unreadable: true });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toMatchObject({ ok: false, reason: "unreadable", enters: 0 });
    expect(s.log).toEqual([]);
  });

  test("taken but the turn never shows: delivered, and says so", async () => {
    const s = sim({ lagReads: Infinity });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toEqual({ ok: true, enters: 1, turnStarted: false, held: false, composer: "" });
  });

  test("a slash command that starts no turn reads null, not false", async () => {
    const s = sim({ lagReads: Infinity });
    const d = await deliverToCodex(s.io, "/status");
    expect(d).toEqual({ ok: true, enters: 1, turnStarted: null, held: false, composer: "" });
  });

  test("one that does start a turn is waited for like any message", async () => {
    // `/review` runs a turn, and so does a message that merely starts with a path.
    for (const message of ["/review", "/tmp/x is broken"]) {
      const d = await deliverToCodex(sim().io, message);
      expect(d, message).toMatchObject({ ok: true, turnStarted: true });
    }
  });

  test("held for codex's startup is taken: no second Enter while the message waits in the box", async () => {
    const s = sim({ holdReads: 20 });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toMatchObject({ ok: true, enters: 1, held: true, turnStarted: null });
    expect(enters(s.log)).toEqual(["enter:Reply with ok"]);
  });

  test("a hold that was already showing proves nothing about our Enter", async () => {
    const s = sim({ heldAlready: true, dropEnters: Infinity });
    const d = await deliverToCodex(s.io, "Reply with ok");
    expect(d).toMatchObject({ ok: false, reason: "not-submitted", enters: CODEX_ENTER_WAITS_MS.length, held: false });
  });

  test("a message of several lines is read back across the box's rows", async () => {
    const s = sim();
    const d = await deliverToCodex(s.io, "first line\nsecond line\nthird line");
    expect(d).toMatchObject({ ok: true, enters: 1 });
    expect(s.log).toContain("submitted:first line\nsecond line\nthird line");
  });

  test("a message ending in an @-mention is pasted with a trailing space", async () => {
    const s = sim();
    await deliverToCodex(s.io, "look at @src/index.ts");
    expect(s.log[0]).toBe("paste:look at @src/index.ts ");
  });

  test("on top of an existing draft (forced), the whole box goes", async () => {
    const s = sim({ initial: "half typed " });
    const d = await deliverToCodex(s.io, "and the rest");
    expect(d.ok).toBe(true);
    expect(s.log).toContain("submitted:half typed and the rest");
  });
});

describe("codexPasteText", () => {
  test("a trailing @file or $skill token gets a space; anything else is untouched", () => {
    expect(codexPasteText("see @READ")).toBe("see @READ ");
    expect(codexPasteText("@READ")).toBe("@READ ");
    expect(codexPasteText("use $pdf")).toBe("use $pdf ");
    expect(codexPasteText("see @READ and go")).toBe("see @READ and go");
    expect(codexPasteText("mail a@b.c")).toBe("mail a@b.c");
    expect(codexPasteText("see @READ ")).toBe("see @READ ");
    expect(codexPasteText("first line\n@last")).toBe("first line\n@last ");
  });
});

describe("pasteLanded", () => {
  test("the message at the end of the box, whitespace aside", () => {
    expect(pasteLanded("", "Reply with ok", "Reply with ok")).toBe(true);
    expect(pasteLanded("", "Reply with\n  ok", "Reply with ok")).toBe(true);
    expect(pasteLanded("draft ", "draft Reply with ok", "Reply with ok")).toBe(true);
  });

  test("a box scrolled to the message's end, or collapsed to a placeholder", () => {
    expect(pasteLanded("", "…the very end of it", "a long start and the very end of it")).toBe(false);
    expect(pasteLanded("", "the very end of it", "a long start and the very end of it")).toBe(true);
    expect(pasteLanded("", "[Pasted Content 3023 chars]", "x".repeat(3023))).toBe(true);
    expect(pasteLanded("[Pasted Content 10 chars]", "[Pasted Content 10 chars]", "x".repeat(3023))).toBe(false);
  });

  test("unchanged, empty, or only the start: not yet", () => {
    expect(pasteLanded("", "", "Reply with ok")).toBe(false);
    expect(pasteLanded("same", "same", "same")).toBe(false);
    expect(pasteLanded("", "Reply wi", "Reply with ok")).toBe(false);
  });

  test("a `›` in the message matches the `>` the box reads back", () => {
    expect(pasteLanded("", "quote > this", "quote › this")).toBe(true);
  });
});

describe("submitView", () => {
  test("empty is taken, the paste is pending, anything else a rewrite, null unreadable", () => {
    expect(submitView("Reply with ok", "")).toBe("submitted");
    expect(submitView("Reply with ok", "Reply with\nok")).toBe("pending");
    expect(submitView("see @READ", "see @README.md")).toBe("rewritten");
    expect(submitView("Reply with ok", null)).toBe("unreadable");
  });
});
