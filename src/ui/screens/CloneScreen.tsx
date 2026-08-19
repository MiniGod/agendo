import { Box, Text } from "ink";
import { repoUrlLabel, type RepoUrl } from "../../clone.ts";
import { homeShort } from "../format.ts";

/**
 * The clone-URL prompt. `cloneUrl` is what the typed text parses to and
 * `resolved` where it would land — both computed in App (parsing is memoized
 * there, resolution is an effect that reads the filesystem), so this screen only
 * turns them into the preview line.
 */
export function CloneScreen({
  value,
  cursor,
  error,
  cloneUrl,
  resolved,
  filterRoot,
}: {
  value: string;
  cursor: number;
  error?: string[];
  cloneUrl: RepoUrl | null;
  resolved: { key: string; match: string | null; dest: string | null } | null;
  filterRoot: string | null;
}) {
  // Live read of what's typed so far (see `cloneUrl` / `cloneDest`): the exact
  // directory that will be created is on screen *before* enter, so no clone is
  // ever a surprise. An existing checkout of the same repo is reported here
  // too — the reuse then reads as expected rather than as a clone that
  // silently didn't happen.
  const preview: { text: string; color: string } = cloneUrl
    ? !resolved
      ? { text: `→ ${repoUrlLabel(cloneUrl)}  ·  …`, color: "gray" }
      : resolved.match
        ? { text: `→ ${repoUrlLabel(cloneUrl)}  ·  already cloned at ${homeShort(resolved.match)}`, color: "green" }
        : resolved.dest
          ? { text: `→ ${repoUrlLabel(cloneUrl)}  ·  clones into ${homeShort(resolved.dest)}`, color: "cyan" }
          : { text: `→ ${repoUrlLabel(cloneUrl)}  ·  no free directory name in ${homeShort(filterRoot!)}`, color: "yellow" }
    : value.trim()
      ? { text: "not a recognizable GitHub or Azure DevOps repo URL", color: "yellow" }
      : { text: "e.g. https://github.com/owner/repo · https://dev.azure.com/org/proj/_git/repo", color: "gray" };
  return (
    <Box flexDirection="column">
      <Text bold>{`Clone a repo into ${homeShort(filterRoot!)}`}</Text>
      <Text dimColor>{"Paste a GitHub or Azure DevOps repo URL  ·  enter clone · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          {"  "}
          <Text>{value.slice(0, cursor)}</Text>
          <Text inverse>{value[cursor] ?? " "}</Text>
          <Text>{value.slice(cursor + 1)}</Text>
        </Text>
        <Text color={preview.color}>{`  ${preview.text}`}</Text>
        {(error ?? []).map((line, i) => (
          <Text key={i} color="red">{`  ${line}`}</Text>
        ))}
      </Box>
    </Box>
  );
}
