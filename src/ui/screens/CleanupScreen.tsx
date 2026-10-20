import { Box, Text, useInput, useStdout } from "ink";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import { offersFor } from "../../cleanup/classify.ts";
import { claudeTmpRoot } from "../../cleanup/disk.ts";
import { executeCleanup } from "../../cleanup/execute.ts";
import { othersRunningIn, sharedActivityPaths } from "../../cleanup/rows.ts";
import { formatSize, sortRows, totalSize } from "../../cleanup/sort.ts";
import type { CleanupRow, GitState, RowSizes } from "../../cleanup/types.ts";
import { fit, homeShort, timeAgo } from "../format/index.ts";
import { liveManagedPaths } from "../../runtime/tmux/index.ts";
import { canonical, useCleanupData } from "../hooks/useCleanupData.ts";
import { cleanupKey, finishRun, syncCursor, INITIAL_CLEANUP, type CleanupDialog, type CleanupEnv, type CleanupState } from "../keys/cleanup.ts";
import { gitCells, pageTop, runCell, sortLabel } from "../models/cleanupRow.ts";
import { CleanupDialogView, StyledCells } from "./CleanupDialog.tsx";

/**
 * Where every live (non-placeholder) agendo pane is working, as realpaths —
 * and this TUI itself, whose own cwd vanishing under it would crash it later.
 */
function livePaneCwds(): string[] {
  const panes = liveManagedPaths()
    .filter((t) => !t.placeholder)
    .map((t) => canonical(t.cwd));
  try {
    return [...panes, canonical(process.cwd())];
  } catch {
    return panes;
  }
}

const RUN_W = 13;
const TIME_W = 10;
const SIZE_W = 7;

function RowLines({ row, focused, git, sizes, titleW }: { row: CleanupRow; focused: boolean; git: GitState | null | undefined; sizes: RowSizes | undefined; titleW: number }) {
  const run = runCell(row.run, !!row.session);
  const branch = git?.branch ?? row.branchHint;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate">
        <Text color={focused ? "cyan" : undefined}>{focused ? "▸ " : "  "}</Text>
        <Text color={run.color} dimColor={run.dim}>{run.text.padEnd(RUN_W)}</Text>
        <Text bold={focused}>{fit(row.title, titleW).padEnd(titleW)}</Text>
        <Text>{timeAgo(row.updated).padEnd(TIME_W)}</Text>
        <Text>{timeAgo(row.created).padEnd(TIME_W)}</Text>
        <Text>{formatSize(totalSize(sizes)).padStart(SIZE_W - 1).padEnd(SIZE_W)}</Text>
        <StyledCells cells={gitCells(git)} />
      </Text>
      <Text wrap="truncate" dimColor>{`  ${" ".repeat(RUN_W)}${homeShort(row.path)}${branch ? `  [${branch}]` : ""}`}</Text>
    </Box>
  );
}

interface ListProps {
  rows: CleanupRow[];
  state: CleanupState;
  gits: ReadonlyMap<string, GitState | null>;
  sizes: ReadonlyMap<string, RowSizes>;
  top: number;
  page: number;
  cols: number;
}

function CleanupList({ rows, state, gits, sizes, top, page, cols }: ListProps): ReactElement {
  const titleW = Math.max(16, Math.min(48, cols - 2 - RUN_W - 2 * TIME_W - SIZE_W - 30));
  const shown = rows.slice(top, top + page);
  return (
    <Box flexDirection="column">
      <Text bold>
        {`Cleanup — ${rows.length} session${rows.length === 1 ? "" : "s"} & worktrees`}
        <Text dimColor>{`  ·  sort: ${sortLabel(state.sort, state.reversed)}`}</Text>
      </Text>
      <Text dimColor wrap="truncate">
        {`  ${"STATE".padEnd(RUN_W)}${"TITLE / PATH [BRANCH]".padEnd(titleW)}${"UPDATED".padEnd(TIME_W)}${"CREATED".padEnd(TIME_W)}${"SIZE".padStart(SIZE_W - 1).padEnd(SIZE_W)}GIT`}
      </Text>
      {rows.length === 0 ? <Text dimColor>{"  nothing to clean up here"}</Text> : null}
      {top > 0 ? <Text dimColor>{`  ↑ ${top} more`}</Text> : null}
      {shown.map((r, i) => (
        <RowLines key={r.key} row={r} focused={top + i === state.cursor} git={gits.get(r.key)} sizes={sizes.get(r.key)} titleW={titleW} />
      ))}
      {top + page < rows.length ? <Text dimColor>{`  ↓ ${rows.length - top - page} more`}</Text> : null}
      {state.note ? <Text color="yellow">{state.note}</Text> : null}
      <Text dimColor wrap="truncate">
        {`↑/↓ move · enter/space clean up · s sort: ${state.sort} · r reverse · esc back · q quit`}
      </Text>
    </Box>
  );
}

