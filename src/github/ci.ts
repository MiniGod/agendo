// The CI verdict of a GitHub PR, folded from its status-check rollup. Two
// kinds of check share the list — commit statuses (`StatusContext`, the older
// API) and check runs — and each is read into one verdict; the PR's is the
// worst of them.

import type { CIStatus } from "../types.ts";

type Verdict = "fail" | "running" | "queued" | "pass";

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const QUEUED_STATUSES = new Set(["QUEUED", "WAITING", "PENDING"]);

/** A commit status: FAILURE / ERROR fail, PENDING runs, SUCCESS passes; anything else says nothing. */
function statusContextVerdict(c: any): Verdict | null {
  if (c.state === "FAILURE" || c.state === "ERROR") return "fail";
  if (c.state === "PENDING") return "running";
  return c.state === "SUCCESS" ? "pass" : null;
}

/** A check run: not completed is queued or running (IN_PROGRESS, REQUESTED, …); completed is its conclusion. NEUTRAL / SKIPPED say nothing. */
function checkRunVerdict(c: any): Verdict | null {
  if (c.status !== "COMPLETED") return QUEUED_STATUSES.has(c.status) ? "queued" : "running";
  if (FAILED_CONCLUSIONS.has(c.conclusion)) return "fail";
  return c.conclusion === "SUCCESS" ? "pass" : null;
}

export function verdictOf(c: any): Verdict | null {
  return c.__typename === "StatusContext" ? statusContextVerdict(c) : checkRunVerdict(c);
}

/** Worst first: one failure fails the PR, one running check keeps it running, one queued keeps it queued. */
const PRECEDENCE: Verdict[] = ["fail", "running", "queued", "pass"];

export function rollupCI(rollup: any[] | undefined, mergeStateStatus: string | undefined): CIStatus {
  if (mergeStateStatus === "DIRTY") return "conflict";
  if (!rollup || rollup.length === 0) return "none";
  const seen = new Set(rollup.map(verdictOf));
  return PRECEDENCE.find((v) => seen.has(v)) ?? "none";
}
