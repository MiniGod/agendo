// The one place the ADO REST layer's configuration is resolved.
//
// `loadConfig()` runs at module scope, exactly as it did in ado.ts — ES modules
// are singletons, so importing this from each ado/* module keeps that a SINGLE
// read of the config file rather than one per module. The Settings page can
// change the file under a running launcher, so `reloadEnv` re-reads it INTO the
// same `cfg` object (every module holds that object, not a copy) and re-derives
// the base URLs, which are live bindings for the same reason.
//
// Base URLs are overridable via env so an integration test can point the whole
// REST layer at a local mock server without patching production defaults. In
// normal use neither var is set and we talk to the real Azure DevOps hosts.
import { loadConfig, type Config } from "../../app/config.ts";
import { invalidatedBy, type Invalidated } from "./configChange.ts";

export const cfg: Config = loadConfig();
const baseUrl = (c: Config) => (process.env.ADO_BASE_URL ?? `https://dev.azure.com/${encodeURIComponent(c.org)}`).replace(/\/$/, "");
const graphUrl = (c: Config) => (process.env.ADO_GRAPH_URL ?? `https://vssps.dev.azure.com/${encodeURIComponent(c.org)}`).replace(/\/$/, "");
export let BASE = baseUrl(cfg);
export const VSSPS = (process.env.ADO_VSSPS_URL ?? "https://app.vssps.visualstudio.com").replace(/\/$/, "");
export let GRAPH = graphUrl(cfg);
export const API = "api-version=7.1";

// Bumped by `reloadEnv` when org, project, team or tenant change. The caches are cleared then,
// but a request the old load started before the save can land after it, and
// must not refill them with an answer about the old org, project or team.
let configEpoch = 0;

/** A cache write bound to the config as it is now: it runs only if org, project, team and tenant haven't changed since. */
export function cacheWriter(): (write: () => void) => void {
  const epoch = configEpoch;
  return (write) => {
    if (epoch === configEpoch) write();
  };
}

/** Re-read config.json into `cfg` and re-derive the base URLs from it; says what the change invalidates. */
export function reloadEnv(): Invalidated {
  const before = { ...cfg };
  for (const key of Object.keys(cfg)) delete (cfg as Partial<Config>)[key as keyof Config];
  Object.assign(cfg, loadConfig());
  BASE = baseUrl(cfg);
  GRAPH = graphUrl(cfg);
  const invalidated = invalidatedBy(before, cfg);
  if (invalidated.caches) configEpoch++;
  return invalidated;
}
