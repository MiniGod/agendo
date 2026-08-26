import type { Identity, TeamMember } from "../types.ts";
import { API, GRAPH, VSSPS, cfg } from "./env.ts";
import { adoGet } from "./http.ts";

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
export async function graphGet(path: string): Promise<any> {
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
export async function getTeamsForMember(memberId: string): Promise<{ id: string; name: string }[]> {
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

