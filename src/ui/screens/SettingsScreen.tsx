import { Box, Text } from "ink";
import { PROVIDER_INFO } from "../../provider.ts";
import type { Identity, ProviderName } from "../../types.ts";

/**
 * The Settings page: the actionable rows on top (in `settingsItems` order, the
 * same array the key handler walks), then a read-only report of every backend's
 * CLI + auth state. `authStatus` is the probe that runs on entering the page.
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
}: {
  cursor: number;
  settingsItems: Array<"provider" | "identity" | "autoResume">;
  providerLabel: string;
  identity: Identity;
  meId: string;
  autoResume: boolean;
  available: Set<ProviderName>;
  authStatus: Map<ProviderName, "checking" | boolean>;
}) {
  const settingValue = (item: "provider" | "identity" | "autoResume"): { text: string; color?: string } =>
    item === "provider"
      ? { text: providerLabel, color: "cyan" }
      : item === "identity"
        ? { text: `${identity.displayName}${identity.id === meId ? " (you)" : ""}` }
        : { text: autoResume ? "on" : "off", color: autoResume ? "green" : "gray" };
  const settingLabel = (item: "provider" | "identity" | "autoResume") =>
    item === "provider" ? "Backend" : item === "identity" ? "Viewing as" : "Auto-resume on usage limit";
  return (
    <Box flexDirection="column">
      <Text bold>Settings</Text>
      <Text dimColor>{"↑/↓ move · enter change/toggle · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        {settingsItems.map((item, i) => {
          const sel = i === cursor;
          const v = settingValue(item);
          return (
            <Text key={item} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text bold>{settingLabel(item).padEnd(28).slice(0, 28)}</Text>
              <Text color={sel ? "black" : v.color}>{v.text}</Text>
            </Text>
          );
        })}
      </Box>
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
                <Text bold>{info.label.padEnd(16).slice(0, 16)}</Text>
                <Text color={detail.color}>{detail.text}</Text>
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
