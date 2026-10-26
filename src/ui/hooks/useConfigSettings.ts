import { useState, type Dispatch, type SetStateAction } from "react";
import { loadConfig, type Config } from "../../app/config.ts";
import { saveConfig } from "../../app/configSave.ts";
import { getMyAdoTeams, reloadAdoConfig } from "../../providers/index.ts";
import { makeConfigActions, type ConfigIo } from "../actions/config.ts";
import type { Mode } from "../keys/context.ts";

const IO: ConfigIo = { save: saveConfig, load: loadConfig, reloadBackend: () => reloadAdoConfig(), myTeams: getMyAdoTeams };

/**
 * config.json as the Settings page shows and edits it, and the closures that
 * save it and open its team picker (../actions/config.ts). One hook so App
 * holds one line for it: the state is read once at mount and replaced after
 * every save.
 */
export function useConfigSettings({ setMode, reload }: { setMode: Dispatch<SetStateAction<Mode>>; reload: () => void }) {
  const [config, setConfig] = useState<Config>(() => loadConfig());
  return { config, ...makeConfigActions({ setConfig, setMode, reload, io: IO }) };
}
