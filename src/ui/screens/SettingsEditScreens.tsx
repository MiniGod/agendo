import { Box, Text } from "ink";
import { CaretText } from "../components/index.tsx";
import { FIELD_SPECS, type TextField } from "../models/configFields.ts";

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

/**
 * The team picker: the signed-in user's own teams in the configured project,
 * the current one marked, then a row for typing a name — the way on when the
 * list is loading, empty, or couldn't be fetched.
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
  return (
    <Box flexDirection="column">
      <Text bold>{`Settings › Team — your teams in ${project || "(no project set)"}`}</Text>
      <Text dimColor>{"↑/↓ move · enter select · esc back"}</Text>
      <Box marginTop={1} flexDirection="column">
        {teams === null ? <Text color="gray">{"  ⟳ loading your teams…"}</Text> : null}
        {teams !== null && rows.length === 0 && !error ? <Text color="yellow">{"  you're in no team of this project"}</Text> : null}
        {rows.map((t, i) => {
          const sel = i === cursor;
          return (
            <Text key={t} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined} wrap="truncate">
              {sel ? "❯ " : "  "}
              <Text color={sel ? "black" : isCur(t) ? "green" : "gray"}>{isCur(t) ? "● " : "○ "}</Text>
              <Text bold>{t}</Text>
            </Text>
          );
        })}
        <Text color={cursor === rows.length ? "black" : undefined} backgroundColor={cursor === rows.length ? "cyan" : undefined}>
          {cursor === rows.length ? "❯ " : "  "}
          {"✎ type a team name…"}
        </Text>
      </Box>
      {error ? <Text color="red" wrap="truncate">{`✗ ${error}`}</Text> : null}
    </Box>
  );
}
