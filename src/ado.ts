// Azure DevOps access layer. Talks to the REST API directly using a token
// minted from the user's existing `az` login — no PAT, no azure-devops CLI
// extension. The default az tenant returns 401 for the org, so we always
// request a token scoped to the configured tenant.
import { spawn, spawnSync } from "child_process";
import { loadConfig, type Config } from "./config.ts";
import type {
  Identity,
  PullRequest,
  PRStatus,
  ReviewPR,
  TeamMember,
  WorkItem,
} from "./types.ts";

const cfg: Config = loadConfig();
// Base URLs are overridable via env so an integration test can point the whole
// REST layer at a local mock server without patching production defaults. In
// normal use neither var is set and we talk to the real Azure DevOps hosts.
const BASE = (process.env.ADO_BASE_URL ?? `https://dev.azure.com/${cfg.org}`).replace(/\/$/, "");
const VSSPS = (process.env.ADO_VSSPS_URL ?? "https://app.vssps.visualstudio.com").replace(/\/$/, "");
const GRAPH = (process.env.ADO_GRAPH_URL ?? `https://vssps.dev.azure.com/${cfg.org}`).replace(/\/$/, "");
const API = "api-version=7.1";

// Org-level work-item URL — resolves to the item in its own project regardless
// of which project it lives in, so it works for items outside cfg.project too.
const workItemUrl = (id: number) => `${BASE}/_workitems/edit/${id}`;

// ── Token (cached for the process lifetime, refreshed before expiry) ──────────
let cachedToken: { value: string; expiresAt: number } | null = null;

export function getToken(): string {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) return cachedToken.value;

  const res = spawnSync(
    "az",
    [
      "account", "get-access-token",
      "--tenant", cfg.tenant,
      "--resource", cfg.resource,
      "--query", "accessToken",
      "-o", "tsv",
    ],
    { encoding: "utf-8" },
  );
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(
      `Failed to get Azure DevOps token via az. Are you logged in (az login)?\n${res.stderr ?? ""}`,
    );
  }
  const value = res.stdout.trim();
  // Tokens last ~60–90 min; treat as valid for 50 min to be safe.
  cachedToken = { value, expiresAt: now + 50 * 60_000 };
  return value;
}

/** Whether `az` can mint a token for the configured org/tenant right now — the
 *  same call getToken() makes, so it's the accurate "logged in to this org"
 *  probe for the Settings page. Never throws; resolves false on any failure. */
export function checkAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("az", [
      "account", "get-access-token",
      "--tenant", cfg.tenant,
      "--resource", cfg.resource,
      "--query", "accessToken",
      "-o", "tsv",
    ]);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

// ── Low-level fetch ───────────────────────────────────────────────────────────
async function adoGet(path: string): Promise<any> {
  const url = path.startsWith("http") ? path : `${BASE}/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!r.ok) throw new Error(`ADO GET ${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}

async function adoPost(path: string, body: unknown): Promise<any> {
  const url = `${BASE}/${path}`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ADO POST ${url} -> ${r.status} ${r.statusText}`);
  return r.json();
}

// ── Current iteration for the configured team ─────────────────────────────────
export async function getCurrentIterationPath(): Promise<string | null> {
  const path =
    `${encodeURIComponent(cfg.project)}/${encodeURIComponent(cfg.team)}` +
    `/_apis/work/teamsettings/iterations?$timeframe=current&${API}`;
  const data = await adoGet(path);
  return data.value?.[0]?.path ?? null;
}

// ── Work items assigned to a person, not closed ───────────────────────────────
// `assignedTo` is a unique name (email/UPN); WIQL matches it case-insensitively.
async function getOpenWorkItemIds(assignedTo: string): Promise<number[]> {
  const closed = cfg.closedStates.map((s) => `'${s}'`).join(",");
  const wiql = {
    query:
      `SELECT [System.Id] FROM WorkItems ` +
      `WHERE [System.AssignedTo] = '${assignedTo.replace(/'/g, "''")}' ` +
      `AND [System.State] NOT IN (${closed}) ` +
      `ORDER BY [System.ChangedDate] DESC`,
  };
  const data = await adoPost(`_apis/wit/wiql?${API}`, wiql);
  return (data.workItems ?? []).map((w: any) => w.id as number);
}

export async function getWorkItemBatch(ids: number[]): Promise<any[]> {
  if (ids.length === 0) return [];
  const out: any[] = [];
  // ADO caps batch gets at 200 ids; chunk to be safe.
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    // Note: ADO rejects `fields` together with `$expand` (mutually exclusive),
    // so when expanding relations we take all fields and pick what we need.
    const data = await adoGet(
      `_apis/wit/workitems?ids=${chunk.join(",")}&$expand=relations&${API}`,
    );
    out.push(...(data.value ?? []));
  }
  return out;
}

