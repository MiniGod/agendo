import { Box, Text } from "ink";
import { homeShort, padCell } from "../format.ts";
import type { ProfileChoice } from "../../profiles.ts";

/**
 * "Move this session to another Claude profile". `choices` is every discovered
 * profile with the session's own flagged — shown for orientation but skipped by
 * the cursor, since moving somewhere you already are is not a choice.
 */
export function ProfileScreen({
  title,
  choices,
  cursor,
}: {
  title: string;
  choices: ProfileChoice[];
  cursor: number;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>{`Move to another Claude profile — ${title.slice(0, 44)}`}</Text>
      <Text dimColor>
        {"Relocates the transcript + its sidecar files  ·  ↑/↓ move · enter move · esc cancel"}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {choices.map((c, i) => {
          const sel = i === cursor;
          return (
            <Text key={c.profile.configDir} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text color={sel ? "black" : c.current ? "green" : "gray"}>{c.current ? "● " : "○ "}</Text>
              <Text bold color={sel ? "black" : c.current ? "gray" : undefined}>{padCell(c.profile.name, 18)}</Text>
              <Text color={sel ? "black" : c.current ? "gray" : "cyan"}>{c.current ? "lives here now" : "move here     "}</Text>
              <Text dimColor={!sel}>{`  ${homeShort(c.profile.projects)}`}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
