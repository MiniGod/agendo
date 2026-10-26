import { Box, Text, useStdout } from "ink";
import { CaretText } from "../components/index.tsx";
import { FIELD_SPECS, type TextField } from "../models/configFields.ts";
import { hiddenRowsText, settingsWindow } from "./SettingsScreen.tsx";

/** The line editor for one config.json value: what it means, the input, and why the last enter didn't save. */
export function SettingsEditScreen({ field, value, cursor, error }: { field: TextField; value: string; cursor: number; error?: string }) {
  const spec = FIELD_SPECS[field];
  return (
    <Box flexDirection="column">
      <Text bold>{`Settings › ${spec.label}`}</Text>
      <Text dimColor>{"←/→ move · ⌃a/⌃e start/end · ⌃u clear · enter save · esc back"}</Text>
      <Box marginTop={1}>
        <Text>{`${spec.label}: `}</Text>
        <CaretText value={value} cursor={cursor} color="cyan" />
      </Box>
      <Text dimColor wrap="truncate">{spec.hint}</Text>
      {error ? <Text color="red" wrap="truncate">{`✗ ${error}`}</Text> : null}
    </Box>
  );
}

function TeamRow({ team, sel, current }: { team: string; sel: boolean; current: boolean }) {
  return (
    <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined} wrap="truncate">
      {sel ? "❯ " : "  "}
      <Text color={sel ? "black" : current ? "green" : "gray"}>{current ? "● " : "○ "}</Text>
      <Text bold>{team}</Text>
    </Text>
  );
}

function TypeNameRow({ sel }: { sel: boolean }) {
  return (
    <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
      {sel ? "❯ " : "  "}
      {"✎ type a team name…"}
    </Text>
  );
}

/** What stands in for the list while there is none: loading, or no team at all (unless the error says why). */
function TeamListState({ teams, error }: { teams: string[] | null; error?: string }) {
  if (teams === null) return <Text color="gray">{"  ⟳ loading your teams…"}</Text>;
  if (teams.length === 0 && !error) return <Text color="yellow">{"  you're in no team of this project"}</Text>;
  return null;
}

/**
 * The team picker: the signed-in user's own teams in the configured project,
 * the current one marked, then a row for typing a name — the way on when the
 * list is loading, empty, or couldn't be fetched. A list longer than the
 * terminal is windowed around the cursor, as on the Settings page.
 */
export function TeamPickerScreen({
  cursor,
  teams,
  current,
  project,
  error,
}: {
  cursor: number;
  teams: string[] | null;
  current: string;
  project: string;
  error?: string;
}) {
  const rows = teams ?? [];
  const isCur = (t: string) => t.toLowerCase() === current.trim().toLowerCase();
  const { stdout } = useStdout();
  // Title, hint, the gap, the loading/empty line, the error, and Ink's last line.
  const { start, end } = settingsWindow(cursor, rows.length + 1, (stdout?.rows ?? 24) - 6);
  const hidden = hiddenRowsText(start, rows.length + 1 - end);
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">{`Settings › Team — your teams in ${project || "(no project set)"}`}</Text>
      <Text dimColor>{"↑/↓ move · enter select · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        <TeamListState teams={teams} error={error} />
        {rows.slice(start, end).map((t, k) => (
          <TeamRow key={t} team={t} sel={start + k === cursor} current={isCur(t)} />
        ))}
        {end > rows.length ? <TypeNameRow sel={cursor === rows.length} /> : null}
        {hidden ? <Text dimColor>{hidden}</Text> : null}
      </Box>
      {error ? <Text color="red" wrap="truncate">{`✗ ${error}`}</Text> : null}
    </Box>
  );
}
