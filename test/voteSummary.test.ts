// A GitHub PR's review votes and gate (src/github.ts `voteSummary`). The e2e
// fixture's PRs carry one approving review at most; they never carry a
// re-vote by the same author, a dismissed or pending review, an author-less
// review, a CHANGES_REQUESTED, or an APPROVED decision with no approval in the
// page of reviews returned.
import { describe, expect, test } from "bun:test";
import { latestVotes, reviewGate, voteSummary } from "../src/github.ts";

const review = (login: string | undefined, state: string) => ({ author: login ? { login } : null, state });

describe("latestVotes", () => {
  test("the last meaningful vote per author wins; comments, pending and dismissed do not count", () => {
    const latest = latestVotes([
      review("a", "CHANGES_REQUESTED"), review("a", "COMMENTED"), review("a", "APPROVED"),
      review("b", "APPROVED"), review("b", "DISMISSED"),
      review("c", "PENDING"), review(undefined, "APPROVED"),
    ]);
    expect([...latest]).toEqual([["a", "APPROVED"], ["b", "APPROVED"]]);
    expect(latestVotes(undefined).size).toBe(0);
  });
});

describe("reviewGate", () => {
  test("no decision means no gate; a decision means a gate of at least one", () => {
    expect(reviewGate(undefined, 2)).toEqual({ approvedCount: 2, requiredCount: 0, gateMet: undefined });
    expect(reviewGate("REVIEW_REQUIRED", 0)).toEqual({ approvedCount: 0, requiredCount: 1, gateMet: false });
    expect(reviewGate("CHANGES_REQUESTED", 1)).toEqual({ approvedCount: 1, requiredCount: 1, gateMet: false });
  });

  test("an APPROVED decision never shows zero approvals", () => {
    expect(reviewGate("APPROVED", 0)).toEqual({ approvedCount: 1, requiredCount: 1, gateMet: true });
    expect(reviewGate("APPROVED", 3)).toEqual({ approvedCount: 3, requiredCount: 1, gateMet: true });
  });
});

describe("voteSummary", () => {
  test("counts approvals and rejections from the latest votes and carries the gate", () => {
    expect(voteSummary([review("a", "APPROVED"), review("b", "CHANGES_REQUESTED"), review("c", "COMMENTED")], "CHANGES_REQUESTED")).toEqual({
      approvals: 1, rejections: 1, waiting: 0, approvedCount: 1, requiredCount: 1, gateMet: false,
    });
    expect(voteSummary(undefined, undefined)).toEqual({ approvals: 0, rejections: 0, waiting: 0, approvedCount: 0, requiredCount: 0, gateMet: undefined });
  });
});
