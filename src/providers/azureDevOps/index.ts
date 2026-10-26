// Azure DevOps access layer. Talks to the REST API directly using a token
// minted from the user's existing `az` login — no PAT, no azure-devops CLI
// extension. The default az tenant returns 401 for the org, so we always
// request a token scoped to the configured tenant.
//
// The layer is split across src/providers/azureDevOps/: env.ts (config + base
// URLs, resolved once), urls.ts (canonical web links), http.ts (token + fetch),
// pr.ts (pull requests), identity.ts (who am I / the team), and policy.ts (CI +
// merge gates).
// What stays here is the work-item side and the public assembly on top of it.
//
// This file remains the single import path — src/providers/index.ts imports it
// as namespace `ado`; e2e/provider.spec.ts imports the URL builders by name —
// so the re-exports below are written out rather than `export *`, so that
// helpers which only became cross-module for the split (mapPr,
// getTeamsForMember, adoGet/adoPost) are not promoted into the public surface.
import { API, cfg, reloadEnv } from "./env.ts";
import { adoGet, adoPost, resetToken } from "./http.ts";
import { resetIdentityCaches } from "./identity.ts";
import { clearPrCache, fetchPullRequestWorkItems, getPullRequest, getPullRequestWorkItems, getRawPullRequest, mapPr, parsePrArtifact } from "./pr.ts";
import { mapLimit, resetPolicyCaches } from "./policy.ts";
import { attachSurfacingPrs, groupPrsByWorkItem, surfacedPrIdsOf } from "./prWorkItems.ts";
import type { Config } from "../../app/config.ts";
import type { FocusEntity, Identity, PullRequest, WorkItem } from "../../shared/types.ts";

import { urls } from "./urls.ts";
export { adoWorkItemUrl, adoPullRequestUrl, urls } from "./urls.ts";
export { getToken, checkAuth } from "./http.ts";
export { clearPrCache, getPullRequestWorkItems } from "./pr.ts";
export { checkTeam, getMe, getMyTeams, getTeamMembers } from "./identity.ts";
export { mapLimit, enrichPrCI, fetchActivePRs, fetchReviewPRs } from "./policy.ts";

/**
 * Take `next` — config.json as the Settings page just read or saved it — and
 * when the org, project, team or tenant changed, drop every answer cached for
 * the old one —
 * the token (minted per tenant and resource), the identities and team lists, the project id
 * and build results, the PRs (configChange.ts `invalidatedBy`). Says whether
 * any of them changed, and whether an identity id from before still means
 * anything.
 */
export function reloadConfig(next: Config): { caches: boolean; identities: boolean } {
  const { token, caches, identities } = reloadEnv(next);
  if (token) resetToken();
  if (caches) {
    resetIdentityCaches();
    resetPolicyCaches();
    clearPrCache();
  }
  return { caches, identities };
}

// ── Current iteration for the configured team ─────────────────────────────────
// A team that has never configured any sprints 404s here instead of returning an
// empty `value` — both mean "no current iteration", so a 404 is tolerated. Left
// as an error it would fail the whole model load and strand the interactive
// launcher on its "press r to retry" screen, which never recovers (the same 404
// comes back every time).
export async function getCurrentIterationPath(): Promise<string | null> {
  const path =
    `${encodeURIComponent(cfg.project)}/${encodeURIComponent(cfg.team)}` +
    `/_apis/work/teamsettings/iterations?$timeframe=current&${API}`;
  const data = await adoGet(path, { allow404: true });
  return data?.value?.[0]?.path ?? null;
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
    url: urls.workItem({ id }) ?? "",
  };
}

/**
 * The one PR or work item a focus link names, fetched directly instead of
 * through the whole model (see Provider.fetchFocusTarget) — and only when the
 * model for `identity` would provably list it where a number finds it (see
 * `listsPr`, and `getOpenWorkItemIds` for an item: assigned to them, not
 * closed). Anything else, and any failure, is null: the full lookup decides.
 */
