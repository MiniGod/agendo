// Fitting text into terminal columns, and the cell that is the unit of it.
//
// This is the densest logic in the repo and the only part of the UI with unit
// tests behind it (test/format.test.ts): every fixture value that reaches a
// table cell in the e2e suite is ASCII, and ASCII is exactly the input class
// for which a correct and an incorrect cell measure agree.
import { eastAsianWidth } from "get-east-asian-width";
import stringWidth from "string-width";

/** One table cell: the text, and the colour the renderer should give it. */
export interface Cell { text: string; color?: string }

// ── column fitting ────────────────────────────────────────────────────────────
//
// `fit` both truncates and pads, so its unit has to be the terminal CELL — what
// the reader actually sees — and not the JavaScript string index. Those two
// diverge in two independent ways, and each one breaks something different:
//
//   - A WIDE character is one code unit but TWO cells (CJK, and most emoji).
//     Measuring by index under-counts it, so the cell is padded one column too
//     wide per wide character and every column to its right slides right. This
//     is the alignment half of the bug, and it is visible with a single 中 in a
//     title.
//   - An ASTRAL character is TWO code units but one glyph, so slicing at an odd
//     offset cuts a surrogate pair in half and emits a lone surrogate — the same
//     defect `caretLeft`/`caretRight` (src/ui/keys/caret.ts) fix for the prompt
//     caret, reaching the screen through truncation instead of the arrow keys.
//
// A third case only truncation has: a COMBINING MARK is its own code point, so a
// cut between a base and its mark leaves the mark to re-attach itself to the "…"
// or to whatever the terminal draws next.
//
// Cutting is done on GRAPHEME CLUSTER boundaries via the built-in
// `Intl.Segmenter`: clusters are a superset of code-point boundaries, so keeping
// base + marks together comes free with never splitting a pair.
const SEGMENTER = new Intl.Segmenter();

// Printable ASCII only: no wide characters, no astral characters, no combining
// marks, so one code unit is exactly one cell.
const ASCII_ONLY = /^[\x20-\x7E]*$/;

// Code points a wcwidth terminal advances the cursor zero columns for. Beyond
// the combining marks these are the invisible format controls, plus the
// conjoining Hangul jamo — a medial or final jamo composes onto the preceding
// syllable rather than taking a cell of its own, which is why glibc gives the
// whole U+1160–U+11FF block width 0.
const ZERO_WIDTH_CP =
  /^[\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]$/;
const CONJOINING_JAMO = /^[\u1160-\u11ff\ud7b0-\ud7c6\ud7cb-\ud7fb]$/;
const COMBINING_MARK = /^[\p{Mn}\p{Me}]$/u;

