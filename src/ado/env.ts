// The one place the ADO REST layer's configuration is resolved.
//
// `loadConfig()` runs at module scope, exactly as it did in ado.ts — ES modules
// are singletons, so importing this from each ado/* module keeps that a SINGLE
// read of the config file rather than one per module.
//
// Base URLs are overridable via env so an integration test can point the whole
// REST layer at a local mock server without patching production defaults. In
// normal use neither var is set and we talk to the real Azure DevOps hosts.
import { loadConfig, type Config } from "../config.ts";

export const cfg: Config = loadConfig();
export const BASE = (process.env.ADO_BASE_URL ?? `https://dev.azure.com/${encodeURIComponent(cfg.org)}`).replace(/\/$/, "");
export const VSSPS = (process.env.ADO_VSSPS_URL ?? "https://app.vssps.visualstudio.com").replace(/\/$/, "");
export const GRAPH = (process.env.ADO_GRAPH_URL ?? `https://vssps.dev.azure.com/${encodeURIComponent(cfg.org)}`).replace(/\/$/, "");
export const API = "api-version=7.1";
