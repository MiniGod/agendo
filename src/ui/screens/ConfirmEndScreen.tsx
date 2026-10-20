import { Box, Text } from "ink";

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
