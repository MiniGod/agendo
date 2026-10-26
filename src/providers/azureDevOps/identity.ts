import { messageOf, type ContextualError } from "../../shared/errors.ts";
import type { Identity, TeamCheck, TeamMember } from "../../shared/types.ts";
import { judgeTeam } from "./configChange.ts";
import { API, GRAPH, VSSPS, cacheWriter, cfg } from "./env.ts";
import { adoGet } from "./http.ts";

// ── Identities: the authenticated user, and the configured team's members ─────
let cachedMe: Identity | null = null;

/** The authenticated az user — the default identity, and the "(you)" marker. */
export async function getMe(): Promise<Identity> {
  if (cachedMe) return cachedMe;
  const keep = cacheWriter();
  const d = (await adoGet(
    `${VSSPS}/_apis/profile/profiles/me?api-version=7.1-preview.3`,
  )) as { id: string; displayName?: string; emailAddress?: string };
  const me: Identity = {
    id: d.id,
    displayName: d.displayName ?? "Me",
    uniqueName: d.emailAddress ?? "",
  };
  keep(() => (cachedMe = me));
  return me;
}

let cachedMembers: TeamMember[] | null = null;
// ADO's words when the members request 404'd: the configured team doesn't
// exist. That is a config mistake, not an outage, so it leaves the roster empty
// and is reported by `checkTeam` — a notice in the TUI, a failed load in the
// CLI. Neither it nor the empty roster is cached: the next load asks again, so
// a team created since, in Azure DevOps, shows without a restart.
let teamMissing: string | null = null;

/** The members request's answer, or null when it 404'd (`teamMissing` keeps why). */
async function fetchMembers(keep: (write: () => void) => void): Promise<any> {
  try {
    const data = await adoGet(
      `_apis/projects/${encodeURIComponent(cfg.project)}` +
        `/teams/${encodeURIComponent(cfg.team)}/members?${API}`,
    );
    keep(() => (teamMissing = null));
    return data;
  } catch (e) {
    if ((e as ContextualError).status !== 404) throw e;
    keep(() => (teamMissing = messageOf(e)));
    return null;
  }
}

/** Members of the configured team — the roster for the identity switcher. */
export async function getTeamMembers(): Promise<TeamMember[]> {
  if (cachedMembers) return cachedMembers;
  const keep = cacheWriter();
  const data = await fetchMembers(keep);
  const members: TeamMember[] = (data?.value ?? [])
    .map((m: any) => m.identity)
    .filter(Boolean)
    .map((i: any): TeamMember => ({
      id: i.id,
      displayName: i.displayName ?? i.uniqueName ?? i.id,
      uniqueName: i.uniqueName ?? "",
    }));
  members.sort((a, b) => a.displayName.localeCompare(b.displayName));
  if (data !== null) keep(() => (cachedMembers = members));
  return members;
}

// ── The signed-in user's own teams (the Settings team picker, and checkTeam) ──
let cachedMyTeams: string[] | null = null;

/**
 * Names of the configured project's teams the signed-in user is a member of,
 * sorted. One request, cached until the config changes (`resetIdentityCaches`)
 * or the team check finds something to say; a failure is not cached. `fresh`
 * asks again regardless — the team picker, opened on purpose, does.
 */
export async function getMyTeams({ fresh = false }: { fresh?: boolean } = {}): Promise<string[]> {
  if (cachedMyTeams && !fresh) return cachedMyTeams;
  const keep = cacheWriter();
  const data = await adoGet(
    `_apis/projects/${encodeURIComponent(cfg.project)}/teams` +
      `?$mine=true&$top=200&api-version=7.1-preview.3`,
  );
  const names: string[] = (data?.value ?? [])
    .map((t: any) => t?.name)
    .filter((n: unknown): n is string => typeof n === "string");
  names.sort((a, b) => a.localeCompare(b));
  keep(() => (cachedMyTeams = names));
  return names;
}

/**
 * Whether the configured team is one the user can expect their sprint from: null
 * when it is one of their own teams (or nothing can be told), else what to say
 * about it. Run after `getTeamMembers`, whose 404 is the fallback signal when
 * the user's teams can't be listed — or aren't asked for (`listMine: false`,
 * which costs no request). Never throws.
 */
export async function checkTeam({ listMine = true }: { listMine?: boolean } = {}): Promise<TeamCheck | null> {
  const mine = listMine ? await getMyTeams().catch(() => null) : null;
  const check = judgeTeam({ team: cfg.team, project: cfg.project, mine, missing: teamMissing });
  // A notice asks for a fix that may land in Azure DevOps rather than here (an
  // admin adding you to the team), so the next load asks again, not the cache.
  if (check) cachedMyTeams = null;
  return check;
}

// ── Teams a member belongs to (for "PRs assigned to your teams") ───────────────
// A team's group descriptor resolves (via Graph storage key) back to the team
// id, which is exactly what the PR search accepts as `reviewerId`. So we map the
// member's group memberships → ids and keep those that are real teams.
export async function graphGet(path: string): Promise<any> {
  return adoGet(`${GRAPH}/_apis/graph/${path}`);
}

let cachedProjectTeams: { id: string; name: string }[] | null = null;
async function getProjectTeams(): Promise<{ id: string; name: string }[]> {
  if (cachedProjectTeams) return cachedProjectTeams;
  const keep = cacheWriter();
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
  keep(() => (cachedProjectTeams = teams));
  return teams;
}

const teamsForMemberCache = new Map<string, { id: string; name: string }[]>();
export async function getTeamsForMember(memberId: string): Promise<{ id: string; name: string }[]> {
  const cached = teamsForMemberCache.get(memberId);
  if (cached) return cached;
  const keep = cacheWriter();
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
    keep(() => teamsForMemberCache.set(memberId, result));
    return result;
  } catch {
    // Graph traversal can fail for accounts without directory read access; the
    // review section still works for the person themselves in that case.
    keep(() => teamsForMemberCache.set(memberId, []));
    return [];
  }
}


/** Forget every answer above — they were all for the org, project, team and tenant config.json named before it changed. */
export function resetIdentityCaches(): void {
  cachedMe = null;
  cachedMembers = null;
  teamMissing = null;
  cachedMyTeams = null;
  cachedProjectTeams = null;
  teamsForMemberCache.clear();
}
