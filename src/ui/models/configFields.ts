// The config.json settings the Settings page edits: what each row is called,
// what it means, how its value reads on the row, and how typed text
// becomes a value — or the error shown under the input. Pure, so the page's
// keys (src/ui/keys/settings.ts, settingsEdit.ts) and its screen share one
// table and the unit suite can walk every arm.
//
// `resource` is deliberately absent: it is Microsoft's fixed Azure DevOps
// application id, the same for every tenant, so the page shows it read-only.
import { homedir } from "os";
import { resumeDialogChoice, type Config } from "../../app/config.ts";
import type { ConfigPatch } from "../../app/configSave.ts";

export type ConfigField =
  | "org" | "project" | "team" | "tenant" | "closedStates"
  | "stalledAfterMinutes" | "resumeDialogChoice" | "peerSocket" | "focusTerminal";

/** The fields edited by typing — every one but the two that toggle. Team is
 *  typed too, as the fallback below its picker. */
export type TextField = Exclude<ConfigField, "resumeDialogChoice" | "peerSocket">;

/** The fields enter flips in place rather than opening an editor for. */
export type ToggleField = Exclude<ConfigField, TextField>;

/** Every actionable row of the Settings page, in display order. */
export type SettingsItem = "provider" | "identity" | "autoResume" | ConfigField;

interface FieldSpec {
  label: string;
  /** What the field means, shown under the input while it is edited. */
  hint: string;
  /** Changing it re-points the Azure DevOps requests, so the model reloads. */
  reloads: boolean;
}

export const FIELD_SPECS: Record<ConfigField, FieldSpec> = {
  org: { label: "Organization", hint: "the <org> in dev.azure.com/<org>", reloads: true },
  project: { label: "Project", hint: "the team project work items and PRs come from", reloads: true },
  team: { label: "Team", hint: "whose current iteration is \"Current sprint\", exactly as Azure DevOps names it", reloads: true },
  tenant: { label: "Tenant", hint: "the Entra tenant id (or domain) the org trusts, passed to az --tenant", reloads: true },
  closedStates: { label: "Closed states", hint: "comma-separated work-item states treated as done", reloads: true },
  stalledAfterMinutes: { label: "Stalled after (minutes)", hint: "idle minutes before `agendo list` and `agendo status` mark a live session ⚠stalled", reloads: false },
  resumeDialogChoice: { label: "Resume dialog choice", hint: "", reloads: false },
  peerSocket: { label: "Peer socket", hint: "", reloads: false },
  focusTerminal: {
    label: "Focus terminal",
    hint: "run when no tmux client is attached; {session} becomes the session to attach to · empty turns it off",
    reloads: false,
  },
};

/** The config rows, in display order. */
export const CONFIG_FIELDS: readonly ConfigField[] = [
  "org", "project", "team", "tenant", "closedStates",
  "stalledAfterMinutes", "resumeDialogChoice", "peerSocket", "focusTerminal",
];

/** Every row of the Settings page, in the order the cursor walks them. */
export const SETTINGS_ITEMS: readonly SettingsItem[] = ["provider", "identity", "autoResume", ...CONFIG_FIELDS];

export function isConfigField(item: SettingsItem | undefined): item is ConfigField {
  return (CONFIG_FIELDS as readonly (SettingsItem | undefined)[]).includes(item);
}

/** The text a field's editor opens with. config.json is hand-edited, so a value of the wrong type still reads as something. */
export function fieldText(field: ConfigField, c: Config): string {
  const v: unknown = c[field];
  if (Array.isArray(v)) return v.join(", ");
  return v === undefined || v === null ? "" : String(v);
}

export interface Shown {
  text: string;
  color?: string;
}

const DISPLAY: Partial<Record<ConfigField, (c: Config) => Shown>> = {
  resumeDialogChoice: (c) => ({ text: resumeDialogChoice(c) === "as-is" ? "as-is (full transcript)" : "summary (recommended)", color: "cyan" }),
  peerSocket: (c) => (c.peerSocket === false ? { text: "off", color: "gray" } : { text: "on", color: "green" }),
  focusTerminal: (c) => (fieldText("focusTerminal", c).trim() ? { text: fieldText("focusTerminal", c) } : { text: "(off)", color: "gray" }),
};

