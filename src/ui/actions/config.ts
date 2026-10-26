import type { Dispatch, SetStateAction } from "react";
import type { Config } from "../../app/config.ts";
import type { ConfigPatch } from "../../app/configSave.ts";
import { messageOf } from "../../shared/errors.ts";
import type { Identity, ProviderName } from "../../shared/types.ts";
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
  /** Why the file in effect can't be read as a config, or null when it can (configSave.ts `configReadError`). */
  readError: () => string | null;
  /**
   * Re-read the file into the Azure DevOps layer: whether org/project/team/tenant
   * changed (`caches`), and whether org or tenant did (`identities`).
   */
  reloadBackend: () => { caches: boolean; identities: boolean };
  myTeams: () => Promise<string[]>;
}

// Numbers each team picker's list request. Module-level because the actions
// are rebuilt on every render, and the count must outlive them.
let pickerRequests = 0;

/**
 * Opening the Settings page on a fresh read of config.json, saving it, and
 * the team picker's list.
 *
 * Same shape as `makeProviderActions`: plain closures over App's setters, no
 * hooks. A save that changes where requests go (org, project, team, tenant,
 * closed states) re-points the Azure DevOps layer, drops what it cached for the
 * old values, and — on that backend — reloads the model, so "Current sprint"
 * follows without a restart. The GitHub model reads none of them, so it isn't
 * fetched again for one. The other fields are read fresh by whatever uses them.
 */
export function makeConfigActions({
  setConfig,
  setMode,
  reload,
  provider,
  setIdentity,
  persist,
  io,
}: {
  setConfig: Dispatch<SetStateAction<Config>>;
  setMode: Dispatch<SetStateAction<Mode>>;
  reload: () => void;
  /** The backend in use, and the "viewing as" choice a move to another org or tenant drops. */
  provider: ProviderName;
  setIdentity: (i: Identity | null) => void;
  persist: (next: { identity: null }) => void;
  io: ConfigIo;
}) {
  const onAdo = provider === "ado";

  /** Re-read the file into the Azure DevOps layer; whether the model in view must reload. */
  function followFile(): boolean {
    const moved = io.reloadBackend();
    if (!onAdo) return false;
    // Identity ids belong to an org and its tenant: as on a backend switch, the override goes.
    if (moved.identities) {
      setIdentity(null);
      persist({ identity: null });
    }
    return moved.caches;
  }

  function saveConfigPatch(patch: ConfigPatch): string | null {
    try {
      io.save(patch);
    } catch (e) {
      return `couldn't save: ${messageOf(e)}`;
    }
    setConfig(io.load());
    // Always re-read, so closedStates reaches the WIQL too; reload when either says so.
    if (followFile() || (onAdo && patchReloads(patch))) reload();
    return null;
  }

  /**
   * Open the Settings page on config.json as it is now — another agendo, or a
   * hand edit, may have changed it since the last read. The Azure DevOps layer
   * follows the file too, and the model reloads when requests moved. A file
   * that won't read (half-written, or a hand edit gone wrong) would read as
   * blank defaults, so the values in use stay, here and in the backend — the
   * last good read, or the defaults when the file was broken at launch too —
   * and the note says what to do about the file.
   */
  function openSettings(): void {
    const unreadable = io.readError();
    if (unreadable) {
      setMode({ kind: "settings", cursor: 0, note: { text: unreadable, error: true } });
      return;
    }
    setConfig(io.load());
    if (followFile()) reload();
    setMode({ kind: "settings", cursor: 0 });
  }

  function enterTeamPicker(current: string): void {
    const request = ++pickerRequests;
    setMode({ kind: "teamPicker", cursor: 0, teams: null, request });
    io.myTeams().then(
      (teams) => setMode(teamsLoaded(teams, current, request)),
      (e: unknown) => setMode(teamsFailed(`couldn't list your teams: ${messageOf(e)}`, request)),
    );
  }

  return { saveConfigPatch, openSettings, enterTeamPicker };
}
