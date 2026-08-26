// Azure DevOps access layer. Talks to the REST API directly using a token
// minted from the user's existing `az` login — no PAT, no azure-devops CLI
// extension. The default az tenant returns 401 for the org, so we always
// request a token scoped to the configured tenant.
//
// The layer is split across src/ado/: env.ts (config + base URLs, resolved
// once), urls.ts (canonical web links), http.ts (token + fetch), pr.ts (pull
// requests), identity.ts (who am I / the team), policy.ts (CI + merge gates).
// What stays here is the work-item side and the public assembly on top of it.
//
// This file remains the single import path — src/provider.ts does
// `import * as ado from "./ado.ts"` and e2e/provider.spec.ts imports the URL
// builders by name — so the re-exports below are exactly the 18 names it
// exported before, written out rather than `export *` so that helpers which
// only became cross-module for the split (mapPr, getTeamsForMember,
// adoGet/adoPost) are not promoted into the public surface.
import { API, cfg } from "./ado/env.ts";
import { adoGet, adoPost } from "./ado/http.ts";
import { getPullRequest, getPullRequestWorkItems, parsePrArtifact } from "./ado/pr.ts";
import { mapLimit } from "./ado/policy.ts";
import type { PullRequest, WorkItem } from "./types.ts";

import { urls } from "./ado/urls.ts";
export { adoWorkItemUrl, adoPullRequestUrl, urls } from "./ado/urls.ts";
export { getToken, checkAuth } from "./ado/http.ts";
export { clearPrCache, getPullRequestWorkItems } from "./ado/pr.ts";
export { getMe, getTeamMembers } from "./ado/identity.ts";
export { mapLimit, enrichPrCI, fetchActivePRs, fetchReviewPRs } from "./ado/policy.ts";

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