/** How a field's current value reads on its Settings row. */
export function fieldDisplay(field: ConfigField, c: Config): Shown {
  const special = DISPLAY[field];
  if (special) return special(c);
  const text = fieldText(field, c);
  return text.trim() ? { text } : { text: "(not set)", color: "yellow" };
}

/** What enter on a toggle row saves: the value it isn't now. */
export function toggledValue(field: ToggleField, c: Config): ConfigPatch {
  if (field === "peerSocket") return { peerSocket: c.peerSocket === false };
  return { resumeDialogChoice: resumeDialogChoice(c) === "as-is" ? "summary" : "as-is" };
}

export type Parsed = { patch: ConfigPatch } | { error: string };

/** `raw` trimmed, or the error for leaving it blank. */
function required(raw: string, what: string): { value: string } | { error: string } {
  const value = raw.trim();
  return value ? { value } : { error: `${what} can't be empty` };
}

/** A name that goes into a URL or an argv word as-is: required, and no whitespace or slash. */
function word(raw: string, what: string): { value: string } | { error: string } {
  const r = required(raw, what);
  if ("error" in r) return r;
  return /[\s/]/.test(r.value) ? { error: `${what} has no spaces or slashes` } : r;
}

/** A project or team name: required, spaces allowed, but no slash — it is one segment of the URLs it goes into. */
function segment(raw: string, what: string): { value: string } | { error: string } {
  const r = required(raw, what);
  if ("error" in r) return r;
  return /[/\\]/.test(r.value) ? { error: `${what} has no slashes (its name, not a URL)` } : r;
}

function parseClosedStates(raw: string): Parsed {
  const states = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (states.length === 0) return { error: "list at least one state, comma-separated (e.g. Closed, Done, Removed)" };
  if (states.some((s) => s.includes("'"))) return { error: "a state name can't contain ' (it would break the work-item query)" };
  return { patch: { closedStates: states } };
}

function parseMinutes(raw: string): Parsed {
  const text = raw.trim();
  const n = Number(text);
  // 0 is a value like any other here, as it is to `resolveStalledAfterMs`: every idle session reads stalled.
  if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(n)) return { error: "enter a number of minutes, 0 or more (e.g. 240)" };
  return { patch: { stalledAfterMinutes: n } };
}

/** Wrap a checked string as the patch for `field`, or pass its error through. */
function patchOf(field: "org" | "project" | "team" | "tenant", r: { value: string } | { error: string }): Parsed {
  return "error" in r ? r : { patch: { [field]: r.value } };
}

const PARSE: Record<TextField, (raw: string) => Parsed> = {
  org: (raw) => patchOf("org", word(raw, "the organization")),
  project: (raw) => patchOf("project", segment(raw, "the project")),
  team: (raw) => patchOf("team", segment(raw, "the team")),
  tenant: (raw) => patchOf("tenant", word(raw, "the tenant")),
  closedStates: parseClosedStates,
  stalledAfterMinutes: parseMinutes,
  // Empty removes the key, which is how the feature is turned off.
  focusTerminal: (raw) => ({ patch: { focusTerminal: raw.trim() || undefined } }),
};

/** What the user typed into `field`'s editor, as the patch to save or the error to show. */
export function parseField(field: TextField, raw: string): Parsed {
  return PARSE[field](raw);
}

/** Whether saving `patch` re-points the Azure DevOps requests (and so reloads the model). */
export function patchReloads(patch: ConfigPatch): boolean {
  return Object.keys(patch).some((k) => FIELD_SPECS[k as ConfigField]?.reloads === true);
}

/** `path` with the home directory written as `~`, the way the README names the config files. */
export function tildePath(path: string, home: string = homedir()): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
