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

export const cfg: Config = loadConfig();
const baseUrl = (c: Config) => (process.env.ADO_BASE_URL ?? `https://dev.azure.com/${encodeURIComponent(c.org)}`).replace(/\/$/, "");
const graphUrl = (c: Config) => (process.env.ADO_GRAPH_URL ?? `https://vssps.dev.azure.com/${encodeURIComponent(c.org)}`).replace(/\/$/, "");
export let BASE = baseUrl(cfg);
export const VSSPS = (process.env.ADO_VSSPS_URL ?? "https://app.vssps.visualstudio.com").replace(/\/$/, "");
export let GRAPH = graphUrl(cfg);
export const API = "api-version=7.1";

/** What a cached answer is keyed by: a change to any of these means a different org, project, team or signed-in tenant. */
export type EnvChange = { org: boolean; project: boolean; team: boolean; tenant: boolean };

/** Re-read config.json into `cfg` and re-derive the base URLs from it; says which of the keys requests depend on changed. */
export function reloadEnv(next: Config = loadConfig()): EnvChange {
  const before = { ...cfg };
  for (const key of Object.keys(cfg)) delete (cfg as Partial<Config>)[key as keyof Config];
  Object.assign(cfg, next);
  BASE = baseUrl(cfg);
  GRAPH = graphUrl(cfg);
  return {
    org: before.org !== cfg.org,
    project: before.project !== cfg.project,
    team: before.team !== cfg.team,
    tenant: before.tenant !== cfg.tenant,
  };
}
