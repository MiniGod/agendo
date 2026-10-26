import type { Dispatch, SetStateAction } from "react";
import type { Config } from "../../app/config.ts";
import type { ConfigPatch } from "../../app/configSave.ts";
import { messageOf } from "../../shared/errors.ts";
import type { Mode } from "../keys/context.ts";
import { teamsFailed, teamsLoaded } from "../keys/teamPicker.ts";
import { patchReloads } from "../models/configFields.ts";

/**
 * The outside world the config actions touch — the file, and the Azure DevOps
 * layer. Passed in (../hooks/useConfigSettings.ts wires the real ones) so this
 * module imports neither, and the unit suite can drive it without reading or
 * writing a real config.json.
 */
export interface ConfigIo {
  save: (patch: ConfigPatch) => unknown;
  load: () => Config;
  /** Re-read the file into the Azure DevOps layer; whether org/project/team/tenant changed. */
  reloadBackend: () => boolean;
  myTeams: () => Promise<string[]>;
}

// Numbers each team picker's list request. Module-level because the actions
// are rebuilt on every render, and the count must outlive them.
let pickerRequests = 0;

/**
 * Saving config.json from the Settings page, and the team picker's list.
 *
 * Same shape as `makeProviderActions`: plain closures over App's setters, no
 * hooks. A save that changes where requests go (org, project, team, tenant,
 * closed states) re-points the Azure DevOps layer, drops what it cached for the
 * old values, and reloads the model, so "Current sprint" follows without a
 * restart. The other fields are read fresh by whatever uses them.
 */
export function makeConfigActions({
  setConfig,
  setMode,
  reload,
  io,
}: {
  setConfig: Dispatch<SetStateAction<Config>>;
  setMode: Dispatch<SetStateAction<Mode>>;
  reload: () => void;
  io: ConfigIo;
}) {
  function saveConfigPatch(patch: ConfigPatch): string | null {
    try {
      io.save(patch);
    } catch (e) {
      return `couldn't save: ${messageOf(e)}`;
    }
    setConfig(io.load());
    // Always re-read, so closedStates reaches the WIQL too; reload when either says so.
    if (io.reloadBackend() || patchReloads(patch)) reload();
    return null;
  }

  function enterTeamPicker(current: string): void {
    const request = ++pickerRequests;
    setMode({ kind: "teamPicker", cursor: 0, teams: null, request });
    io.myTeams().then(
      (teams) => setMode(teamsLoaded(teams, current, request)),
      (e: unknown) => setMode(teamsFailed(`couldn't list your teams: ${messageOf(e)}`, request)),
    );
  }

  return { saveConfigPatch, enterTeamPicker };
}
