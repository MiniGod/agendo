import { Box, Text } from "ink";
import { CaretText } from "../components.tsx";
import { worktreeDirName } from "../../worktree.ts";
import type { AgentSource } from "../../types.ts";
import type { RepoInfo } from "../../repos.ts";
import type { FreshTarget } from "../targets.ts";

/**
 * The name prompt for a fresh session — a new branch when `worktree` is set,
 * otherwise just the session's name. `cloneNote` carries the "✓ cloned …" line
 * through from a clone that just finished.
 */
export function BranchScreen({
  target,
  agent,
  repo,
  value,
  cursor,
  worktree,
  cloneNote,
}: {
  target: FreshTarget;
  agent: AgentSource;
  repo: RepoInfo;
  value: string;
  cursor: number;
  worktree: boolean;
  cloneNote: string | null;
}) {
  const isFree = target.kind === "free";
  // Free sessions get a `cl-new-<id>` name assigned at launch, so we can only
  // preview the prefix; item/PR launches already know their target name.
  const tmuxPreview = isFree ? "cl-new-…" : target.tmuxName;
  const orch = !!target.orchestrator;
  return (
    <Box flexDirection="column">
      <Text bold>
        {orch ? `Orchestrator session in ${repo.name}` : isFree ? `New session in ${repo.name}` : `Fresh session in ${repo.name} — ${target.title.slice(0, 40)}`}
      </Text>
      <Text dimColor>{worktree ? "New branch off origin/HEAD · ←/→ move · ⌃a/⌃e start/end · enter create & launch · esc back" : "Session name · ←/→ move · ⌃a/⌃e start/end · enter launch · esc back"}</Text>
      {cloneNote ? <Text color="green" wrap="truncate">{`✓ ${cloneNote}`}</Text> : null}
      <Box marginTop={1}>
        <Text>{worktree ? "branch: " : "name:   "}</Text>
        <CaretText value={value} cursor={cursor} color="cyan" />
      </Box>
      <Box marginTop={1}>
        {worktree
          ? <Text dimColor>{`→ ${agent}${orch ? " (orchestrator mode)" : ""} · worktree at ${repo.root}/.claude/worktrees/${worktreeDirName(value)}`}</Text>
          : <Text dimColor>{`→ ${agent}${orch ? " (orchestrator mode)" : ""} · runs in ${repo.root}  · tmux ${tmuxPreview}`}</Text>
        }
      </Box>
    </Box>
  );
}
