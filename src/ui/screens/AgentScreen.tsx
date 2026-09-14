import { Box, Text } from "ink";
import { agentChoicesFor } from "../keys/agent.ts";
import type { FreshTarget } from "../models/targets.ts";
import { padCell } from "../format/index.ts";

/** The title line: which flow this picker serves — mirrors `repoHeading`. */
function agentHeading(target: FreshTarget): string {
  if (target.orchestrator) return "Orchestrator session — pick an agent";
  return target.kind === "free" ? "New session — pick an agent" : `Fresh session — ${target.title.slice(0, 54)}`;
}

/**
 * The agent picker for a fresh session: which CLI should run it. `target` is the
 * work item / PR / free target the session is being started for, `cursor` the
 * highlighted row in `agentChoicesFor(target)` (the same array the key handler walks;
 * an orchestrator target excludes Copilot, which can't carry the instructions).
 */
export function AgentScreen({ target, cursor }: { target: FreshTarget; cursor: number }) {
  const choices = agentChoicesFor(target);
  return (
    <Box flexDirection="column">
      <Text bold>{agentHeading(target)}</Text>
      <Text dimColor>{`Which agent should run this session?  ·  ↑/↓ move · enter select · esc back`}</Text>
      <Box marginTop={1} flexDirection="column">
        {choices.map((a, i) => {
          const sel = i === cursor;
          return (
            <Text key={a.source} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text bold>{padCell(a.label, 10)}</Text>
              <Text dimColor={!sel}>{`  ${a.desc}`}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
