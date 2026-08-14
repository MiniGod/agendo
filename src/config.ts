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
import { parseJsonFileOr } from "./errors.ts";
import type { ProviderName } from "./types.ts";
import type { ResumeDialogChoice } from "./tmux.ts";

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
  /**
   * Minutes of inactivity after which a live, non-busy session is qualified as
   * "stalled" in `agendo list` / `agendo status` (see src/idle.ts). Overridable
   * per invocation with `--stalled-after <dur>`.
   */
  stalledAfterMinutes: number;
  /**
   * Which option agendo picks when a resumed claude session opens the CLI's own
   * "how should I resume?" dialog (see paneResumeDialogActive in tmux.ts):
   *   - "summary" (default) — the option claude itself marks `(recommended)`,
   *     i.e. resume from a summary rather than replaying the whole transcript;
   *   - "as-is"             — resume the full session, at full token cost.
   * Its third option, "Don't ask me again", is intentionally NOT offered here:
   * it permanently changes the user's global claude CLI behaviour, which is the
   * user's call to make, not agendo's.
   *
   * Optional so a config.json — or a Config literal built elsewhere in the tree —
   * needn't carry it; `resumeDialogChoice()` below resolves absence to the default.
   */
  resumeDialogChoice?: ResumeDialogChoice;
}

/**
 * Default stall threshold, in minutes. Lives here (not in src/idle.ts) so
 * `DEFAULT_CONFIG` below and the fallback idle.ts uses for a malformed
 * configured value can't drift apart — idle.ts imports it.
 */
export const DEFAULT_STALLED_AFTER_MINUTES = 240;

/** Shipped defaults — every field a config.json may override. */
export const DEFAULT_CONFIG: Config = {
  org: "",
  project: "",
  team: "",
  tenant: "",
  // Microsoft's well-known public Azure DevOps application id (same for every
  // tenant) — used as the token resource/audience, not a secret.
  resource: "499b84ac-1321-427f-aa17-267ca6975798",
  closedStates: ["Closed", "Done", "Removed", "Resolved"],
  stalledAfterMinutes: DEFAULT_STALLED_AFTER_MINUTES,
  // Default to whatever claude marks `(recommended)` — resuming from a summary,
  // which is also the cheaper of the two.
  resumeDialogChoice: "summary",
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

/**
 * A fresh copy of the shipped defaults, arrays included. DEFAULT_CONFIG is
 * exported, so handing it (or its `closedStates` array) out by identity would let
 * one caller's edit leak into every later load. Every return path below hands out
 * a call of this, never the shared object.
 */
function defaults(): Config {
  return { ...DEFAULT_CONFIG, closedStates: [...DEFAULT_CONFIG.closedStates] };
}

// A malformed config/state file falls back to defaults and records a warning
// naming the path (surfaced by the UI) rather than throwing: both files are
// preferences whose every value is re-derivable, so bricking the launcher over
// one — with a message that doesn't even say which file — is strictly worse.
export function loadConfig(): Config {
  const path = firstExisting([CONFIG_PATH, PREV_CONFIG_PATH, OLD_CONFIG_PATH]);
  if (!existsSync(path)) return defaults();
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return defaults(); // unreadable (permissions, races) — nothing to diagnose
  }
  const override = parseJsonFileOr<Partial<Config>>(text, path, {});
  // `JSON.parse('"oops"')`/`42` succeed but aren't records; spreading a string
  // would inject its character indices as config keys (same guard as loadState).
  return { ...defaults(), ...(override && typeof override === "object" ? override : {}) };
}

/**
 * The resume-dialog choice to act on: the configured value when it's one we
 * recognize, else the default. Config is hand-edited JSON, and an unrecognized
 * value must not leave `send` unable to answer the dialog — the fallback is the
 * option claude itself recommends, which is the safe, cheap one.
 */
export function resumeDialogChoice(c: Config = loadConfig()): ResumeDialogChoice {
  return c.resumeDialogChoice === "as-is" ? "as-is" : "summary";
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
  /**
   * When true, a session detected at its usage limit (with a parseable reset
   * time) is automatically nudged to continue once that reset passes. Default
   * OFF — toggled from the Settings page. See src/usageLimit.ts.
   */
  autoResumeOnUsageLimit?: boolean;
}

export function loadState(): LauncherState {
  const path = firstExisting([STATE_PATH, PREV_STATE_PATH, OLD_STATE_PATH]);
  if (!existsSync(path)) return {};
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  const state = parseJsonFileOr<LauncherState>(text, path, {});
  // `JSON.parse("42")`/`"null"` succeed but aren't records; a non-object state
  // would break every `state.x` read below it.
  return state && typeof state === "object" ? state : {};
}

export function saveState(state: LauncherState): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch {
    // Persisting UI state is best-effort; ignore write failures.
  }
}
