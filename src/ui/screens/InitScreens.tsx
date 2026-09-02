import { Box, Text } from "ink";
import { homedir } from "os";
import { join } from "path";
import { CaretText } from "../components.tsx";
import { resolveParentInput } from "../../initRepo.ts";
import { homeShort } from "../format.ts";

/** The three screens of the new-local-repo flow (docs/new-local-repo.md). */

/** Step 1: the folder name. */
export function InitNameScreen({ value, cursor, error }: { value: string; cursor: number; error?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold>{"New local repo — name"}</Text>
      <Text dimColor>{"Folder name for the new repo  ·  enter next · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          {"name: "}
          <CaretText value={value} cursor={cursor} color="cyan" />
        </Text>
        {value.trim()
          ? <Text dimColor>{`  → git init a new repo in a folder named ${value.trim()} — next: where to put it`}</Text>
          : <Text color="gray">{"  e.g. my-project"}</Text>}
        {error ? <Text color="red">{`  ${error}`}</Text> : null}
      </Box>
    </Box>
  );
}

/** The refusal / offer lines shared by both parent-folder screens. */
function ParentNotes({ error, existing }: { error?: string; existing?: string }) {
  return (
    <>
      {error ? <Text color="red">{`  ${error}`}</Text> : null}
      {existing ? (
        <Text color="yellow">{`  ${homeShort(existing)} is already a git repo — enter again to use it as-is, esc back`}</Text>
      ) : null}
    </>
  );
}

/**
 * Step 2: where it goes. `candidates` are the parent folders of the checkouts
 * agendo knows about, most common first; the last row is the way to type any
 * other absolute path. Each row shows the exact folder the enter key would
 * create, parent bold and the name dim, so nothing lands anywhere unannounced.
 */
export function InitDirScreen({
  name,
  candidates,
  cursor,
  error,
  existing,
}: {
  name: string;
  candidates: string[];
  cursor: number;
  error?: string;
  existing?: string;
}) {
  const otherRow = candidates.length;
  return (
    <Box flexDirection="column">
      <Text bold>{`New local repo — where should ${name} go?`}</Text>
      <Text dimColor>{"Parent folders of the repos you already have  ·  ↑/↓ move · enter create · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        {candidates.map((p, i) => {
          const sel = i === cursor;
          return (
            <Text key={p} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined} wrap="truncate">
              {sel ? "❯ " : "  "}
              <Text bold>{`${p}/`}</Text>
              <Text dimColor={!sel}>{name}</Text>
            </Text>
          );
        })}
        <Text color={cursor === otherRow ? "black" : undefined} backgroundColor={cursor === otherRow ? "cyan" : undefined}>
          {cursor === otherRow ? "❯ " : "  "}
          <Text bold>{"＋ Other path…"}</Text>
          <Text dimColor={cursor !== otherRow}>{"  type an absolute path (~/… works)"}</Text>
        </Text>
        <ParentNotes error={error} existing={existing} />
      </Box>
    </Box>
  );
}

/** Step 2, free-text form: any absolute path (or `~/…`) as the parent. */
export function InitPathScreen({
  name,
  value,
  cursor,
  error,
  existing,
}: {
  name: string;
  value: string;
  cursor: number;
  error?: string;
  existing?: string;
}) {
  const parent = resolveParentInput(value, homedir());
  const preview: { text: string; color: string } = parent
    ? { text: `→ creates ${join(parent, name)}`, color: "cyan" }
    : value.trim()
      ? { text: "not an absolute path — start with / or ~/", color: "yellow" }
      : { text: "e.g. ~/git or /srv/repos", color: "gray" };
  return (
    <Box flexDirection="column">
      <Text bold>{`New local repo — parent folder for ${name}`}</Text>
      <Text dimColor>{"Absolute path, ~/… works  ·  enter create · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          {"path: "}
          <CaretText value={value} cursor={cursor} color="cyan" />
        </Text>
        <Text color={preview.color} wrap="truncate">{`  ${preview.text}`}</Text>
        <ParentNotes error={error} existing={existing} />
      </Box>
    </Box>
  );
}