/**
 * The cleanup view (C from the list): every session in scope and every
 * agendo-managed worktree no session points at, with sizes and git state
 * filling in as they are measured, and a per-row dialog that deletes the
 * worktree, the branch, the transcript or the scratch files.
 *
 * It owns its state and its keys; App's key chain stands aside while it is up
 * (see `handleCleanupModeKeys`).
 */
export function CleanupScreen({
  model,
  inScope,
  extraRoots,
  onBack,
  onQuit,
}: {
  model: LoadedModel;
  inScope: (cwd: string) => boolean;
  extraRoots: readonly string[];
  onBack: () => void;
  onQuit: () => void;
}): ReactElement {
  const [scanKey, setScanKey] = useState(0);
  const { rows, gits, sizes } = useCleanupData({ model, inScope, extraRoots, scanKey });
  const [stored, setState] = useState<CleanupState>(INITIAL_CLEANUP);
  const sorted = useMemo(() => sortRows(rows, stored.sort, stored.reversed, sizes), [rows, stored.sort, stored.reversed, sizes]);
  const state = syncCursor(stored, sorted);
  // Keep the stored focus in step, so a re-sort before the next key moves the
  // cursor with its row rather than leaving it on an index.
  // Functional, so it applies on top of whatever landed meanwhile (a finished run) rather than over it.
  useEffect(() => {
    if (state !== stored) setState((s) => syncCursor(s, sorted));
  }, [state, stored, sorted]);
  // Re-read with every model refresh; run() reads it afresh again before deleting.
  const panes = useMemo(() => livePaneCwds(), [model]); // eslint-disable-line react-hooks/exhaustive-deps -- `model` is the refresh tick, not an input
  const env: CleanupEnv = {
    rows: sorted,
    offers: (row) => offersFor(row, gits.get(row.key), othersRunningIn(row, rows, panes)),
    git: (row) => gits.get(row.key),
  };

  // The plan is built from the row as it is NOW, not the dialog's snapshot: a
  // session that started running while the dialog was open must be refused.
  const run = (d: CleanupDialog) => {
    const live = rows.find((r) => r.key === d.key);
    if (!live) {
      setState((s) => finishRun(s, [{ ok: false, text: "refused — the row is gone; nothing was deleted" }]));
      return;
    }
    const plan = {
      row: live,
      sel: d.sel,
      git: d.git,
      confirmed: d.confirmed,
      activeConfirmed: d.confirmed && d.activeShown,
      othersRunning: othersRunningIn(live, rows, livePaneCwds()),
      tmpRoot: claudeTmpRoot(),
      uid: process.getuid?.() ?? 0,
      now: Date.now(),
      shared: sharedActivityPaths(live, rows),
    };
    executeCleanup(plan)
      .catch((e: unknown) => [{ ok: false, text: String(e) }])
      .then((results) => setState((s) => finishRun(s, results)));
  };

  useInput((input, key) => {
    const step = cleanupKey(state, input, key, env);
    // A key it ignored must not write its (possibly stale) state back over a run that just finished.
    if (step.state !== state) setState(step.state);
    if (step.effect === "back") onBack();
    else if (step.effect === "quit") onQuit();
    else if (step.effect === "refresh") setScanKey((k) => k + 1);
    else if (step.effect === "run" && step.state.dialog) run(step.state.dialog);
  });

  const { stdout } = useStdout();
  const page = Math.max(2, Math.floor(((stdout?.rows ?? 24) - 6) / 2));
  // The window only moves when the cursor would leave it. A ref, not state:
  // it is derived from the cursor each render and never drives one itself.
  const top = useRef(0);
  top.current = pageTop(state.cursor, sorted.length, page, top.current);

  const d = state.dialog;
  if (d) {
    const live = sorted.find((r) => r.key === d.key);
    const row = live ?? d.row;
    return <CleanupDialogView d={d} row={row} git={gits.get(row.key) ?? d.git} offers={env.offers(row)} sizes={sizes.get(row.key)} />;
  }
  return <CleanupList rows={sorted} state={state} gits={gits} sizes={sizes} top={top.current} page={page} cols={stdout?.columns ?? 80} />;
}
