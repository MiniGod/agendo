// A PR's CI status: the GitHub rollup fold (src/github/ci.ts) and the table
// cell it renders as (src/ui/format/approvals.ts). The e2e suite's GitHub
// fixture carries a handful of check runs, all completed; it never reaches a
// commit status, a queued or running run, the failing conclusions, the
// conflict short-circuit, or the expired cell's three faces.
import { describe, expect, test } from "bun:test";
import { rollupCI, verdictOf } from "../src/github/ci.ts";
import type { PullRequest } from "../src/types.ts";
import { ciCell } from "../src/ui/format/approvals.ts";

const status = (state: string) => ({ __typename: "StatusContext", state });
const run = (status: string, conclusion?: string) => ({ __typename: "CheckRun", status, conclusion });

describe("verdictOf", () => {
  test("a commit status: FAILURE and ERROR fail, PENDING runs, SUCCESS passes, anything else says nothing", () => {
    expect(["FAILURE", "ERROR", "PENDING", "SUCCESS", "EXPECTED"].map((s) => verdictOf(status(s)))).toEqual(["fail", "fail", "running", "pass", null]);
  });

  test("a check run: queued while waiting, running otherwise, then its conclusion; NEUTRAL and SKIPPED say nothing", () => {
    expect(["QUEUED", "WAITING", "PENDING", "IN_PROGRESS", "REQUESTED"].map((s) => verdictOf(run(s)))).toEqual(["queued", "queued", "queued", "running", "running"]);
    expect(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"].map((c) => verdictOf(run("COMPLETED", c)))).toEqual(["fail", "fail", "fail", "fail", "fail"]);
    expect(verdictOf(run("COMPLETED", "SUCCESS"))).toBe("pass");
    expect(["NEUTRAL", "SKIPPED", undefined].map((c) => verdictOf(run("COMPLETED", c)))).toEqual([null, null, null]);
  });
});

describe("rollupCI", () => {
  test("a dirty merge state is a conflict before anything else; no checks is none", () => {
    expect(rollupCI([run("COMPLETED", "SUCCESS")], "DIRTY")).toBe("conflict");
    expect(rollupCI(undefined, "CLEAN")).toBe("none");
    expect(rollupCI([], undefined)).toBe("none");
  });

  test("worst wins: fail over running over queued over pass; only skipped checks is none", () => {
    expect(rollupCI([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS"), status("FAILURE")], "CLEAN")).toBe("fail");
    expect(rollupCI([run("COMPLETED", "SUCCESS"), run("QUEUED"), run("IN_PROGRESS")], "CLEAN")).toBe("running");
    expect(rollupCI([run("COMPLETED", "SUCCESS"), run("WAITING")], "CLEAN")).toBe("queued");
    expect(rollupCI([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED")], "CLEAN")).toBe("pass");
    expect(rollupCI([run("COMPLETED", "NEUTRAL"), status("EXPECTED")], "CLEAN")).toBe("none");
  });
});

describe("ciCell", () => {
  const pr = (ci: PullRequest["ci"], ciExpiredResult?: "pass" | "fail") => ({ ci, ciExpiredResult }) as PullRequest;

  test("one cell per status, glyph first", () => {
    expect(ciCell(pr("pass"))).toEqual({ text: "✓ pass", color: "green" });
    expect(ciCell(pr("fail"))).toEqual({ text: "✗ fail", color: "red" });
    expect(ciCell(pr("running"))).toEqual({ text: "● running", color: "yellow" });
    expect(ciCell(pr("queued"))).toEqual({ text: "⧗ queued", color: "yellow" });
    expect(ciCell(pr("conflict"))).toEqual({ text: "⚠ conflict", color: "red" });
    expect(ciCell(pr("none"))).toEqual({ text: "— no CI", color: "gray" });
    expect(ciCell(pr(undefined as unknown as PullRequest["ci"]))).toEqual({ text: "— no CI", color: "gray" });
  });

  test("an expired build carries its last result in the glyph", () => {
    expect(ciCell(pr("expired", "pass"))).toEqual({ text: "✓ expired", color: "yellow" });
    expect(ciCell(pr("expired", "fail"))).toEqual({ text: "✗ expired", color: "red" });
    expect(ciCell(pr("expired"))).toEqual({ text: "⌛ expired", color: "gray" });
  });
});
