import { Box, Text } from "ink";
import { homeShort } from "../format.ts";
import { repoUrlLabel, type RepoUrl } from "../../clone.ts";

/** The live `git clone`: what is being cloned, where to, and its progress. */
export function CloningScreen({
  url,
  dest,
  progress,
  elapsed,
}: {
  url: RepoUrl;
  dest: string;
  progress: string;
  elapsed: number;
}) {
  return (
    <Box flexDirection="column">
      <Text bold>
        <Text color="cyan">⟳</Text>
        {` Cloning ${repoUrlLabel(url)}  `}
        <Text dimColor>{`(${elapsed}s)`}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor wrap="truncate">{`  from  ${url.displayRemote}`}</Text>
        <Text dimColor wrap="truncate">{`  into  ${homeShort(dest)}`}</Text>
        <Text wrap="truncate">{`  ${progress}`}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>{"  esc cancels (the partial clone is removed)"}</Text>
      </Box>
    </Box>
  );
}
