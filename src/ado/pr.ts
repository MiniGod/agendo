import type { PullRequest, PRStatus } from "../types.ts";
import { API, cfg } from "./env.ts";
import { adoGet } from "./http.ts";
import { urls } from "./urls.ts";

// ── Pull requests ─────────────────────────────────────────────────────────────
// ArtifactLink urls look like:
//   vstfs:///Git/PullRequestId/{projectGuid}%2F{repoGuid}%2F{prId}
export function parsePrArtifact(url: string): { repoId: string; prId: number } | null {
  const marker = "PullRequestId/";
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const tail = decodeURIComponent(url.slice(idx + marker.length));
  const parts = tail.split("/");
  if (parts.length < 3) return null;
  const prId = Number(parts[2]);
  if (!Number.isFinite(prId)) return null;
  return { repoId: parts[1], prId };
}

function voteSummary(reviewers: any[]): {
  approvals: number;
  rejections: number;
  waiting: number;
  approvedCount: number;
  requiredCount: number;
} {
  let approvals = 0, rejections = 0, waiting = 0;
  const required: any[] = [];
  for (const rv of reviewers ?? []) {
    const v = rv.vote as number; // 10 approved, 5 approved w/ suggestions, -5 waiting, -10 rejected
    if (v >= 5) approvals++;
    else if (v <= -10) rejections++;
    else if (v < 0) waiting++;
    if (rv.isRequired) required.push(rv);
  }
  // Approval progress X/Y: prefer the explicitly-required reviewers; when there
  // are none, fall back to total approvals (the required count, Y, is filled in
  // from the minimum-reviewers policy during enrichment).
  const approvedCount = required.length ? required.filter((r) => r.vote >= 5).length : approvals;
  const requiredCount = required.length;
  return { approvals, rejections, waiting, approvedCount, requiredCount };
}

export function mapPr(pr: any): PullRequest {
  const status: PRStatus =
    pr.status === "active" || pr.status === "completed" || pr.status === "abandoned"
      ? pr.status
      : "unknown";
  const votes = voteSummary(pr.reviewers);
  const repoId = pr.repository?.id ?? "";
  // Conflicts are known from the PR itself; CI gates need policy enrichment.
  const ci: PullRequest["ci"] = pr.mergeStatus === "conflicts" ? "conflict" : "none";
  const createdDate = pr.creationDate ? new Date(pr.creationDate).getTime() : 0;
  return {
    id: pr.pullRequestId,
    title: pr.title ?? "",
    status,
    branch: (pr.sourceRefName ?? "").replace(/^refs\/heads\//, ""),
    repositoryId: repoId,
    repositoryName: pr.repository?.name,
    isDraft: !!pr.isDraft,
    ci,
    createdDate,
    updatedDate: createdDate, // refined to the last pushed iteration during enrichment
    // Through `urls`, not the raw builder, so the provider-level entry point is
    // the one the app actually exercises. "" means the payload carried no repo
    // at all (never seen from the real API) — callers read a falsy url as "no
    // link" rather than opening something that 404s.
    url:
      urls.pullRequest({
        id: pr.pullRequestId,
        repositoryId: repoId,
        repositoryName: pr.repository?.name,
      }) ?? "",
    ...votes,
  };
}

// Dedups repeated getPullRequest calls *within one model load* (a PR linked to
// several work items is fetched once). It must NOT survive across loads: a PR's
// status/approvals/isDraft/title are mutable, and only ci/updatedDate get
// refreshed by enrichPrCI — so a completed PR would stay frozen "active" in the
// linked view while vanishing from the orphan view. loadModel calls clearPrCache
// (via Provider.beginLoad) at the start of every reload to keep it a per-load cache.
const prCache = new Map<string, PullRequest>();

/** Drop the per-load PR cache so the next fetch re-reads mutable PR fields.
 *  Called at the start of each model reload (see Provider.beginLoad). */
export function clearPrCache(): void {
  prCache.clear();
}

export async function getPullRequest(repoId: string, prId: number): Promise<PullRequest | null> {
  const key = `${repoId}:${prId}`;
  if (prCache.has(key)) return prCache.get(key)!;
  try {
    const pr = await adoGet(
      `${encodeURIComponent(cfg.project)}/_apis/git/repositories/${repoId}` +
        `/pullRequests/${prId}?${API}`,
    );
    const result = mapPr(pr);
    prCache.set(key, result);
    return result;
  } catch {
    return null;
  }
}

/** Work-item ids linked to a pull request (via the PR→workitems ADO direction). */
export async function getPullRequestWorkItems(repoId: string, prId: number): Promise<number[]> {
  try {
    const data = await adoGet(
      `${encodeURIComponent(cfg.project)}/_apis/git/repositories/${repoId}` +
        `/pullRequests/${prId}/workitems?${API}`,
    );
    return (data.value ?? [])
      .map((w: any) => Number(w.id))
      .filter((n: number) => Number.isFinite(n));
  } catch {
    return [];
  }
}

