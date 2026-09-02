import { Box, Text } from "ink";
import { homeShort, padCell, repoBreakdown } from "../format.ts";
import { CLONE_ROW, INIT_ROW } from "../keys/repo.ts";
import type { FreshTarget } from "../targets.ts";
import type { RepoInfo } from "../../repos.ts";

/**
 * The repo picker for a fresh session. `repoChoices` is what `reposForTarget`
 * answered for this target (the ranking differs by target kind, so it is decided
 * in App and passed in); `anyHostableRepo` is whether ANY offered repo can host
 * a worktree, and `canClone` whether the clone row is on offer at all.
 */
export function RepoScreen({
  target,
  cursor,
  repoChoices,
  anyHostableRepo,
  canClone,
  filterRoot,
}: {
  target: FreshTarget;
  cursor: number;
  repoChoices: RepoInfo[];
  anyHostableRepo: boolean;
  canClone: boolean;
  filterRoot: string | null;
}) {
  const isFree = target.kind === "free";
  const orch = !!target.orchestrator;
  // Work-item / PR flows MUST create a worktree, so a list with no git checkout
  // in it can only ever produce "fatal: not a git repository" — the bootstrap
  // case, where the only offer is the launcher's own non-repo cwd. Say what
  // would actually unblock it instead of letting enter dead-end. A plain free
  // session is exempt: running in place is a legitimate outcome there (see
  // wtchoice). An ORCHESTRATOR is not exempt, even though it is a free target —
  // it integrates by merging branches, which a non-repo folder cannot do, so
  // for it "run in place here" is just as dead an end as for a work item.
  const noCheckout = (!isFree || orch) && !anyHostableRepo;
  return (
    <Box flexDirection="column">
      <Text bold>
        {orch ? `Orchestrator session — pick a repo` : isFree ? `New session — pick a repo` : `Fresh session — ${target.title.slice(0, 54)}`}
      </Text>
      <Text dimColor>
        {`Pick a repo${isFree ? "" : " to create the worktree in"}  ·  ↑/↓ move · enter select · esc back${canClone ? " · c clone" : ""} · i new repo`}
      </Text>
      {orch ? (
        <Text color="magenta">{"It will delegate every unit of work to background sessions — it writes no code itself."}</Text>
      ) : null}
      {noCheckout ? (
        <Text color="yellow">
          {canClone
            ? "No git checkout here — press c to clone one, i to create one, or run `agendo <dir>` pointing at a repo."
            : "No git checkout here — press i to create one, or run `agendo <dir>` pointing at a repo (or quit with q, cd into one, rerun)."}
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {repoChoices.map((r, i) => {
          const sel = i === cursor;
          return (
            <Text key={r.root} color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
              {sel ? "❯ " : "  "}
              <Text bold>{padCell(r.name, 22)}</Text>
              {r.total === 0 ? (
                <Text color={sel ? "black" : "gray"}>{`  (no sessions yet)         `}</Text>
              ) : (
                <>
                  <Text color={sel ? "black" : "green"}>{` ${String(r.total).padStart(3)} sessions`}</Text>
                  <Text color={sel ? "black" : "gray"}>{` (${repoBreakdown(r)})`}</Text>
                </>
              )}
              <Text dimColor={!sel}>{`  ${r.root}`}</Text>
            </Text>
          );
        })}
        {canClone ? (
          <Text
            color={cursor === CLONE_ROW ? "black" : undefined}
            backgroundColor={cursor === CLONE_ROW ? "cyan" : undefined}
          >
            {cursor === CLONE_ROW ? "❯ " : "  "}
            <Text bold>{padCell("＋ Clone from URL…", 22)}</Text>
            <Text dimColor={cursor !== CLONE_ROW}>{`  clone into ${homeShort(filterRoot!)}`}</Text>
          </Text>
        ) : null}
        <Text
          color={cursor === INIT_ROW ? "black" : undefined}
          backgroundColor={cursor === INIT_ROW ? "cyan" : undefined}
        >
          {cursor === INIT_ROW ? "❯ " : "  "}
          <Text bold>{padCell("＋ New local repo…", 22)}</Text>
          <Text dimColor={cursor !== INIT_ROW}>{"  git init a fresh repo where you say"}</Text>
        </Text>
      </Box>
    </Box>
  );
}
