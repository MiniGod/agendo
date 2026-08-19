import { Box, Text } from "ink";
import { AGENT_CHOICES } from "../keys/agent.ts";
import type { FreshTarget } from "../targets.ts";

/**
 * The agent picker for a fresh session: which CLI should run it. `target` is the
 * work item / PR / free target the session is being started for, `cursor` the
 * highlighted row in AGENT_CHOICES (the same array the key handler walks).
 */
export function AgentScreen({ target, cursor }: { target: FreshTarget; cursor: number }) {
  const isFree = target.kind === "free";
  return (
    <Box flexDirection="column">
      <Text bold>{isFree ? `New session — pick an agent` : `Fresh session — ${target.title.slice(0, 54)}`}</Text>
      <Text dimColor>{`Which agent should run this session?  ·  ↑/↓ move · enter select · esc back`}</Text>
      <Box marginTop={1} flexDirection="column">
        {AGENT_CHOICES.map((a, i) => {
          const sel = i === cursor;
          return (
            <Text key={a.source} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text bold>{a.label.padEnd(10).slice(0, 10)}</Text>
              <Text dimColor={!sel}>{`  ${a.desc}`}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
