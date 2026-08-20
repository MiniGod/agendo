import { describe, expect, test } from "bun:test";
import { approvalCell, approvalInline, fit, padCell, prBadge } from "../src/ui/format.ts";
import type { PullRequest } from "../src/types.ts";

// The width helpers in src/ui/format.ts are the densest logic in the repo and
// the e2e suite cannot reach them: every fixture value that flows into a table
// cell is ASCII, which is exactly the input class for which the old and new
// implementations agree. These tests exist because a green e2e run proves
// nothing about the behaviour this code was written to fix.

/**
 * Columns a string occupies, recovered through the public API rather than by
 * exporting the internal measure: `padCell` pads with exactly `w - width`
 * spaces, so the pad count reveals the width it computed.
 */
function widthOf(s: string): number {
  const W = 40;
  return W - (padCell(s, W).length - s.length);
}

describe("padCell — ASCII equivalence", () => {
  // The property the conversion of ~14 call sites rests on: for printable
  // ASCII, padCell(s, w) is byte-identical to the `padEnd(w).slice(0, w)` the
  // call sites used before. If this fails, a rendering that exists today moved.
  test("is byte-identical to padEnd(w).slice(0, w) for printable ASCII", () => {
    const chars = " !#Aa9_~-./:|[]{}()";
    let seed = 12345;
    const rnd = (n: number) => {
      let o = "";
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        o += chars[seed % chars.length];
      }
      return o;
    };
    const mismatches: string[] = [];
    for (let w = 0; w <= 30; w++) {
      for (let len = 0; len <= 40; len++) {
        for (let k = 0; k < 4; k++) {
          const s = rnd(len);
          if (padCell(s, w) !== s.padEnd(w).slice(0, w)) mismatches.push(`w=${w} ${JSON.stringify(s)}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  test("shortId's invariants hold, so leaving those two sites unconverted is safe", () => {
    // src/tmux.ts shortId(): id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12).
    // Both CLI tables still spell those cells `.padEnd(12)`; that is only
    // correct while the value is ASCII and never longer than 12.
    const shortId = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
    for (const id of ["abc-def-ghi-jkl-mno", "ÞRÓUN-branch-name", "0123456789abcdefgh", "", "a"]) {
      const out = shortId(id);
      expect(out.length).toBeLessThanOrEqual(12);
      expect(/^[a-zA-Z0-9]*$/.test(out)).toBe(true);
      expect(out.padEnd(12)).toBe(padCell(out, 12));
    }
  });
});

describe("padCell — non-ASCII", () => {
  const CORPUS = [
    "日本語リポジトリ", "Þróunarútibú", "café-naïve", "👍👍👍", "👨‍👩‍👧‍👦 family",
    "🇮🇸🇳🇴", "한국어", "ＡＢＣ", "中a中b中", "feature/中文-branch", "éclair",
  ];

  test("produces exactly the requested width", () => {
    const wrong: string[] = [];
    for (const s of CORPUS) {
      for (let w = 0; w <= 30; w++) {
        const got = widthOf(padCell(s, w));
        if (got !== w) wrong.push(`${JSON.stringify(s)} @${w} -> ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  test("never severs a surrogate pair", () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const s of CORPUS) {
      for (let w = 0; w <= 30; w++) expect(lone.test(padCell(s, w))).toBe(false);
    }
  });

  test("a lone surrogate measures one column, with or without a combining mark", () => {
    // What reaches the terminal is U+FFFD, which is one column. Reachable only
    // from malformed provider JSON.
    expect(widthOf("\uD83D")).toBe(1);
    expect(widthOf("\uD83D́")).toBe(1);
  });
});

describe("clusterWidth — the rule, measured against what a terminal draws", () => {
  // glibc wcwidth is what tmux calls, so these are the drawn widths. Each of
  // these was wrong before the rule stopped asking `stringWidth(c) === 0`
  // first: string-width filters DEFAULT_IGNORABLE code points to 0, but a
  // terminal draws them.
  test.each([
    ["U+00AD SOFT HYPHEN", "­", 1],
    ["U+FFA0 HALFWIDTH HANGUL FILLER", "ﾠ", 1],
    ["U+115F HANGUL CHOSEONG FILLER", "ᅟ", 2],
    ["U+3164 HANGUL FILLER", "ㅤ", 2],
  ])("%s draws %#", (_name, ch, want) => {
    expect(widthOf(ch)).toBe(want);
  });

  test.each([
    ["combining acute", "́", 0],
    ["combining katakana voiced mark", "゙", 0],
    ["zero-width joiner", "‍", 0],
    ["zero-width space", "​", 0],
    ["BOM", "﻿", 0],
    ["conjoining jamo medial", "ᅡ", 0],
  ])("%s is zero-width", (_name, ch, want) => {
    expect(widthOf(ch)).toBe(want);
  });

  test.each([
    ["CJK", "中", 2],
    ["fullwidth plus", "＋", 2],
    ["hourglass (default emoji presentation)", "⌛", 2],
    ["thumbs up", "👍", 2],
    ["warning sign, TEXT presentation", "⚠", 1],
    ["heavy check", "✔", 1],
    ["heart", "❤", 1],
    ["ellipsis", "…", 1],
    ["ASCII", "A", 1],
  ])("%s measures %#", (_name, ch, want) => {
    expect(widthOf(ch)).toBe(want);
  });

  test("a VS16 or ZWJ sequence keeps its emoji width", () => {
    expect(widthOf("⚠️")).toBe(2); // ⚠ + VS16 explicitly asks for emoji
    expect(widthOf("👨‍👩‍👧‍👦")).toBe(2);
  });

  test("none of agendo's own glyphs is measured as anything but one column", () => {
    // These are the glyphs the TUI and CLI actually print. If any of them ever
    // measures 2, every column to its right slides — the ⚠/⌛ bug class.
    for (const g of "✓✗●○▸▾❯◆…—·⚠✔❤★") expect(widthOf(g)).toBe(1);
  });
});

describe("fit", () => {
  test("always returns exactly w columns and reserves the gap", () => {
    for (const s of ["short", "a much longer title than fits", "日本語のとても長いタイトルです", "👍👍👍👍👍"]) {
      for (let w = 2; w <= 24; w++) expect(widthOf(fit(s, w))).toBe(w);
    }
  });

  test("marks truncation with an ellipsis and never cuts mid-cluster", () => {
    expect(fit("abcdefghij", 6)).toBe("abcd… ");
    const cut = fit("👨‍👩‍👧‍👦👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 6);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
  });
});

describe("approval rendering", () => {
  const pr = (approvedCount: number, requiredCount: number, gateMet?: boolean): PullRequest =>
    ({ id: 7, approvedCount, requiredCount, gateMet } as PullRequest);

  // requiredCount === 0 means the gate is UNKNOWN, not zero: GitHub leaves it 0
  // whenever reviewDecision is absent, which is every PR on an unprotected base.
  test("an unknown gate never prints a denominator", () => {
    expect(approvalInline(pr(2, 0), "-")).toBe("✓2");
    expect(approvalInline(pr(0, 0), "-")).toBe("-");
  });

  // A stated-unmet gate with the numerator at or past the floor means the floor
  // is known to be wrong, so printing it would assert something false.
  test("a contradicted floor is dropped rather than printed", () => {
    expect(approvalInline(pr(2, 1, false), "-")).toBe("✓2");
    expect(approvalInline(pr(1, 1, false), "-")).toBe("✓1");
    expect(approvalInline(pr(1, 2, false), "-")).toBe("1/2");
  });

  test("all three renderings agree on the figure", () => {
    for (const gateMet of [true, false, undefined]) {
      for (let a = 0; a <= 2; a++) {
        for (let r = 0; r <= 2; r++) {
          const p = pr(a, r, gateMet);
          const inline = approvalInline(p, "-");
          const cell = approvalCell(p).text.replace(/\s+/g, "");
          const badge = prBadge(p).text.replace(/^!7\s*/, "").replace(/\s+/g, "");
          if (inline === "-") {
            expect(cell).toBe("—");
            expect(badge).toBe("·");
          } else {
            expect(cell.replace(/^✓/, "")).toBe(inline.replace(/^✓/, ""));
            expect(badge.replace(/^✓/, "")).toBe(inline.replace(/^✓/, ""));
          }
        }
      }
    }
  });
});