export async function fetchFocusTarget(kind: "pr" | "workItem", id: number, identity: Promise<Identity>): Promise<FocusEntity | null> {
  if (kind === "pr") {
    const raw = await getRawPullRequest(id);
    return raw && (await listsPr(raw, await identity)) ? { pr: mapPr(raw) } : null;
  }
  const [raw] = await getWorkItemBatch([id]).catch(() => []);
  return raw && ownOpenItem(raw, await identity) ? { item: await mapRawWorkItem(raw, null) } : null;
}

/**
 * Would the model list this raw PR among `linkedPrs`, `orphanPrs` or
 * `reviewPrs` — the lists a PR number is looked up in? Only an active PR in the
 * configured project, and then:
 *   • one they did not create but are asked to review in person
 *     (`fetchReviewPRs`; a team's request needs the team roster, so it is left
 *     to the full lookup);
 *   • one they created, which `fetchActivePRs` lists — unless a work item it
 *     links to surfaces it under that item (`fetchWorkItemsForPRs`), where the
 *     PR lists no longer hold it. Certain only when it links no item at all,
 *     or links one of their own open items, which lists it as a linked PR.
 * "Would list" ignores the `$top` caps on those list queries: past 200 active
 * PRs of their own, or 100 review requests, the model drops some that this
 * still vouches for — a link then finds a session the full lookup would miss.
 */
async function listsPr(raw: any, identity: Identity): Promise<boolean> {
  if (raw.status !== "active" || !inProject(raw)) return false;
  if (raw.createdBy?.id !== identity.id) return prReviewedBy(raw, identity);
  const linked = await fetchPullRequestWorkItems(raw.repository?.id ?? "", raw.pullRequestId).catch(() => null);
  if (!linked) return false;
  if (linked.length === 0) return true;
  const items = await getWorkItemBatch(linked).catch(() => []);
  return items.some((w) => ownOpenItem(w, identity));
}

/** Is this raw PR in the configured project — the only one the model's PR lists query? */
export function inProject(raw: any): boolean {
  const p = raw.repository?.project;
  const want = cfg.project.toLowerCase();
  return [p?.name, p?.id].some((v) => typeof v === "string" && v.toLowerCase() === want);
}

/** Is `identity` asked to review this raw PR in person? */
export function prReviewedBy(raw: any, identity: Identity): boolean {
  return (raw.reviewers ?? []).some((r: any) => r?.id === identity.id);
}

/**
 * Is this raw work item one the model lists as theirs: assigned to `identity`
 * (by unique name, case-insensitively, as WIQL matches) and not in a closed
 * state (case-insensitively, as WIQL's `NOT IN` compares)?
 */
export function ownOpenItem(raw: any, identity: Identity): boolean {
  const who = raw.fields?.["System.AssignedTo"]?.uniqueName;
  const state = String(raw.fields?.["System.State"] ?? "").toLowerCase();
  if (typeof who !== "string" || who === "" || who.toLowerCase() !== identity.uniqueName.toLowerCase()) return false;
  return !cfg.closedStates.some((c) => c.toLowerCase() === state);
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

  // 2: WI→PRs, skipping WIs already loaded as assigned items.
  const wiToPrs = groupPrsByWorkItem(prs, prToWis, opts.excludeWorkItemIds);
  const newWiIds = [...wiToPrs.keys()];

  // 3: fetch + map the newly-discovered WIs.
  const rawNew = newWiIds.length ? await getWorkItemBatch(newWiIds) : [];
  const items = await Promise.all(rawNew.map((w) => mapRawWorkItem(w, opts.currentIterationPath)));

  // 4: the surfacing PR(s) onto each mapped WI, and which PRs that surfaced.
  attachSurfacingPrs(items, wiToPrs);
  const surfacedPrIds = surfacedPrIdsOf(items, wiToPrs);
  return { items, surfacedPrIds };
}
