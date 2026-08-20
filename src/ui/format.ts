import { basename } from "path";
import { eastAsianWidth } from "get-east-asian-width";
import stringWidth from "string-width";
import { repoRootForCwd, type RepoInfo } from "../repos.ts";
import { formatResetTime } from "../usageLimit.ts";
import { V } from "./vocabState.ts";
import { AGENTS } from "../types.ts";
import type { CloneOutcome } from "../clone.ts";
import type { Readiness, SessionKind } from "../tmux.ts";
import type { AgentSession, PullRequest, SessionActivity, TaskItem } from "../types.ts";

// ── small helpers ─────────────────────────────────────────────────────────────

export function timeAgo(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Compact gap since the previous action ("+12s", "+3m", …); blank for the first.
export function fmtDelta(ms?: number): string {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  if (s <= 0) return "+0s";
  if (s < 60) return `+${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `+${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `+${h}h`;
  return `+${Math.round(h / 24)}d`;
}

export function verbStyle(verb: string): { color: string } {
  switch (verb) {
    case "Write":
    case "Create":
      return { color: "green" };
    case "Edit":
      return { color: "yellow" };
    case "Bash":
    case "Agent":
      return { color: "cyan" };
    case "Claude":
    case "Copilot":
    case "Codex":
      return { color: "white" };
    case "Thinking":
      return { color: "magenta" };
    case "AskUser":
      return { color: "yellow" };
    default:
      return { color: "gray" };
  }
}


// Repo a session belongs to, for compact display. Copilot stores
// "org/project/repo"; Claude sessions derive it from the worktree's main repo
// root (repoRootForCwd is cached, so this is cheap to call during render).
export function sessionRepo(s: AgentSession): string {
  if (s.repository) return s.repository.split("/").pop() || s.repository;
  return basename(repoRootForCwd(s.cwd));
}

// Per-agent session counts for the repo picker ("12 claude, 3 codex"). Agents
// with no sessions in the repo are omitted, so the line stays short as more
// agents are supported rather than padding out zeros for all of them.
export function repoBreakdown(r: RepoInfo): string {
  return AGENTS.filter((a) => r[a] > 0).map((a) => `${r[a]} ${a}`).join(", ");
}

// Relativize a path to ~ for display (no truncation — the row truncates it).
export function homeShort(p: string): string {
  return p.replace(/^\/home\/[^/]+\//, "~/").replace(/^\/Users\/[^/]+\//, "~/");
}

// Why a clone failed, phrased for someone who can act on it. agendo never
// handles credentials itself, so an auth failure is always "your git couldn't do
// this" — say that, then quote git verbatim underneath. Two lines rather than
// one long one: git's own words are the half that identifies the actual problem,
// and they must not be the half a terminal truncates.
const CLONE_HINTS: Record<string, string> = {
  // A consequence of agendo's own BatchMode — ssh would normally *ask*. Says
  // what to do rather than what went wrong, because the fix is one command.
  hostkey:
    "Unknown SSH host — agendo runs git non-interactively, so it can't accept a new " +
    "host key for you. Run `ssh -T <host>` once, accept it, then try again.",
  auth:
    "Authentication — agendo uses your existing git credentials; check your SSH agent, " +
    "or `gh auth setup-git` / `az repos` for HTTPS.",
  // Never phrased as "check your credentials" alone: a 404 is what GitHub also
  // returns for a private repo you can't see, so both readings stay on screen.
  missing:
    "Not found — check the URL, or (if it's private) that your git has access to it.",
};

export function cloneError(res: CloneOutcome): string[] {
  const detail = res.error ?? "git clone failed";
  const hint = res.failure ? CLONE_HINTS[res.failure] : undefined;
  return hint ? [hint, detail] : [detail];
}

export type Activity = SessionActivity | "loading" | "error";

// A running session's live pane snapshot: input readiness + how many background
// shells (e.g. a monitor loop) it has going. Polled together from one capture.
export interface PaneState { readiness: Readiness; shells: number; resetAt?: number | null; compactionPercent?: number | null }

export function stateColor(state: string): string {
  const s = state.toLowerCase();
  if (s.includes("progress")) return "yellow";
  if (s.includes("review")) return "cyan";
  if (s.includes("ready")) return "green";
  if (s.includes("hold")) return "gray";
  return "white";
}

const CI_GLYPH: Record<PullRequest["ci"], string> = {
  pass: "✓",
  fail: "✗",
  running: "●",
  queued: "⧗",
  expired: "⌛",
  conflict: "⚠",
  none: "",
};

// The three approval fields, as every renderer needs them. Structural rather
// than `PullRequest` because the `list pr` row model (src/cli/listPrs.ts)
// carries the same three and has to print the same figure — a JSON row spells
// "unknown" as `null` where a `PullRequest` leaves it `undefined`, so both
// spellings are accepted and neither is `false`.
export interface ApprovalCounts {
  approvedCount: number;
  requiredCount: number;
  gateMet?: boolean | null;
}

// Whether the review gate is satisfied — the one question both PR renderings
// answer with colour. A provider that states its own verdict wins: GitHub's
// `requiredCount` is a floor rather than a count (src/github.ts voteSummary),
// so `approvedCount >= requiredCount` is not evidence of anything there.
function approvalsMet(pr: ApprovalCounts): boolean {
  if (pr.gateMet != null) return pr.gateMet;
  return pr.requiredCount > 0 && pr.approvedCount >= pr.requiredCount;
}

// The approval figure, in the one form both PR renderings use.
//
// `approvedCount` / `requiredCount` are the SAME two fields wherever they are
// drawn — the work-items badge and the PR view's APPROVE column describe one
// quantity, so they must not phrase it two ways. They used to: the badge showed
// `✓2` where the column showed `✓ 2/0`.
//
// The column's version was the wrong one. `requiredCount` is 0 when the gate is
// UNKNOWN, not when it is zero: ADO leaves it 0 when a PR names no required
// reviewers and no minimum-reviewers policy was found (src/ado.ts voteSummary +
// the enrichment pass), and GitHub leaves it 0 whenever `reviewDecision` is
// absent — which is every PR in a repo without branch protection, approvals or
// not. So "2/0" prints "2 of 0 required", a claim the data never makes, for the
// ordinary case of an approved PR on an unprotected repo.
//
// GitHub's Y of 1 is a different case and deliberately stays. It is not a
// sentinel standing in for "unknown": `reviewDecision` being non-null means the
// base branch genuinely requires review, so 1 is the smallest gate consistent
// with what the API said — a floor, and one that reads correctly at the
// boundary the column exists for ("0/1" = awaited, "1/1" = there). The wrong
// thing it could do was decide the VERDICT, letting a two-approval gate look
// satisfied at one; `PullRequest.gateMet` now carries GitHub's own answer and
// `approvalsMet` prefers it, so the floor only ever sets the printed Y.
//
// A floor also stops being printable the moment the provider's own verdict
// contradicts it. GitHub's gate can require a CODEOWNERS review: two
// non-owners approve, `reviewDecision` stays REVIEW_REQUIRED, and what arrives
// here is approvedCount=2 against requiredCount=1 with gateMet=false. "2/1,
// still pending" is not a hard read, it is a false claim — the denominator is
// known to be wrong, because the real requirement is the number GitHub never
// told us. So whenever the gate is known UNMET and the numerator has already
// reached the denominator, this drops to the bare-count form the unknown-gate
// case already uses ("✓2" / "✓ 2"): the count is still a fact, and the colour
// still carries the verdict. `gateMet` unknown keeps the ratio — that is ADO,
// where `requiredCount` is a real count of required reviewers, not a floor.
//
// Returns text "" when there is nothing to report. The placeholder is the
// caller's, because the sites are different shapes: a padded column writes the
// em dash it uses for every other empty cell, an inline badge writes a middot.
// `ratio` says which of the two forms came back, so no caller has to re-derive
// that from `requiredCount` — which is no longer the whole test.
function approvalProgress(pr: ApprovalCounts): { text: string; ratio: boolean } {
  const contradicted = pr.gateMet === false && pr.approvedCount >= pr.requiredCount;
  if (pr.requiredCount > 0 && !contradicted) {
    return { text: `${pr.approvedCount}/${pr.requiredCount}`, ratio: true };
  }
  return { text: pr.approvedCount > 0 ? `${pr.approvedCount}` : "", ratio: false };
}

// The inline (unpadded) rendering of that figure, for the work-items badge and
// for `agendo list pr`'s `appr` column. A bare count has no slash to mark it as
// approvals, so it takes a leading ✓ the X/Y form does not need. Note this is
// NOT the badge's other ✓: that one is CI_GLYPH.pass and is always last.
export function approvalInline(pr: ApprovalCounts, empty: string): string {
  const { text, ratio } = approvalProgress(pr);
  if (text === "") return empty;
  return ratio ? text : `✓${text}`;
}

export function prBadge(pr: PullRequest): { text: string; color: string } {
  const appr = approvalInline(pr, "·");
  const ci = CI_GLYPH[pr.ci] ? ` ${CI_GLYPH[pr.ci]}` : "";
  const draft = pr.isDraft ? " draft" : "";
  const bad = pr.rejections > 0 || pr.ci === "fail" || pr.ci === "conflict";
  const color =
    pr.status !== "active" ? "gray" : bad ? "red" : approvalsMet(pr) && pr.ci !== "running" ? "green" : "magenta";
  return { text: `${V.prPrefix}${pr.id} ${appr}${ci}${draft}`, color };
}

// PR-view column cells: approval progress (X/Y) and CI / merge-gate status.
export function approvalCell(pr: PullRequest): Cell {
  const { text: progress } = approvalProgress(pr);
  if (progress === "") return { text: "—", color: "gray" };
  // The leading ✓ labels the number as approvals — it is the APPROVE column's
  // glyph, not a verdict, which is why it is there at "✓ 0/1" too. The verdict
  // is the color: green once the gate is met, yellow while it isn't, red on a
  // rejection. With no known gate `approvalsMet` is false, so bare approvals
  // read as yellow/pending — the honest colour for progress toward a gate
  // nobody told us about.
  const color = pr.rejections > 0 ? "red" : approvalsMet(pr) ? "green" : "yellow";
  return { text: `✓ ${progress}`, color };
}

export function ciCell(pr: PullRequest): Cell {
  switch (pr.ci) {
    case "pass": return { text: "✓ pass", color: "green" };
    case "fail": return { text: "✗ fail", color: "red" };
    case "running": return { text: "● running", color: "yellow" };
    case "queued": return { text: "⧗ queued", color: "yellow" };
    // Build result aged out (shown as "queued" by ADO). Leading glyph carries
    // the last known result; "expired" flags that it's stale and needs a re-run.
    case "expired":
      if (pr.ciExpiredResult === "pass") return { text: "✓ expired", color: "yellow" };
      if (pr.ciExpiredResult === "fail") return { text: "✗ expired", color: "red" };
      return { text: "⌛ expired", color: "gray" };
    case "conflict": return { text: "⚠ conflict", color: "red" };
    default: return { text: "— no CI", color: "gray" };
  }
}

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
// KNOWN DIVERGENCES from tmux 3.4, all measured against a real terminal and
// all PRE-EXISTING (this function narrowed 201 code points versus a plain
// `stringWidth` measure and regressed none of them). They are recorded rather
// than fixed because each one is a step toward reimplementing `wcwidth`, which
// is out of proportion to a mis-padded column in a title:
//
//   - DEFAULT_IGNORABLE code points that the terminal nevertheless draws.
//     `string-width` filters them to 0; tmux gives U+00AD SOFT HYPHEN 1
//     (reachable from a web-pasted title), U+FFA0 1, U+115F 2, U+3164 2.
//   - SPACING COMBINING MARKS (Mc, 471 code points). `string-width` reads only
//     `codePointAt(0)` of the cluster, so "कि" measures 1 where tmux draws 2.
//     Devanagari / Bengali / Tamil / Khmer titles under-measure by a column per
//     mark. Thai (Mn) and Hebrew niqqud are non-spacing and measure correctly.
//   - REGIONAL INDICATORS. tmux collapses an adjacent RI run into ONE 2-column
//     cell, so "🇮🇸🇳🇴" draws 2 where this measures 4. Truncation is still safe:
//     `Intl.Segmenter` clusters an RI pair, and `clipToWidth` only ever cuts on
//     a cluster boundary, so a flag can never be split in half.
//
// And one divergence from ink rather than from tmux: ink still measures with
// `string-width`, so for the 201 code points narrowed above the two disagree by
// one column. At a terminal exactly as wide as the table, ink's
// `wrap="truncate"` can clip one trailing pad space early. The paragraph below
// about sharing ink's copy therefore now holds only for branch 3 —
// multi-code-point clusters — which is where the deferral actually happens.
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
  //    0, which under-pads the cell by one. Needs to come before the zero test
  //    for that reason. (Only reachable from malformed provider JSON, but it is
  //    the same family of bug as the rest of this function.)
  //
  //    The test is "the cluster STARTS with an unpaired surrogate", not "is
  //    one": `codePointAt(0)` returns the combined scalar for a well-formed
  //    pair, so landing in D800–DFFF already means the first code unit is
  //    unpaired. A lone surrogate that absorbed a following combining mark
  //    ("\uD83D́") is one cluster of length 2, and the terminal draws
  //    U+FFFD (1) plus the mark (0) — still 1. The old `length === 1` guard let
  //    that fall through to `stringWidth`, which answers 0.
  if (cp >= 0xd800 && cp <= 0xdfff) return 1;
  const w = stringWidth(cluster);
  // 1. ZERO stays zero: combining marks, ZWSP, a bare variation selector, a
  //    control byte. East Asian Width has no "invisible" answer — it calls all
  //    of them Neutral, i.e. 1 — so this is the one question only
  //    `string-width` can answer, and it has to be asked first.
  if (w === 0) return 0;
  // 2. A SINGLE code point on its own gets TEXT presentation in a terminal, and
  //    the width of a text-presentation glyph is its East Asian Width. Wide/
  //    Fullwidth → 2 (CJK, and every code point whose default presentation is
  //    emoji — Unicode gives those EAW=Wide, so ⌛ U+231B and 👍 U+1F44D are
  //    still 2 here). Everything else → 1, including the bare symbols
  //    `emoji-regex` over-claims.
  if (cluster.length === (cp > 0xffff ? 2 : 1)) return eastAsianWidth(cp) === 2 ? 2 : 1;
  // 3. A MULTI-code-point cluster is a deliberate emoji: VS16 explicitly
  //    requests emoji presentation, and ZWJ sequences, skin-tone modifiers,
  //    regional-indicator flags and keycaps have no text form to fall back to.
  //    `string-width` is right about these, so defer to it (and to ink, which
  //    will lay the row out with the same number).
  return w;
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
  if (cells <= 0) return "";
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

export interface Cell { text: string; color?: string }

export function agentCell(running: number, total: number): Cell {
  if (total === 0) return { text: "—", color: "gray" };
  if (running > 0) return { text: `● ${running}/${total}`, color: "green" };
  return { text: `${total} sess`, color: "gray" };
}

// Short badge marking how a running session was launched, for at-a-glance
// context (background = agent-spawned; new = launched manually from the menu).
export const KIND_BADGE: Partial<Record<SessionKind, string>> = { background: "bg", new: "new" };

// How a running session's input pane reads right now, as a colored trailing tag.
// `busy` = mid-turn; `compacting` = rewriting its own context, blocked but making
// progress; `dialog` = waiting on a prompt/choice (wants you); `ready` = idle and
// attachable. `undefined` (not yet sampled / unknown) keeps the plain
// "running → attach" so a row never looks stalled before the first poll lands.
//
// `compacting` used to fall through to that default and render as the green
// "running → attach", i.e. a blocked session looked idle and attachable — the one
// state the CLI's readiness column reported and the menu did not.
export function runningStatus(r: Readiness | undefined): { label: string; color: string } {
  switch (r) {
    case "ready": return { label: "ready → attach", color: "green" };
    case "busy": return { label: "busy…", color: "yellow" };
    case "compacting": return { label: "compacting…", color: "yellow" };
    case "queued": return { label: "queued", color: "cyan" };
    case "dialog": return { label: "needs input", color: "magenta" };
    case "limited": return { label: "usage limit", color: "red" };
    default: return { label: "running → attach", color: "green" };
  }
}

// Trailing detail for a compacting row: how far the progress bar has got. Absent
// when the pane isn't drawing one yet — the bar appears a beat after the verb line,
// and " · 0%" would be a claim we can't make from a screen that hasn't said it.
export function compactionSuffix(percent: number | null | undefined): string {
  return percent == null ? "" : ` · ${percent}%`;
}

// Trailing detail for a usage-limited row: the reset time (local clock) when we
// could parse one, else a note that we can't (and so won't auto-resume).
export function limitSuffix(resetAt: number | null | undefined): string {
  if (resetAt == null) return " · no reset time";
  // The same clock `agendo list` prints: one formatter, one locale rule, so the
  // menu and the CLI can't disagree (unpadded hour, 24h vs 12h per the locale).
  const t = formatResetTime(resetAt);
  return resetAt <= Date.now() ? ` · reset passed ${t}` : ` · resets ${t}`;
}

// The three task states are distinguished by both glyph and color so progress
// reads at a glance (and stays legible without color).
export const TASK_STYLE: Record<TaskItem["status"], { glyph: string; color: string; dim: boolean }> = {
  completed: { glyph: "✔", color: "green", dim: true },
  in_progress: { glyph: "◐", color: "yellow", dim: false },
  pending: { glyph: "☐", color: "gray", dim: true },
};
