import { Box, Text } from "ink";
import { V } from "../vocabState.ts";
import type { OpenTargets } from "../targets.ts";

/** The open-in-browser dialog: whichever of the PR / work item carries a URL. */
export function OpenScreen({ targets, title }: { targets: OpenTargets; title: string }) {
  const { pr, workItem } = targets;
  return (
    <Box flexDirection="column">
      <Text bold>{`Open in browser — ${title.slice(0, 54)}`}</Text>
      <Text dimColor>{"Pick what to open · esc/q cancel"}</Text>
      <Box marginTop={1} flexDirection="column">
        {pr ? (
          <Text>
            <Text bold color="magenta">{"  p"}</Text>
            <Text>{`  PR ${V.prPrefix}${pr.id}`}</Text>
          </Text>
        ) : null}
        {workItem ? (
          <Text>
            <Text bold color="cyan">{"  i"}</Text>
            <Text>{`  issue #${workItem.id}`}</Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
