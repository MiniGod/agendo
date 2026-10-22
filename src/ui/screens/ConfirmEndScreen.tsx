import { Box, Text } from "ink";
import type { Skipped } from "../actions/staleKill.ts";

/** The y/n the list's `x` / `X` ask before ending a session; `prompt` says what is in flight. */
export function ConfirmEndScreen({ title, prompt, force }: { title: string; prompt: string; force: boolean }) {
  return (
    <Box flexDirection="column">
      <Text bold>{`${force ? "Force kill" : "Kill"} session — ${title.slice(0, 54)}`}</Text>
      <Box marginTop={1}>
        <Text color={force ? "red" : "yellow"}>{`${prompt} y/n`}</Text>
      </Box>
      <Text dimColor>{"Ends its tmux window only — worktree, branch and transcript are kept."}</Text>
      <Text dimColor>{"y kill · n/esc cancel"}</Text>
    </Box>
  );
}

/** The y/n the Sessions view's `K` asks: which extra orchestrators it kills, and which it skips and why. */
export function ConfirmStaleScreen({ prompt, skipped, lookAlikes }: { prompt: string; skipped: readonly Skipped[]; lookAlikes: boolean }) {
  return (
    <Box flexDirection="column">
      <Text bold>
        {lookAlikes
          ? "Kill orchestrator look-alikes — none of them was ever recorded as this repo's orchestrator"
          : "Kill extra orchestrators — the one O/G opens is not among them"}
      </Text>
      <Box marginTop={1}>
        <Text color="yellow">{`${prompt} y/n`}</Text>
      </Box>
      {skipped.map((s) => (
        <Text key={s.id} dimColor>{`Skipped: ${s.why}`}</Text>
      ))}
      <Text dimColor>{"Ends their tmux windows only — worktrees, branches and transcripts are kept."}</Text>
      <Text dimColor>{"y kill · n/esc cancel"}</Text>
    </Box>
  );
}
