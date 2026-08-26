import type { Identity, PullRequest, ReviewPR } from "../types.ts";
import { API, cfg } from "./env.ts";
import { adoGet } from "./http.ts";
import { getTeamsForMember } from "./identity.ts";
import { mapPr } from "./pr.ts";

// ── CI / merge-gate status via branch-policy evaluations ──────────────────────
let cachedProjectId: string | null = null;
async function getProjectId(): Promise<string> {
  if (cachedProjectId) return cachedProjectId;
  const d = await adoGet(`_apis/projects/${encodeURIComponent(cfg.project)}?${API}`);
  cachedProjectId = d.id as string;
  return cachedProjectId;
}

type BuildStatus = "pass" | "fail" | "running" | "queued" | "expired" | "none";

// Classify the build policies on a PR. ADO reports a build whose result has
// aged out past the policy's `validDuration` as status "queued" with a context
// flagged `isExpired` — even though nothing is actually queued. We separate
// those (→ "expired", surfacing the build ids so the prior result can be
// recovered) from genuinely-waiting builds (→ "queued").
function aggregateBuild(evals: any[]): { status: BuildStatus; expiredBuildIds: number[] } {
  const builds = (evals ?? []).filter(
    (e) => e.configuration?.type?.displayName === "Build" && e.status && e.status !== "notApplicable",
  );
  if (builds.length === 0) return { status: "none", expiredBuildIds: [] };

  const expiredBuildIds: number[] = [];
  let hasFreshQueued = false;
  for (const e of builds) {
    if (e.status !== "queued") continue;
    if (e.context?.isExpired && e.context?.buildId > 0) expiredBuildIds.push(e.context.buildId);
    else hasFreshQueued = true;
  }
  const statuses = builds.map((e) => e.status as string);

  // Worst / most-actionable state first. "expired" sits below genuinely-queued
  // (a fresh build is in flight) but above a stale "pass".
  if (statuses.includes("rejected")) return { status: "fail", expiredBuildIds };
  if (statuses.includes("running")) return { status: "running", expiredBuildIds };
  if (hasFreshQueued) return { status: "queued", expiredBuildIds };
  if (expiredBuildIds.length) return { status: "expired", expiredBuildIds };
  if (statuses.includes("approved")) return { status: "pass", expiredBuildIds };
  return { status: "none", expiredBuildIds };
}

// A completed build's result is immutable and a purged build stays purged, so
// cache every outcome (including "unknown") for the process lifetime.
const buildResultCache = new Map<number, "pass" | "fail" | undefined>();

// Pass/fail of a finished build, or undefined if it's no longer fetchable
// (purged by retention) or didn't reach a clear pass/fail outcome.
async function fetchBuildResult(buildId: number): Promise<"pass" | "fail" | undefined> {
  if (buildResultCache.has(buildId)) return buildResultCache.get(buildId);
  let result: "pass" | "fail" | undefined;
  try {
    const b = await adoGet(`${encodeURIComponent(cfg.project)}/_apis/build/builds/${buildId}?${API}`);
    if (b.status === "completed") {
      if (b.result === "succeeded") result = "pass";
      else if (b.result === "failed") result = "fail";
    }
  } catch {
    result = undefined; // 404 → build purged by retention; result unrecoverable.
  }
  buildResultCache.set(buildId, result);
  return result;
}

function minApproverCount(evals: any[]): number {
  const pol = (evals ?? []).find(
    (e) => e.configuration?.type?.displayName === "Minimum number of reviewers",
  );
  return pol?.configuration?.settings?.minimumApproverCount ?? 0;
}

// Run an async fn over items with bounded concurrency.
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function fetchBuildAndApprovers(
  projectId: string,
  prId: number,
): Promise<{ build: BuildStatus; expiredResult?: "pass" | "fail"; minCount: number }> {
  try {
    const art = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
    const data = await adoGet(
      `${encodeURIComponent(cfg.project)}/_apis/policy/evaluations` +
        `?artifactId=${encodeURIComponent(art)}&api-version=7.1-preview.1`,
    );
    const { status, expiredBuildIds } = aggregateBuild(data.value);
    let expiredResult: "pass" | "fail" | undefined;
    if (status === "expired") {
      const results = await Promise.all(expiredBuildIds.map(fetchBuildResult));
      // A failed expired build outranks a passed one in the summary.
      if (results.includes("fail")) expiredResult = "fail";
      else if (results.includes("pass")) expiredResult = "pass";
    }
    return { build: status, expiredResult, minCount: minApproverCount(data.value) };
  } catch {
    return { build: "none", minCount: 0 };
  }
}

