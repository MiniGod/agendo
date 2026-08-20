import { Box, Text } from "ink";
import { PROVIDER_INFO } from "../../provider.ts";
import type { ProviderName } from "../../types.ts";
import { padCell } from "../format.ts";

/**
 * The backend picker. `provider` is the one in force (marked ●) and `available`
 * the set whose CLI was found at mount — a missing CLI is still listed, with the
 * hint for installing it, rather than hidden.
 */
export function ProviderScreen({
  cursor,
  provider,
  available,
}: {
  cursor: number;
  provider: ProviderName;
  available: Set<ProviderName>;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>Switch backend</Text>
      <Text dimColor>
        {"Everything reloads from the selected backend  ·  ↑/↓ move · enter select · esc back"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {PROVIDER_INFO.map((info, i) => {
          const sel = i === cursor;
          const isCur = info.name === provider;
          const ok = available.has(info.name);
          return (
            <Text key={info.name} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text color={sel ? "black" : isCur ? "green" : "gray"}>{isCur ? "● " : "○ "}</Text>
              <Text bold color={sel ? "black" : ok ? undefined : "gray"}>{padCell(info.label, 16)}</Text>
              {ok ? (
                <Text dimColor={!sel}>{`  via ${info.cli}`}</Text>
              ) : (
                <Text color={sel ? "black" : "yellow"}>{`  ${info.cli} not installed — ${info.authHint}`}</Text>
              )}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
