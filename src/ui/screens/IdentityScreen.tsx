import { Box, Text } from "ink";
import type { Identity, TeamMember } from "../../types.ts";

/**
 * The identity switcher. `identity` is the override picked in a previous visit
 * (null = whoever the backend authenticated as), `me` that authenticated user —
 * together they decide which row reads as current and which is marked "(you)".
 */
export function IdentityScreen({
  cursor,
  identity,
  me,
  roster,
}: {
  cursor: number;
  identity: Identity | null;
  me: Identity;
  roster: TeamMember[];
}) {
  const curId = (identity ?? me).id;
  return (
    <Box flexDirection="column">
      <Text bold>Switch who you are</Text>
      <Text dimColor>
        {"Work items & PRs reload for the selected person  ·  ↑/↓ move · enter select · esc back"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {roster.map((m, i) => {
          const sel = i === cursor;
          const isCur = m.id === curId;
          const isMe = m.id === me.id;
          return (
            <Text key={m.id} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text color={sel ? "black" : isCur ? "green" : "gray"}>{isCur ? "● " : "○ "}</Text>
              <Text bold>{m.displayName.padEnd(28).slice(0, 28)}</Text>
              {isMe ? <Text color={sel ? "black" : "magenta"}>{" (you)"}</Text> : null}
              <Text dimColor={!sel}>{`  ${m.uniqueName}`}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