// Columns one grapheme cluster occupies, by the rule a wcwidth-based terminal
// actually applies. tmux is one, and agendo runs inside it.
//
// This is NOT `stringWidth(cluster)`. `string-width` asks `emoji-regex` first,
// and `emoji-regex` matches BARE symbol code points that have an emoji form —
// so it calls "⚠" (U+26A0, no variation selector) two columns wide. tmux draws
// it in one. The same disagreement covers ✔ U+2714 and ❤ U+2764. Measuring
// those as 2 pads the cell one column short and slides every column to its
// right, which is the exact defect this whole section exists to prevent: it is
// how `⚠ conflict` became misaligned when `⌛ expired` was fixed.
//
// The rule is checked against glibc `wcwidth` — which is what tmux itself
// calls, so on this machine it IS what gets drawn — across every assignable
// BMP code point with a defined width. It agrees on 61,950 of 61,972 and
// disagrees on 22, all of them a Unicode-VERSION disagreement rather than a
// mistake: `get-east-asian-width` ships current Unicode, this glibc's tables
// are older. U+2630-2637 and U+268A-268F (trigrams, monograms) became Wide in
// Unicode 9.0 and glibc still says 1; U+3248-324F are Ambiguous in Unicode and
// glibc says 2. Closing those means shipping wcwidth tables and pinning them to
// the reader's libc, which is out of proportion to a mis-padded column.
//
// For comparison, measured the same way: counting UTF-16 code units (what the
// callers of `padCell` used to do) is correct for 18,421 of those code points,
// and a plain `stringWidth` measure for 60,912.
//
// KNOWN DIVERGENCES that remain, beyond those 22:
//
//   - SPACING COMBINING MARKS (Mc, 471 code points). `string-width` reads only
//     `codePointAt(0)` of the cluster, so "कि" measures 1 where tmux draws 2.
//     Devanagari / Bengali / Tamil / Khmer titles under-measure by a column per
//     mark. Thai (Mn) and Hebrew niqqud are non-spacing and measure correctly.
//   - REGIONAL INDICATORS. tmux collapses an adjacent RI run into ONE 2-column
//     cell, so "🇮🇸🇳🇴" draws 2 where this measures 4. Truncation is still safe:
//     `Intl.Segmenter` clusters an RI pair, and `clipToWidth` only ever cuts on
//     a cluster boundary, so a flag can never be split in half.
//   - C0/C1 CONTROLS AND DEL measure 0, which is a choice rather than a truth:
//     `wcwidth` reports them as undefined (-1) because a terminal does not draw
//     them at all. A TAB in a directory name advances to the next tab stop, so
//     no single number is right. 0 keeps the previous behaviour.
//
// And one divergence from ink rather than from tmux: ink measures with
// `string-width`, so wherever this narrows a code point the two disagree by one
// column. At a terminal exactly as wide as the table, ink's `wrap="truncate"`
// can clip one trailing pad space early. The paragraph below about sharing
// ink's copy therefore holds only for the multi-code-point branch, which is
// where the deferral actually happens.
//
// Where it DOES defer to `string-width`, agendo wants the same copy ink uses to
// lay `<Text>` out. That sharing is not automatic and not free: it holds only
// because this package declares `^7.2.0` and ink declares `^7.2.0`, so the
// installer hoists one instance. **The declared range has to keep tracking
// ink's.** Widening it to `^8` would install a second copy with a different
// table — v8 answers 1 for U+26A0, U+2714 and U+2764 where v7 answers 2 — and
// agendo would then be measuring with a library its renderer isn't using, which
// is the one property worth having here. `get-east-asian-width` is declared for
// the same reason `string-width` is: package.json ships `src/`, so a runtime
// import that is only ever a transitive dependency breaks the day the tree
// shifts.
//
// The three branches, in order, and why the order matters:
function clusterWidth(cluster: string): number {
  const cp = cluster.codePointAt(0) ?? 0;
  // 0. An UNPAIRED SURROGATE is not encodable as UTF-8, so what reaches the
  //    terminal is the replacement character — one column. `stringWidth` says
  //    0, which under-pads the cell by one.
  //
  //    The test is "the cluster STARTS with an unpaired surrogate", not "is
  //    one": `codePointAt(0)` returns the combined scalar for a well-formed
  //    pair, so landing in D800–DFFF already means the first code unit is
  //    unpaired. A lone surrogate that absorbed a following combining mark
  //    ("\uD83D́") is one cluster of length 2, and the terminal draws
  //    U+FFFD (1) plus the mark (0) — still 1.
  if (cp >= 0xd800 && cp <= 0xdfff) return 1;
  // 1. A SINGLE code point gets TEXT presentation in a terminal, so its width
  //    is its East Asian Width — Wide/Fullwidth → 2 (CJK, and every code point
  //    whose default presentation is emoji, since Unicode gives those
  //    EAW=Wide, so ⌛ U+231B and 👍 U+1F44D are still 2), everything else → 1,
  //    including the bare symbols `emoji-regex` over-claims.
  //
  //    The zero tests come first and are spelled out rather than delegated to
  //    `stringWidth(cluster) === 0`, which is what this used to ask. That
  //    question is subtly the wrong one: `string-width` filters
  //    DEFAULT_IGNORABLE code points to 0, but a terminal DRAWS several of
  //    them — it gives U+00AD 1, U+FFA0 1, U+115F 2, U+3164 2 — so asking it
  //    first threw away the East Asian Width answer, which is correct for all
  //    four. It also called every Mn/Me mark on a CJK base 2 rather than 0.
  //    Against glibc that swap is worth 1,060 wrong code points down to 22.
  if (cluster.length === (cp > 0xffff ? 2 : 1)) {
    // C0/C1 and DEL are tested numerically rather than as a character class:
    // spelling them into the regex trips `no-control-regex`, and the carve-out
    // for that rule is for code that parses ANSI, which this is not.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;
    if (ZERO_WIDTH_CP.test(cluster) || CONJOINING_JAMO.test(cluster) || COMBINING_MARK.test(cluster)) return 0;
    return eastAsianWidth(cp) === 2 ? 2 : 1;
  }
  // 2. A MULTI-code-point cluster is a deliberate emoji: VS16 explicitly
  //    requests emoji presentation, and ZWJ sequences, skin-tone modifiers,
  //    regional-indicator flags and keycaps have no text form to fall back to.
  //    `string-width` is right about these, so defer to it (and to ink, which
  //    will lay the row out with the same number). It also answers 0 for a
  //    multi-code-point cluster that is entirely invisible, which is why the
  //    zero tests above only need to cover single code points.
  return stringWidth(cluster);
}

// `clusterWidth` is a pure function of a short string, and a table redraw asks
// it the same few hundred questions over and over — the CI glyph, the caret,
// and every character of every title, once per row per frame. So memoize it.
// The cap is a safety valve for pathological input, not a working-set estimate:
// a screenful of mixed CJK settles around a few hundred distinct clusters, and
// past the cap lookups simply stop being cached (never wrong, just uncached).
// Measured on a 50-row × 7-column PR screen: ≈1270µs → ≈260µs with ASCII
// titles, ≈4170µs → ≈700µs with CJK ones — i.e. cheaper than the plain
// `stringWidth` measure this replaces, which paid ≈310µs and ≈1660µs for the
// same two screens while getting ⚠ wrong.
const CLUSTER_WIDTHS = new Map<string, number>();

