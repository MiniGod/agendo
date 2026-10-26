import { useState, type Dispatch, type SetStateAction } from "react";
import { loadConfig, type Config } from "../../app/config.ts";
import { readConfig, saveConfig } from "../../app/configSave.ts";
import { getMyAdoTeams, reloadAdoConfig } from "../../providers/index.ts";
import type { Identity, ProviderName } from "../../shared/types.ts";
import { makeConfigActions, type ConfigIo } from "../actions/config.ts";
import type { Mode } from "../keys/context.ts";

const IO: ConfigIo = {
  save: (patch) => saveConfig(patch),
  read: () => readConfig(),
  reloadBackend: reloadAdoConfig,
  // Opened on purpose, so asked fresh: the answer the team check cached may predate a fix made in Azure DevOps.
  myTeams: () => getMyAdoTeams({ fresh: true }),
};

/**
 * config.json as the Settings page shows and edits it, and the closures that
 * open the page, save it and open its team picker (../actions/config.ts). One
 * hook so App holds one line for it: the state is read at mount, and again
 * whenever the page opens and after every save.
 */
export function useConfigSettings(deps: {
  setMode: Dispatch<SetStateAction<Mode>>;
  reload: () => void;
  provider: ProviderName;
  setIdentity: (i: Identity | null) => void;
  persist: (next: { identity: null }) => void;
}) {
  const [config, setConfig] = useState<Config>(() => loadConfig());
  return { config, ...makeConfigActions({ ...deps, setConfig, io: IO }) };
}
