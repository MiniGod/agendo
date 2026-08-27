// Pull-request approval and CI state, as the reader sees it: the glyphs, the
// "met / not met" reading of a review count, and the two cells the PR table
// puts them in.
import type { PullRequest } from "../../types.ts";
import { V } from "../vocabState.ts";
import type { Cell } from "./columns.ts";

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
