import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";
import { listStep } from "./nav.ts";
import { afterSave, openEditor, settingsAt } from "./settings.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "config" | "saveConfigPatch">;
type TeamMode = Extract<Mode, { kind: "teamPicker" }>;

/** The picker's rows: each of the user's teams, then "type a name" — the only row while they load. */
export function teamRowCount(mode: TeamMode): number {
  return (mode.teams?.length ?? 0) + 1;
}

/** The cursor one row on, wrapping; a no-op once the picker is gone. */
export function stepTeam(step: 1 | -1): (p: Mode) => Mode {
  return (p) => (p.kind === "teamPicker" ? { ...p, cursor: (p.cursor + step + teamRowCount(p)) % teamRowCount(p) } : p);
}

/** Whether `p` is the picker still waiting on list request `request`; the request can outlive it. */
function awaiting(p: Mode, request: number): p is TeamMode {
  return p.kind === "teamPicker" && p.request === request;
}

/**
 * The teams have arrived: list them, the cursor on `current` when it is one of
 * them. Ignored unless the picker that asked is still up.
 */
export function teamsLoaded(teams: string[], current: string, request: number): (p: Mode) => Mode {
  const at = teams.findIndex((t) => t.toLowerCase() === current.trim().toLowerCase());
  return (p) => (awaiting(p, request) ? { ...p, teams, cursor: Math.max(0, at) } : p);
}

/** The teams couldn't be listed: say why, and leave typing a name as the way on. */
export function teamsFailed(error: string, request: number): (p: Mode) => Mode {
  return (p) => (awaiting(p, request) ? { ...p, teams: [], cursor: 0, error } : p);
}

/** Enter: save the team under the cursor, or open the editor to type one. */
export function pickTeam(mode: TeamMode, ctx: Ctx): void {
  const picked = mode.teams?.[mode.cursor];
  if (picked === undefined) {
    ctx.setMode(openEditor("team", ctx.config));
    return;
  }
  const error = ctx.saveConfigPatch({ team: picked });
  ctx.setMode(error ? { ...mode, error } : afterSave("team", null));
}

// ── team picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleTeamPickerKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "teamPicker") return false;
  const step = listStep(input, key);
  if (key.escape) ctx.setMode(settingsAt("team"));
  else if (step !== null) ctx.setMode(stepTeam(step));
  else if (key.return) pickTeam(mode, ctx);
  return true;
}