// Last-update time = the creation time of the most recent PR iteration (push).
async function fetchLastUpdate(repoId: string, prId: number): Promise<number> {
  try {
    const data = await adoGet(
      `${encodeURIComponent(cfg.project)}/_apis/git/repositories/${repoId}` +
        `/pullRequests/${prId}/iterations?${API}`,
    );
    const its = data.value ?? [];
    const last = its[its.length - 1];
    const d = last?.createdDate ?? last?.updatedDate;
    return d ? new Date(d).getTime() : 0;
  } catch {
    return 0;
  }
}

/**
 * Fill in `ci` (CI/merge gate), the required-approval denominator, and the
 * last-update time for a set of PRs. Per PR we hit the policy-evaluations and
 * iterations endpoints in parallel; PRs are processed with bounded concurrency.
 * Fetched fresh each call (state changes) but deduped by PR id. Mutates in place.
 */
export async function enrichPrCI(prs: PullRequest[]): Promise<void> {
  if (prs.length === 0) return;
  const projectId = await getProjectId();
  // One representative object per PR id (carries the repo id for iterations).
  const reps = new Map<number, PullRequest>();
  for (const pr of prs) if (!reps.has(pr.id)) reps.set(pr.id, pr);

  const byId = new Map<
    number,
    { build: BuildStatus; expiredResult?: "pass" | "fail"; minCount: number; updated: number }
  >();
  await mapLimit([...reps.values()], 24, async (pr) => {
    const [policy, updated] = await Promise.all([
      fetchBuildAndApprovers(projectId, pr.id),
      fetchLastUpdate(pr.repositoryId, pr.id),
    ]);
    byId.set(pr.id, { ...policy, updated });
  });

  for (const pr of prs) {
    const info = byId.get(pr.id);
    if (!info) continue;
    // A merge conflict outranks any build status.
    if (pr.ci !== "conflict") {
      pr.ci = info.build;
      pr.ciExpiredResult = info.build === "expired" ? info.expiredResult : undefined;
    }
    // No explicit required reviewers → use the minimum-reviewers policy as Y.
    if (pr.requiredCount === 0 && info.minCount > 0) pr.requiredCount = info.minCount;
    if (info.updated) pr.updatedDate = info.updated;
  }
}

/** Active pull requests created by a person across all repos in the project. */
export async function fetchActivePRs(creatorId: string): Promise<PullRequest[]> {
  const data = await adoGet(
    `${encodeURIComponent(cfg.project)}/_apis/git/pullrequests` +
      `?searchCriteria.status=active&searchCriteria.creatorId=${creatorId}&$top=200&${API}`,
  );
  return (data.value ?? []).map(mapPr);
}

function formatReviewReason(labels: string[]): string {
  // Prefer the personal reason, then a team name; summarise extras with "+N".
  const ordered = labels.includes("you")
    ? ["you", ...labels.filter((l) => l !== "you")]
    : labels;
  const [first, ...rest] = ordered;
  return rest.length ? `${first} +${rest.length}` : first ?? "";
}

/** Active PRs where this person (or one of their teams) is a requested reviewer. */
export async function fetchReviewPRs(identity: Identity): Promise<ReviewPR[]> {
  const teams = await getTeamsForMember(identity.id);
  const reviewers = [
    { id: identity.id, label: "you" },
    ...teams.map((t) => ({ id: t.id, label: t.name })),
  ];
  const proj = encodeURIComponent(cfg.project);
  const lists = await Promise.all(
    reviewers.map(async (r) => {
      try {
        const data = await adoGet(
          `${proj}/_apis/git/pullrequests` +
            `?searchCriteria.status=active&searchCriteria.reviewerId=${r.id}&$top=100&${API}`,
        );
        return (data.value ?? []).map((pr: any) => ({ pr, label: r.label }));
      } catch {
        return [] as { pr: any; label: string }[];
      }
    }),
  );

  // Dedupe by PR id, accumulating every reason it matched.
  const byId = new Map<number, { pr: any; labels: string[] }>();
  for (const list of lists) {
    for (const { pr, label } of list) {
      const e = byId.get(pr.pullRequestId);
      if (e) {
        if (!e.labels.includes(label)) e.labels.push(label);
      } else {
        byId.set(pr.pullRequestId, { pr, labels: [label] });
      }
    }
  }

  return [...byId.values()]
    // Don't surface a person's own PRs in their review queue.
    .filter(({ pr }) => pr.createdBy?.id !== identity.id)
    .map(({ pr, labels }) => ({ ...mapPr(pr), reviewReason: formatReviewReason(labels) }));
}
