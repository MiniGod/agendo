import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { ACTIVE_NOTICE, boxLabel, isRisky, lossLines } from "../../cleanup/classify.ts";
import { formatSize } from "../../cleanup/sort.ts";
import { BOXES, type Box as CleanupBox, type CleanupRow, type GitState, type Offers, type RowSizes } from "../../cleanup/types.ts";
import { homeShort } from "../format/index.ts";
import type { CleanupDialog } from "../keys/cleanup.ts";
import { gitCells, runCell, type Styled } from "../models/cleanupRow.ts";

export function StyledCells({ cells }: { cells: Styled[] }): ReactElement {
  return (
    <Text>
      {cells.map((c, i) => (
        <Text key={c.text}>
          {i > 0 ? <Text dimColor>{" · "}</Text> : null}
          <Text color={c.color} dimColor={c.dim}>{c.text}</Text>
        </Text>
      ))}
    </Text>
  );
}

/** What each box deletes, as the dialog lists it beside the checkbox. */
function boxDetail(box: CleanupBox, row: CleanupRow, git: GitState | null | undefined, sizes: RowSizes | undefined): string {
  if (box === "worktree") return `${formatSize(sizes?.worktree).padStart(6)}  ${row.worktree ? homeShort(row.worktree) : ""}`;
  if (box === "branch") return `${"".padStart(6)}  ${git?.branch ?? row.branchHint ?? ""}`;
  return formatSize(sizes?.[box]).padStart(6);
}

function BoxLine({ box, on, focused, offer, detail }: { box: CleanupBox; on: boolean; focused: boolean; offer: Offers[CleanupBox]; detail: string }) {
  const label = `${focused ? "▸" : " "} [${on ? "x" : " "}] ${boxLabel(box).padEnd(20)}`;
  return (
    <Text wrap="truncate">
      <Text color={focused ? "cyan" : undefined} dimColor={!offer.enabled}>{label}</Text>
      <Text dimColor>{offer.enabled ? detail : `  — ${offer.reason}`}</Text>
    </Text>
  );
}

/** The prominent warning: what removing the checkout and branch would lose. */
function LossWarning({ git, offers }: { git: GitState | null | undefined; offers: Offers }) {
  if (!git || !isRisky(git) || !(offers.worktree.enabled || offers.branch.enabled)) return null;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="red">{"⚠ Removing the worktree or branch would lose:"}</Text>
      {lossLines(git).map((l) => (
        <Text key={l} color="red">{`   • ${l}`}</Text>
      ))}
    </Box>
  );
}

function RunningNotice({ row }: { row: CleanupRow }) {
  if (row.run !== "running") return null;
  return (
    <Box marginTop={1}>
      <Text bold color="yellow">
        {"⚠ This session is running. Pause or kill it first; its worktree, branch, transcript and tmp files can't be removed while it runs."}
      </Text>
    </Box>
  );
}

function ActiveNotice({ row }: { row: CleanupRow }) {
  if (!row.active) return null;
  return (
    <Box marginTop={1}>
      <Text bold color="yellow">{`⚠ ${ACTIVE_NOTICE}. Anything you delete needs a second confirmation.`}</Text>
    </Box>
  );
}

function Header({ row, git }: { row: CleanupRow; git: GitState | null | undefined }) {
  const run = runCell(row.run, !!row.session);
  const branch = git?.branch ?? row.branchHint;
  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate">{`Clean up — ${row.title}`}</Text>
      <Text wrap="truncate">
        <Text color={run.color} dimColor={run.dim}>{run.text}</Text>
        <Text dimColor>{`  ${homeShort(row.path)}${branch ? `  [${branch}]` : ""}`}</Text>
      </Text>
      <StyledCells cells={gitCells(git)} />
    </Box>
  );
}

function EditView({ d, row, git, offers, sizes }: DialogProps) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginTop={1}>
        {BOXES.map((b, i) => (
          <BoxLine key={b} box={b} on={d.sel[b]} focused={d.cursor === i} offer={offers[b]} detail={boxDetail(b, row, git, sizes)} />
        ))}
      </Box>
      <LossWarning git={git} offers={offers} />
      <RunningNotice row={row} />
      <ActiveNotice row={row} />
      {d.note ? <Text color="yellow">{d.note}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>{"↑/↓ move · space toggle · enter delete selected · esc back"}</Text>
      </Box>
    </Box>
  );
}

function ConfirmView({ d }: DialogProps) {
  const picked = BOXES.filter((b) => d.sel[b]).map(boxLabel).join(", ");
  const lines = [...(d.sel.worktree || d.sel.branch ? lossLines(d.git) : []), ...(d.activeShown ? [ACTIVE_NOTICE] : [])];
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="red">{"Really delete? This cannot be undone, and loses:"}</Text>
      {lines.map((l) => (
        <Text key={l} color="red">{`   • ${l}`}</Text>
      ))}
      <Text>{`Deleting: ${picked}`}</Text>
      {d.note ? <Text color="yellow">{d.note}</Text> : null}
      <Box marginTop={1}>
        <Text bold>{"Press y to delete anyway · any other key goes back"}</Text>
      </Box>
    </Box>
  );
}

function DoneView({ d }: { d: CleanupDialog }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{"Cleanup finished:"}</Text>
      {d.results.map((r) => (
        <Text key={r.text} color={r.ok ? "green" : "red"} wrap="truncate">{`  ${r.ok ? "✓" : "✗"} ${r.text}`}</Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>{"press any key to return to the list"}</Text>
      </Box>
    </Box>
  );
}

interface DialogProps {
  d: CleanupDialog;
  row: CleanupRow;
  git: GitState | null | undefined;
  offers: Offers;
  sizes: RowSizes | undefined;
}

const STAGES: Record<CleanupDialog["stage"], (p: DialogProps) => ReactElement> = {
  edit: EditView,
  confirm: ConfirmView,
  running: () => (
    <Box marginTop={1}>
      <Text><Text color="cyan">⟳</Text>{" Cleaning up…"}</Text>
    </Box>
  ),
  done: DoneView,
};

/** The per-row dialog: the four checkboxes, the warning, the second confirmation and the result summary. */
export function CleanupDialogView(p: DialogProps): ReactElement {
  const Stage = STAGES[p.d.stage];
  return (
    <Box flexDirection="column">
      <Header row={p.row} git={p.git} />
      <Stage {...p} />
    </Box>
  );
}
