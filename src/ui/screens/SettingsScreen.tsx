import { Box, Text, useStdout } from "ink";
import { CONFIG_PATH, type Config } from "../../app/config.ts";
import { PROVIDER_INFO } from "../../providers/index.ts";
import type { Identity, ProviderName } from "../../shared/types.ts";
import { padCell } from "../format/index.ts";
import {
  FIELD_SPECS, fieldDisplay, isConfigField, tildePath, type SettingsItem, type Shown,
} from "../models/configFields.ts";

type UiItem = Exclude<SettingsItem, keyof typeof FIELD_SPECS>;

const UI_LABELS: Record<UiItem, string> = { provider: "Backend", identity: "Viewing as", autoResume: "Auto-resume on usage limit" };

function settingLabel(item: SettingsItem): string {
  return isConfigField(item) ? FIELD_SPECS[item].label : UI_LABELS[item];
}

/** Where config.json is read from, and — while that is a legacy file — where the first save will write it. */
function ConfigSource({ inEffect }: { inEffect: string }) {
  const saveTo = tildePath(CONFIG_PATH);
  const from = tildePath(inEffect);
  return (
    <Text dimColor wrap="truncate">
      {from === saveTo ? `config.json · ${saveTo}` : `config.json · read from ${from} · saving writes all of it to ${saveTo}`}
    </Text>
  );
}

function SettingRow({ label, value, sel }: { label: string; value: Shown; sel: boolean }) {
  return (
    <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined} wrap="truncate">
      {sel ? "❯ " : "  "}
      <Text bold>{padCell(label, 28)}</Text>
      <Text color={sel ? "black" : value.color}>{value.text}</Text>
    </Text>
  );
}

/**
 * Lines the page spends on everything but its rows: the title, the hint, three
 * gaps, the config.json source line, Resource, the Authentication heading, a
 * line per backend and the last save's note — plus Ink's last line, which a
 * page as tall as the terminal would scroll the title away with.
 */
export function settingsChrome(backends: number, note: boolean): number {
  return 9 + backends + (note ? 1 : 0);
}

/**
 * The rows that fit in `room` lines, as [start, end): every one when they all
 * fit; otherwise a window around the cursor, one line shorter to leave room
 * for saying how many are out of view.
 */
export function settingsWindow(cursor: number, count: number, room: number): { start: number; end: number } {
  if (count <= room) return { start: 0, end: count };
  const page = Math.max(1, room - 1);
  const start = Math.min(Math.max(0, cursor - Math.floor(page / 2)), count - page);
  return { start, end: start + page };
}

/** The line under a windowed list: how many rows are above and below it. */
export function hiddenRowsText(above: number, below: number): string | null {
  const parts = [above > 0 ? `↑ ${above} more` : "", below > 0 ? `↓ ${below} more` : ""].filter(Boolean);
  return parts.length > 0 ? `  ${parts.join(" · ")}` : null;
}

/**
 * The Settings page: the actionable rows on top (in `settingsItems` order, the
 * same array the key handler walks) — the launcher's own state, then the
 * config.json fields, windowed around the cursor when the terminal is too short
 * for all of them — then a read-only report of every backend's CLI + auth
 * state. `authStatus` is the probe that runs on entering the page; `note` is
 * the outcome of the last save made from it.
 */
export function SettingsScreen({
  cursor,
  settingsItems,
  providerLabel,
  identity,
  meId,
  autoResume,
  available,
  authStatus,
  config,
  configInEffect,
  note,
}: {
  cursor: number;
  settingsItems: readonly SettingsItem[];
  providerLabel: string;
  identity: Identity;
  meId: string;
  autoResume: boolean;
  available: Set<ProviderName>;
  authStatus: Map<ProviderName, "checking" | boolean>;
  config: Config;
  configInEffect: string;
  note?: { text: string; error?: boolean };
}) {
  const ui: Record<UiItem, Shown> = {
    provider: { text: providerLabel, color: "cyan" },
    identity: { text: `${identity.displayName}${identity.id === meId ? " (you)" : ""}` },
    autoResume: { text: autoResume ? "on" : "off", color: autoResume ? "green" : "gray" },
  };
  const settingValue = (item: SettingsItem): Shown => (isConfigField(item) ? fieldDisplay(item, config) : ui[item]);
  const firstConfig = settingsItems.findIndex(isConfigField);
  const { stdout } = useStdout();
  const room = (stdout?.rows ?? 24) - settingsChrome(PROVIDER_INFO.length, note !== undefined);
  const { start, end } = settingsWindow(cursor, settingsItems.length, room);
  const hidden = hiddenRowsText(start, settingsItems.length - end);
  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      <Text dimColor>{"↑/↓ move · enter change/toggle · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        {settingsItems.slice(start, end).map((item, k) => (
          <Box key={item} flexDirection="column" marginTop={start + k === firstConfig ? 1 : 0}>
            {start + k === firstConfig ? <ConfigSource inEffect={configInEffect} /> : null}
            <SettingRow label={settingLabel(item)} value={settingValue(item)} sel={start + k === cursor} />
          </Box>
        ))}
        {hidden ? <Text dimColor>{hidden}</Text> : null}
        <Text dimColor wrap="truncate">{`  ${padCell("Resource", 28)}${config.resource}  (Azure DevOps' fixed app id, not editable)`}</Text>
      </Box>
      {note ? <Text color={note.error ? "red" : "green"} wrap="truncate">{note.error ? `✗ ${note.text}` : note.text}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        <Text bold color="blue">Authentication</Text>
        {PROVIDER_INFO.map((info) => {
          const installed = available.has(info.name);
          const st = authStatus.get(info.name);
          const detail: { text: string; color: string } = !installed
            ? { text: `${info.cli} not installed — ${info.authHint}`, color: "yellow" }
            : st === undefined || st === "checking"
              ? { text: `${info.cli} installed · checking…`, color: "gray" }
              : st
                ? { text: `${info.cli} installed · authenticated ✓`, color: "green" }
                : { text: `${info.cli} installed · not authenticated ✗ — ${info.authHint}`, color: "red" };
          return (
            <Box key={info.name} marginLeft={2}>
              <Text wrap="truncate">
                <Text bold>{padCell(info.label, 16)}</Text>
                <Text color={detail.color}>{detail.text}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