function cachedClusterWidth(cluster: string): number {
  const hit = CLUSTER_WIDTHS.get(cluster);
  if (hit !== undefined) return hit;
  const w = clusterWidth(cluster);
  if (CLUSTER_WIDTHS.size < 4096) CLUSTER_WIDTHS.set(cluster, w);
  return w;
}

// Columns `s` occupies, summed over its clusters. The per-cluster rule is the
// only measure `fit` uses, so padding and truncation can never be computed from
// two different ideas of a column.
function measureWidth(s: string): number {
  let n = 0;
  for (const { segment } of SEGMENTER.segment(s)) n += cachedClusterWidth(segment);
  return n;
}

// Longest prefix of `s` that fits in `cells` columns, cut only between grapheme
// clusters. A wide cluster straddling the boundary is dropped whole, which can
// leave the result one column short of `cells`; the caller's padding covers it.
function clipToWidth(s: string, cells: number): string {
  // `!(cells > 0)` rather than `cells <= 0` so a NaN width truncates to nothing
  // instead of falling through: the loop's `used + cw > NaN` is never true, so
  // a bare `<=` test would return the string UNCLIPPED and the caller would pad
  // it with `" ".repeat(NaN)` — a throw. No call site computes a width today,
  // but `fit` shares this helper and `fit`'s widths are computed.
  if (!(cells > 0)) return "";
  let out = "";
  let used = 0;
  for (const { segment } of SEGMENTER.segment(s)) {
    const cw = cachedClusterWidth(segment);
    if (used + cw > cells) break;
    out += segment;
    used += cw;
  }
  return out;
}

export function fit(s: string, w: number): string {
  // Reserve a 1-column gap so truncated cells never touch the next column.
  const max = w - 1;
  // Fast path: for printable ASCII the index arithmetic below IS cell
  // arithmetic, so this branch and the general one produce the same string —
  // it just skips the segmentation.
  //
  // Be honest about its reach: it is a fast path for the DATA, not for the
  // chrome. agendo's own cell glyphs are mostly non-ASCII, so most FIXED cells
  // miss this branch entirely — every ID cell carries the ▸/▾ caret, both
  // approvalCell shapes carry ✓ or —, and all nine ciCell shapes open with a
  // status glyph. What actually takes the branch is free text and counts: ASCII
  // titles, branches, "3d ago", "3 sess", "draft".
  //
  // Measured, per cell: ≈90ns here against ≈1.1µs for "✓ 2/2" and ≈3µs for a
  // CJK title on the general path; a whole 50×7 PR screen is ≈260µs of ASCII
  // titles or ≈750µs of CJK ones. Well inside a frame for a TUI — which is why
  // the test stays a plain regex instead of growing to cover the glyphs.
  if (ASCII_ONLY.test(s)) {
    const t = s.length > max ? s.slice(0, Math.max(0, max - 1)) + "…" : s;
    return t.padEnd(w);
  }
  const width = measureWidth(s);
  if (width <= max) return s + " ".repeat(Math.max(0, w - width));
  // "…" is one cell wide, so the visible prefix gets max - 1 of them.
  const t = clipToWidth(s, max - 1) + "…";
  return t + " ".repeat(Math.max(0, w - measureWidth(t)));
}

// Pad or truncate `s` to exactly `w` terminal cells.
//
// This is `fit`'s blunter sibling, and the difference is deliberate: `fit` is
// the table formatter, so it reserves a gap column and marks truncation with
// "…". These are FIXED-WIDTH LABEL cells — the picker screens and the CLI
// tables — whose callers all wrote `padEnd(w).slice(0, w)`, which does neither.
// Routing them through `fit` would visibly change rows that are correct today,
// so it gets its own function rather than a flag.
//
// For printable ASCII this is byte-identical to `padEnd(w).slice(0, w)`, which
// is the property that makes it safe to swap in: every such cell rendered by a
// test today is ASCII, so no existing rendering can move. What changes is the
// non-ASCII case those callers got wrong — a repo name, display name, branch or
// directory with a CJK or accented character was measured in UTF-16 code units,
// so the cell came out the wrong number of columns and dragged every column to
// its right along with it, and a hard `.slice()` could sever a surrogate pair.
export function padCell(s: string, w: number): string {
  if (ASCII_ONLY.test(s)) return s.padEnd(w).slice(0, w);
  const width = measureWidth(s);
  if (width <= w) return s + " ".repeat(w - width);
  // A wide cluster straddling the edge is dropped whole, so the clip can land
  // a column short; pad back up to the exact width.
  const t = clipToWidth(s, w);
  return t + " ".repeat(Math.max(0, w - measureWidth(t)));
}
