import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { homeShort, padCell, repoBreakdown } from "../format.ts";
import { CLONE_ROW, INIT_ROW } from "../keys/repo.ts";
import type { FreshTarget } from "../targets.ts";
import type { RepoInfo } from "../../repos.ts";

/** The title line: which flow this picker serves. */
export function repoHeading(target: FreshTarget): string {
  if (target.orchestrator) return "Orchestrator session — pick a repo";
  return target.kind === "free" ? "New session — pick a repo" : `Fresh session — ${target.title.slice(0, 54)}`;
}

/** The key hint under the title; the clone key only when the clone row is on offer. */
export function repoHint(isFree: boolean, canClone: boolean): string {
  return `Pick a repo${isFree ? "" : " to create the worktree in"}  ·  ↑/↓ move · enter select · esc back${canClone ? " · c clone" : ""} · i new repo`;
}

/**
 * Work-item / PR flows MUST create a worktree, so a list with no git checkout
 * in it can only ever produce "fatal: not a git repository" — the bootstrap
 * case, where the only offer is the launcher's own non-repo cwd. Say what
 * would actually unblock it instead of letting enter dead-end. A plain free
 * session is exempt: running in place is a legitimate outcome there (see
 * wtchoice). An ORCHESTRATOR is not exempt, even though it is a free target —
 * it integrates by merging branches, which a non-repo folder cannot do, so
 * for it "run in place here" is just as dead an end as for a work item.
 */
export function noCheckoutNote(target: FreshTarget, anyHostableRepo: boolean, canClone: boolean): string | null {
  if (anyHostableRepo || (target.kind === "free" && !target.orchestrator)) return null;
  return canClone
    ? "No git checkout here — press c to clone one, i to create one, or run `agendo <dir>` pointing at a repo."
    : "No git checkout here — press i to create one, or run `agendo <dir>` pointing at a repo (or quit with q, cd into one, rerun).";
}

/** One picker row: inverted with a caret when the cursor is on it. */
function Selectable({ sel, children }: { sel: boolean; children: ReactNode }) {
  return (
    <Text color={sel ? "black" : undefined} backgroundColor={sel ? "cyan" : undefined}>
      {sel ? "❯ " : "  "}
      {children}
    </Text>
  );
}

function RepoRow({ repo, sel }: { repo: RepoInfo; sel: boolean }) {
  return (
    <Selectable sel={sel}>
      <Text bold>{padCell(repo.name, 22)}</Text>
      {repo.total === 0 ? (
        <Text color={sel ? "black" : "gray"}>{`  (no sessions yet)         `}</Text>
      ) : (
        <>
          <Text color={sel ? "black" : "green"}>{` ${String(repo.total).padStart(3)} sessions`}</Text>
          <Text color={sel ? "black" : "gray"}>{` (${repoBreakdown(repo)})`}</Text>
        </>
      )}
      <Text dimColor={!sel}>{`  ${repo.root}`}</Text>
    </Selectable>
  );
}

function CloneRow({ sel, filterRoot }: { sel: boolean; filterRoot: string }) {
  return (
    <Selectable sel={sel}>
      <Text bold>{padCell("＋ Clone from URL…", 22)}</Text>
      <Text dimColor={!sel}>{`  clone into ${homeShort(filterRoot)}`}</Text>
    </Selectable>
  );
}

function InitRow({ sel }: { sel: boolean }) {
  return (
    <Selectable sel={sel}>
      <Text bold>{padCell("＋ New local repo…", 22)}</Text>
      <Text dimColor={!sel}>{"  git init a fresh repo where you say"}</Text>
    </Selectable>
  );
}

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
  const note = noCheckoutNote(target, anyHostableRepo, canClone);
  return (
    <Box flexDirection="column">
      <Text bold>{repoHeading(target)}</Text>
      <Text dimColor>{repoHint(target.kind === "free", canClone)}</Text>
      {target.orchestrator ? (
        <Text color="magenta">{"It will delegate every unit of work to background sessions — it writes no code itself."}</Text>
      ) : null}
      {note ? <Text color="yellow">{note}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {repoChoices.map((r, i) => <RepoRow key={r.root} repo={r} sel={i === cursor} />)}
        {canClone ? <CloneRow sel={cursor === CLONE_ROW} filterRoot={filterRoot!} /> : null}
        <InitRow sel={cursor === INIT_ROW} />
      </Box>
    </Box>
  );
}
