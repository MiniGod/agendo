// The pure half of the ADO CI status: what a PR's build policies and a
// finished build amount to, with no request in sight. policy.ts does the
// fetching and calls these; the e2e ADO fixture never expires a build, so
// this is where those arms are reachable by a unit test.

export type BuildStatus = "pass" | "fail" | "running" | "queued" | "expired" | "none";

// Classify the build policies on a PR. ADO reports a build whose result has
// aged out past the policy's `validDuration` as status "queued" with a context
// flagged `isExpired` — even though nothing is actually queued. We separate
// those (→ "expired", surfacing the build ids so the prior result can be
// recovered) from genuinely-waiting builds (→ "queued").
export function aggregateBuild(evals: any[]): { status: BuildStatus; expiredBuildIds: number[] } {
  const builds = (evals ?? []).filter(isBuildPolicy);
  if (builds.length === 0) return { status: "none", expiredBuildIds: [] };
  const queued = queuedBuilds(builds);
  const statuses = builds.map((e) => e.status as string);
  return { status: buildVerdict(statuses, queued), expiredBuildIds: queued.expiredBuildIds };
}

/** A policy evaluation that is a build policy and applies to this PR. */
function isBuildPolicy(e: any): boolean {
  return e.configuration?.type?.displayName === "Build" && !!e.status && e.status !== "notApplicable";
}

/** The "queued" builds sorted into the expired ones (by build id) and the ones genuinely waiting. */
function queuedBuilds(builds: any[]): { expiredBuildIds: number[]; hasFreshQueued: boolean } {
  const expiredBuildIds: number[] = [];
  let hasFreshQueued = false;
  for (const e of builds) {
    if (e.status !== "queued") continue;
    if (e.context?.isExpired && e.context?.buildId > 0) expiredBuildIds.push(e.context.buildId);
    else hasFreshQueued = true;
  }
  return { expiredBuildIds, hasFreshQueued };
}

// Worst / most-actionable state first. "expired" sits below genuinely-queued
// (a fresh build is in flight) but above a stale "pass".
function buildVerdict(statuses: string[], queued: { expiredBuildIds: number[]; hasFreshQueued: boolean }): BuildStatus {
  if (statuses.includes("rejected")) return "fail";
  if (statuses.includes("running")) return "running";
  if (queued.hasFreshQueued) return "queued";
  if (queued.expiredBuildIds.length) return "expired";
  if (statuses.includes("approved")) return "pass";
  return "none";
}

/**
 * Pass/fail of a finished build, or undefined when it did not reach a clear
 * outcome — still running, cancelled, or partially succeeded.
 */
export function buildResult(b: { status?: string; result?: string }): "pass" | "fail" | undefined {
  if (b.status !== "completed") return undefined;
  if (b.result === "succeeded") return "pass";
  return b.result === "failed" ? "fail" : undefined;
}

/** The summary of a PR's expired builds: a failed one outranks a passed one; nothing clear is nothing. */
export function worstExpired(results: readonly ("pass" | "fail" | undefined)[]): "pass" | "fail" | undefined {
  if (results.includes("fail")) return "fail";
  return results.includes("pass") ? "pass" : undefined;
}
