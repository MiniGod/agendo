import { Box, Text } from "ink";
import type { RepoInfo } from "../../repos.ts";
import type { FreshTarget } from "../targets.ts";

/**
 * Where a fresh session should run in the chosen repo: a new worktree, or the
 * main checkout. `cloneNote` carries the "✓ cloned …" line through from a clone
 * that just finished, so the flow it feeds into confirms it happened.
 */
export function WtChoiceScreen({
  target,
  repo,
  cursor,
  cloneNote,
}: {
  target: FreshTarget;
  repo: RepoInfo;
  cursor: number;
  cloneNote: string | null;
}) {
  const opts = ["New git worktree", "Main repo checkout"];
  const descs = [
    `branch + worktree under ${repo.root}/.claude/worktrees/`,
    `runs directly in ${repo.root}`,
  ];
  return (
    <Box flexDirection="column">
      <Text bold>{`${target.orchestrator ? "Orchestrator" : "New"} session in ${repo.name} — choose where to run`}</Text>
      <Text dimColor>{"↑/↓ move · enter select · esc back"}</Text>
      {cloneNote ? <Text color="green" wrap="truncate">{`✓ ${cloneNote}`}</Text> : null}
      {target.orchestrator ? (
        <Text color="magenta">
          {"An orchestrator squash-merges finished branches into the main branch, and git keeps that"}
        </Text>
      ) : null}
      {target.orchestrator ? (
        <Text color="magenta">{"branch in one working tree only — so the main checkout is the right home for it."}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {opts.map((label, i) => {
          const sel = i === cursor;
          return (
            <Text key={label} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text bold>{label.padEnd(22).slice(0, 22)}</Text>
              <Text dimColor={!sel}>{`  ${descs[i]}`}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}
