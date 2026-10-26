// The pure half of re-reading config.json under a running launcher (env.ts
// `reloadEnv`, index.ts `reloadConfig`) and of the team check (identity.ts
// `checkTeam`). Kept free of env.ts, which reads the config file at import, so
// test/ can load it bare — the same split as auth.ts.
import type { Config } from "../../app/config.ts";
import type { TeamCheck } from "../../shared/types.ts";

/**
 * What a config.json change invalidates. The token is minted per tenant and
 * resource (the audience `az` is asked for); every other cached answer — identities, team lists, the project id, build results,
 * PRs — belongs to an org, project and team, and a tenant change can mean
 * another account seeing them. `identities` is whether an identity id from
 * before (the launcher's "viewing as" choice) can mean anything after: those
 * belong to an org and its tenant, not to a project or team.
 */
export interface Invalidated {
  token: boolean;
  caches: boolean;
  identities: boolean;
}

export function invalidatedBy(before: Config, after: Config): Invalidated {
  const identities = before.tenant !== after.tenant || before.org !== after.org;
  return {
    token: before.tenant !== after.tenant || before.resource !== after.resource,
    identities,
    caches: identities || before.project !== after.project || before.team !== after.team,
  };
}

/**
 * What to say about the configured team, or null for nothing: a team that is
 * one of `mine` (the signed-in user's own), and a team nothing can be told
 * about — `mine` unknown and the members request didn't 404 (`missing`, ADO's
 * words for the 404 when it did). `projectMissing` is the team list's own 404,
 * which only a project that doesn't exist answers with.
 */
export function judgeTeam({
  team,
  project,
  mine,
  missing,
  projectMissing = false,
}: {
  team: unknown;
  project: unknown;
  mine: string[] | null;
  missing: string | null;
  projectMissing?: boolean;
}): TeamCheck | null {
  // config.json is hand-edited: a value of the wrong type reads as text, never as a crash.
  const name = String(team ?? "").trim();
  const where = String(project ?? "");
  if (!mine) return missing === null ? null : { team: name, project: where, mine: null, why: missing, ...(projectMissing ? { projectMissing } : {}) };
  const isMine = name !== "" && mine.some((t) => t.toLowerCase() === name.toLowerCase());
  return isMine ? null : { team: name, project: where, mine };
}