// ── Pull requests ─────────────────────────────────────────────────────────────
// ArtifactLink urls look like:
//   vstfs:///Git/PullRequestId/{projectGuid}%2F{repoGuid}%2F{prId}
function parsePrArtifact(url: string): { repoId: string; prId: number } | null {
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

function mapPr(pr: any): PullRequest {
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
    url: `${BASE}/${encodeURIComponent(cfg.project)}/_git/${pr.repository?.name ?? repoId}/pullrequest/${pr.pullRequestId}`,
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

async function getPullRequest(repoId: string, prId: number): Promise<PullRequest | null> {
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

// ── Identities: the authenticated user, and the configured team's members ─────
let cachedMe: Identity | null = null;

/** The authenticated az user — the default identity, and the "(you)" marker. */
export async function getMe(): Promise<Identity> {
  if (cachedMe) return cachedMe;
  const d = (await adoGet(
    `${VSSPS}/_apis/profile/profiles/me?api-version=7.1-preview.3`,
  )) as { id: string; displayName?: string; emailAddress?: string };
  cachedMe = {
    id: d.id,
    displayName: d.displayName ?? "Me",
    uniqueName: d.emailAddress ?? "",
  };
  return cachedMe;
}

let cachedMembers: TeamMember[] | null = null;

/** Members of the configured team — the roster for the identity switcher. */
export async function getTeamMembers(): Promise<TeamMember[]> {
  if (cachedMembers) return cachedMembers;
  const data = await adoGet(
    `_apis/projects/${encodeURIComponent(cfg.project)}` +
      `/teams/${encodeURIComponent(cfg.team)}/members?${API}`,
  );
  const members: TeamMember[] = (data.value ?? [])
    .map((m: any) => m.identity)
    .filter(Boolean)
    .map((i: any): TeamMember => ({
      id: i.id,
      displayName: i.displayName ?? i.uniqueName ?? i.id,
      uniqueName: i.uniqueName ?? "",
    }));
  members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  cachedMembers = members;
  return members;
}

// ── Teams a member belongs to (for "PRs assigned to your teams") ───────────────
// A team's group descriptor resolves (via Graph storage key) back to the team
// id, which is exactly what the PR search accepts as `reviewerId`. So we map the
// member's group memberships → ids and keep those that are real teams.
async function graphGet(path: string): Promise<any> {
  return adoGet(`${GRAPH}/_apis/graph/${path}`);
}

let cachedProjectTeams: { id: string; name: string }[] | null = null;
async function getProjectTeams(): Promise<{ id: string; name: string }[]> {
  if (cachedProjectTeams) return cachedProjectTeams;
  const teams: { id: string; name: string }[] = [];
  for (let skip = 0; ; skip += 200) {
    const data = await adoGet(
      `_apis/projects/${encodeURIComponent(cfg.project)}/teams` +
        `?$top=200&$skip=${skip}&api-version=7.1-preview.3`,
    );
    const batch = data.value ?? [];
    for (const t of batch) teams.push({ id: t.id, name: t.name });
    if (batch.length < 200) break;
  }
  cachedProjectTeams = teams;
  return teams;
}

const teamsForMemberCache = new Map<string, { id: string; name: string }[]>();
async function getTeamsForMember(memberId: string): Promise<{ id: string; name: string }[]> {
  const cached = teamsForMemberCache.get(memberId);
  if (cached) return cached;
  try {
    const teams = await getProjectTeams();
    const teamById = new Map(teams.map((t) => [t.id, t.name]));
    const desc = (await graphGet(`descriptors/${memberId}?api-version=7.1-preview.1`)).value as string;
    const mem = await graphGet(`memberships/${desc}?direction=up&api-version=7.1-preview.1`);
    const containers: string[] = (mem.value ?? [])
      .map((m: any) => m.containerDescriptor)
      .filter((d: string) => typeof d === "string" && d.startsWith("vssgp."));
    const ids = await Promise.all(
      containers.map(async (d) => {
        try {
          return (await graphGet(`storagekeys/${d}?api-version=7.1-preview.1`)).value as string;
        } catch {
          return null;
        }
      }),
    );
    const result = ids
      .filter((id): id is string => !!id && teamById.has(id))
      .map((id) => ({ id, name: teamById.get(id)! }));
    teamsForMemberCache.set(memberId, result);
    return result;
  } catch {
    // Graph traversal can fail for accounts without directory read access; the
    // review section still works for the person themselves in that case.
    teamsForMemberCache.set(memberId, []);
    return [];
  }
}

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

// ── Public: assemble work items with PRs (sessions filled in elsewhere) ───────

/**
 * Map a raw ADO work-item object (with $expand=relations) to the shaped
 * WorkItem minus `sessions`. `currentIterationPath` may be null (no current
 * sprint configured). Exported so callers that independently fetch raw WIs
 * (e.g. the PR→workitems resolution path in loadModel) can reuse the same
 * mapping without duplicating it.
 */
export async function mapRawWorkItem(
  w: any,
  currentIterationPath: string | null,
): Promise<Omit<WorkItem, "sessions">> {
  const f = w.fields ?? {};
  const id: number = w.id ?? f["System.Id"];
  const iterationPath: string = f["System.IterationPath"] ?? "";

  const prRefs = (w.relations ?? [])
    .filter((r: any) => typeof r.url === "string" && r.url.includes("PullRequestId/"))
    .map((r: any) => parsePrArtifact(r.url))
    .filter(Boolean) as { repoId: string; prId: number }[];

  const prs = (
    await Promise.all(prRefs.map((ref) => getPullRequest(ref.repoId, ref.prId)))
  ).filter(Boolean) as PullRequest[];

  return {
    id,
    type: f["System.WorkItemType"] ?? "",
    title: f["System.Title"] ?? "",
    state: f["System.State"] ?? "",
    boardColumn: f["System.BoardColumn"],
    iterationPath,
    project: f["System.TeamProject"] ?? "",
    inCurrentSprint: !!currentIterationPath && iterationPath === currentIterationPath,
    prs,
    url: workItemUrl(id),
  };
}

export async function fetchWorkItems(
  assignedTo: string,
): Promise<{
  items: Omit<WorkItem, "sessions">[];
  currentIterationPath: string | null;
}> {
  const [currentIterationPath, ids] = await Promise.all([
    getCurrentIterationPath(),
    getOpenWorkItemIds(assignedTo),
  ]);

  const raw = await getWorkItemBatch(ids);

  const items = await Promise.all(raw.map((w) => mapRawWorkItem(w, currentIterationPath)));

  // Preserve WIQL order (most recently changed first).
  const order = new Map(ids.map((id, i) => [id, i]));
  items.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  return { items, currentIterationPath };
}

/**
 * Resolve the work items reached *from* a set of (orphan) PRs via the
 * PR→workitems ADO direction. Surfaces WIs that weren't already loaded as
 * assigned items (per `excludeWorkItemIds`), with the surfacing PR(s) merged
 * into each item's `prs`. Returns the mapped items (sessions attached by the
 * caller) plus the ids of the PRs actually surfaced under a fetched WI — a PR
 * whose only WI couldn't be fetched (deleted / access-denied) is reported as
 * not surfaced, so the caller keeps it visible as an orphan.
 */
export async function fetchWorkItemsForPRs(
  prs: PullRequest[],
  opts: { excludeWorkItemIds: Set<number>; currentIterationPath: string | null },
): Promise<{ items: Omit<WorkItem, "sessions">[]; surfacedPrIds: Set<number> }> {
  if (prs.length === 0) return { items: [], surfacedPrIds: new Set() };

  // 1: resolve WI ids per PR, bounded concurrency.
  const prToWis = new Map<number, number[]>();
  await mapLimit(prs, 12, async (pr) => {
    const wiIds = await getPullRequestWorkItems(pr.repositoryId, pr.id);
    if (wiIds.length) prToWis.set(pr.id, wiIds);
  });

  // 2: build WI→PRs, skipping WIs already loaded as assigned items.
  const wiToPrs = new Map<number, PullRequest[]>();
  for (const pr of prs) {
    for (const wiId of prToWis.get(pr.id) ?? []) {
      if (opts.excludeWorkItemIds.has(wiId)) continue;
      const arr = wiToPrs.get(wiId) ?? [];
      arr.push(pr);
      wiToPrs.set(wiId, arr);
    }
  }
  const newWiIds = [...wiToPrs.keys()];

  // 3: fetch + map the newly-discovered WIs.
  const rawNew = newWiIds.length ? await getWorkItemBatch(newWiIds) : [];
  const items = await Promise.all(rawNew.map((w) => mapRawWorkItem(w, opts.currentIterationPath)));

  // 4: union the surfacing PR(s) into each mapped WI's prs (dedupe by id, since
  // mapRawWorkItem may have already resolved the link bidirectionally).
  for (const wi of items) {
    const have = new Set(wi.prs.map((p) => p.id));
    for (const pr of wiToPrs.get(wi.id) ?? []) if (!have.has(pr.id)) wi.prs.push(pr);
  }

  // Only PRs under a WI we actually fetched count as surfaced.
  const mappedIds = new Set(items.map((w) => w.id));
  const surfacedPrIds = new Set(
    [...wiToPrs.entries()]
      .filter(([wiId]) => mappedIds.has(wiId))
      .flatMap(([, prs]) => prs)
      .map((p) => p.id),
  );
  return { items, surfacedPrIds };
}
