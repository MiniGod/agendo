// Static configuration for the launcher. The org / project / team / tenant
// defaults are intentionally blank — set them for your own Azure DevOps setup
// in ~/.agendo/config.json (see the Config interface below for the shape).
//
// On-disk paths: reads try the new `~/.agendo/` first and fall back to the
// historical `~/.claude-launcher/` (so an existing install keeps working until
// the user moves the data); writes always go to the new dir. The directory
// `STATE_DIR` is the canonical write target — `mkdirSync(STATE_DIR)` is safe to
// run unconditionally.
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import type { ProviderName } from "./types.ts";

export interface Config {
  /** Azure DevOps organization name (the slug in dev.azure.com/<org>). */
  org: string;
  /** Default team project to scope work items / PRs to. */
  project: string;
  /** Team whose current iteration defines "the current sprint", and whose
   *  members populate the "switch who you are" picker. */
  team: string;
  /** Entra tenant id that the ADO org trusts (NOT the default az tenant). */
  tenant: string;
  /** Fixed Azure DevOps application id used as the token resource/audience. */
  resource: string;
  /** Work item states considered "done" — hidden unless expanded. */
  closedStates: string[];
}

const DEFAULTS: Config = {
  org: "",
  project: "",
  team: "",
  tenant: "",
  // Microsoft's well-known public Azure DevOps application id (same for every
  // tenant) — used as the token resource/audience, not a secret.
  resource: "499b84ac-1321-427f-aa17-267ca6975798",
  closedStates: ["Closed", "Done", "Removed", "Resolved"],
};

// New data dir (`~/.agendo/`) — all writes go here. The older dirs are read-only,
// used as fallbacks for reads so existing installs keep working pre-migration:
// `~/.clops/` (the prior name) then `~/.claude-launcher/` (the original name).
export const STATE_DIR = join(homedir(), ".agendo");
export const PREV_STATE_DIR = join(homedir(), ".clops");
export const OLD_STATE_DIR = join(homedir(), ".claude-launcher");
export const STATE_PATH = join(STATE_DIR, "state.json");
const PREV_STATE_PATH = join(PREV_STATE_DIR, "state.json");
const OLD_STATE_PATH = join(OLD_STATE_DIR, "state.json");
const CONFIG_PATH = join(STATE_DIR, "config.json");
const PREV_CONFIG_PATH = join(PREV_STATE_DIR, "config.json");
const OLD_CONFIG_PATH = join(OLD_STATE_DIR, "config.json");

/**
 * First existing file in `paths`, or `paths[0]` as the default write target.
 * Used so reads transparently migrate from the historical `~/.clops/` and
 * `~/.claude-launcher/` paths while writes always go to the new `~/.agendo/`.
 */
function firstExisting(paths: string[]): string {
  for (const p of paths) if (existsSync(p)) return p;
  return paths[0];
}

export function loadConfig(): Config {
  const path = firstExisting([CONFIG_PATH, PREV_CONFIG_PATH, OLD_CONFIG_PATH]);
  if (!existsSync(path)) return DEFAULTS;
  try {
    const override = JSON.parse(readFileSync(path, "utf-8"));
    return { ...DEFAULTS, ...override };
  } catch {
    return DEFAULTS;
  }
}

// ── Persisted UI state ────────────────────────────────────────────────────────
// Who the user is currently viewing as and which backend is selected. Survives
// restarts via STATE_PATH. The provider lives here (not in config.json) so it
// can be toggled at runtime from the UI.
export interface LauncherState {
  /** Backend selected in the UI; absent ⇒ auto-detect from installed CLIs. */
  provider?: ProviderName;
  /** Member id of the selected identity; absent ⇒ the authenticated user. */
  identityId?: string;
  /** Cached display name of the selected identity (instant header render). */
  identityName?: string;
  /** Cached unique name (email) of the selected identity, used in WIQL. */
  identityUniqueName?: string;
}

export function loadState(): LauncherState {
  const path = firstExisting([STATE_PATH, PREV_STATE_PATH, OLD_STATE_PATH]);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LauncherState;
  } catch {
    return {};
  }
}

export function saveState(state: LauncherState): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Persisting UI state is best-effort; ignore write failures.
  }
}
