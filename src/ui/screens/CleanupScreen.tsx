import { Box, Text, useInput, useStdout } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import { touchedBy } from "../../cleanup/bulk.ts";
import { offersFor } from "../../cleanup/classify.ts";
import { filterLabel, filterRows, verdictOf, type CleanupFilter } from "../../cleanup/filter.ts";
import { othersRunningIn } from "../../cleanup/rows.ts";
import { formatSize, sortRows, totalSize } from "../../cleanup/sort.ts";
import type { CleanupRow, GitState, RowSizes } from "../../cleanup/types.ts";
import { fit, homeShort, timeAgo } from "../format/index.ts";
import { openSession, type OpenPlan } from "../../launch/index.ts";
import { sessionName } from "../../runtime/tmux/index.ts";
import { useCleanupData } from "../hooks/useCleanupData.ts";
import { useCleanupEnd } from "../hooks/useCleanupEnd.ts";
import { livePaneCwds, useCleanupRuns } from "../hooks/useCleanupRuns.ts";
import { cleanupKey, syncCursor, INITIAL_CLEANUP, type CleanupEnv, type CleanupState } from "../keys/cleanup.ts";
import { gitCells, pageTop, runCell, sortLabel } from "../models/cleanupRow.ts";
import { CleanupBulkView } from "./CleanupBulk.tsx";
import { CleanupDialogView, StyledCells } from "./CleanupDialog.tsx";
import { ConfirmEndScreen } from "./ConfirmEndScreen.tsx";

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
  /** How many rows there are before the filter. */
  total: number;
  /** How many of those are still being probed, and so in no filter but `all` yet. */
  pending: number;
  state: CleanupState;
  gits: ReadonlyMap<string, GitState | null>;
  sizes: ReadonlyMap<string, RowSizes>;
  top: number;
  page: number;
  cols: number;
}

/** The header's count: every row, or `3 of 7` once a filter hides some. */
function countLabel(shown: number, total: number, filtered: boolean): string {
  return `${filtered ? `${shown} of ${total}` : total} session${total === 1 ? "" : "s"} & worktrees`;
}

/** What the header says is filtering the list: the `f` filter, the `/` text, and what is not judged yet. */
function filterNote(state: CleanupState, pending: number): string {
  const parts = [`filter: ${filterLabel(state.filter)}`];
  if (state.query) parts.push(`/${state.query}`);
  if (state.filter !== "all" && pending > 0) parts.push(`${pending} still checking`);
  return parts.map((p) => `  ·  ${p}`).join("");
}

/** The key hints, two lines so that both fit a normal terminal untruncated. */
function Footer({ state }: { state: CleanupState }) {
  if (state.typing) return <Text dimColor wrap="truncate">{"type to filter by title, branch or path · enter keep · esc clear"}</Text>;
  return (
    <Box flexDirection="column">
      <Text dimColor wrap="truncate">{"↑/↓ move · enter switch to it if live, else clean up · space clean up · D delete all safe · p/x/X pause/kill"}</Text>
      <Text dimColor wrap="truncate">
        {`f filter: ${filterLabel(state.filter)} · / search · s sort: ${state.sort} · r reverse · R re-scan · esc back · q quit`}
      </Text>
    </Box>
  );
}

function CleanupList({ rows, total, pending, state, gits, sizes, top, page, cols }: ListProps): ReactElement {
  const titleW = Math.max(16, Math.min(48, cols - 2 - RUN_W - 2 * TIME_W - SIZE_W - 30));
  const shown = rows.slice(top, top + page);
  const filtered = state.filter !== "all" || state.query !== "";
  return (
    <Box flexDirection="column">
      <Text bold>
        {`Cleanup — ${countLabel(rows.length, total, filtered)}`}
        <Text dimColor>{`${filterNote(state, pending)}  ·  sort: ${sortLabel(state.sort, state.reversed)}`}</Text>
      </Text>
      {state.typing ? <Text>{`/ ${state.query}`}<Text color="cyan">{"▏"}</Text></Text> : null}
      <Text dimColor wrap="truncate">
        {`  ${"STATE".padEnd(RUN_W)}${"TITLE / PATH [BRANCH]".padEnd(titleW)}${"UPDATED".padEnd(TIME_W)}${"CREATED".padEnd(TIME_W)}${"SIZE".padStart(SIZE_W - 1).padEnd(SIZE_W)}GIT`}
      </Text>
      {rows.length === 0 ? <Text dimColor>{filtered && total > 0 ? "  nothing matches this filter" : "  nothing to clean up here"}</Text> : null}
      {top > 0 ? <Text dimColor>{`  ↑ ${top} more`}</Text> : null}
      {shown.map((r, i) => (
        <RowLines key={r.key} row={r} focused={top + i === state.cursor} git={gits.get(r.key)} sizes={sizes.get(r.key)} titleW={titleW} />
      ))}
      {top + page < rows.length ? <Text dimColor>{`  ↓ ${rows.length - top - page} more`}</Text> : null}
      {state.note ? <Text color="yellow">{state.note}</Text> : null}
      <Footer state={state} />
    </Box>
  );
}

/**
 * The `f` filter the view last showed, kept for the rest of this run of the
 * TUI so leaving the view and coming back (C again) keeps it. Never written to
 * disk: a new run starts from `all`.
 */
let rememberedFilter: CleanupFilter = "all";

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
  reload,
  open,
}: {
  model: LoadedModel;
  inScope: (cwd: string) => boolean;
  extraRoots: readonly string[];
  onBack: () => void;
  onQuit: () => void;
  /** Re-read the model, so a session paused or killed here shows it. */
  reload: () => void;
  /** Switch to a session, exactly as enter on a session row does. */
  open: (plan: OpenPlan) => void;
}): ReactElement {
  const [scanKey, setScanKey] = useState(0);
  const { rows, gits, sizes, remeasure } = useCleanupData({ model, inScope, extraRoots, scanKey });
  const [stored, setState] = useState<CleanupState>(() => ({ ...INITIAL_CLEANUP, filter: rememberedFilter }));
  useEffect(() => {
    rememberedFilter = stored.filter;
  }, [stored.filter]);
  // Re-read with every model refresh; run() reads it afresh again before deleting.
  const panes = useMemo(() => livePaneCwds(), [model]); // eslint-disable-line react-hooks/exhaustive-deps -- `model` is the refresh tick, not an input
  const offers = useCallback((row: CleanupRow) => offersFor(row, gits.get(row.key), othersRunningIn(row, rows, panes)), [gits, rows, panes]);
  const git = useCallback((row: CleanupRow) => gits.get(row.key), [gits]);
  const sorted = useMemo(() => sortRows(rows, stored.sort, stored.reversed, sizes), [rows, stored.sort, stored.reversed, sizes]);
  // The filter judges each row with the dialog's own offers and defaults (see `verdictOf`).
  const verdicts = useMemo(() => new Map(sorted.map((r) => [r.key, verdictOf(r, git(r), offers(r))])), [sorted, git, offers]);
  const visible = useMemo(
    () => filterRows(sorted, stored.filter, stored.query, (r) => verdicts.get(r.key) ?? "pending", git),
    [sorted, stored.filter, stored.query, verdicts, git],
  );
  const pending = [...verdicts.values()].filter((v) => v === "pending").length;
  // A filter that hides the focused row leaves the cursor at its index, on whatever row is there now.
  const state = syncCursor(stored, visible);
  // Keep the stored focus in step, so a re-sort before the next key moves the
  // cursor with its row rather than leaving it on an index.
  // Functional, so it applies on top of whatever landed meanwhile (a finished run) rather than over it.
  useEffect(() => {
    if (state !== stored) setState((s) => syncCursor(s, visible));
  }, [state, stored, visible]);
  const env: CleanupEnv = { rows: visible, all: sorted, offers, git, verdict: (r) => verdicts.get(r.key) ?? "pending" };
  const setNote = (note: string | null) => setState((s) => ({ ...s, note }));
  const end = useCleanupEnd({ model, setNote, reload, onQuit });
  const { run, runAll } = useCleanupRuns({ rows, setState });

  // Enter on a live row: the session rows' own enter, so a running session is switched to, never started again.
  const switchTo = (row: CleanupRow | undefined) => {
    if (!row?.session) return;
    open(openSession(row.session, model.liveWindows.get(sessionName(row.session))));
    setNote(`▸ switched to ${row.title} — switch back to this window for more`);
  };

  // After a cleanup only what it could have changed is measured again; R measures everything.
  const settle = (prev: CleanupState) => {
    const done = prev.bulk?.rows ?? (prev.dialog ? [prev.dialog.row] : []);
    remeasure(touchedBy(done, rows, git));
  };

  useInput((input, key) => {
    if (end.answer(input, key)) return;
    const step = cleanupKey(state, input, key, env);
    // A key it ignored must not write its (possibly stale) state back over a run that just finished.
    if (step.state !== state) setState(step.state);
    const e = step.effect;
    if (e === "back") onBack();
    else if (e === "quit") onQuit();
    else if (e === "refresh") settle(state);
    else if (e === "rescan") setScanKey((k) => k + 1);
    else if (e === "switch") switchTo(visible[step.state.cursor]);
    else if (e === "run" && step.state.dialog) run(step.state.dialog);
    else if (e === "runAll" && step.state.bulk) runAll(step.state.bulk);
    else if (e === "pause" || e === "kill" || e === "forceKill") end.start(e, visible[step.state.cursor]);
  });

  const { stdout } = useStdout();
  const page = Math.max(2, Math.floor(((stdout?.rows ?? 24) - 7) / 2));
  // The window only moves when the cursor would leave it. A ref, not state:
  // it is derived from the cursor each render and never drives one itself.
  const top = useRef(0);
  top.current = pageTop(state.cursor, visible.length, page, top.current);

  if (state.bulk) return <CleanupBulkView b={state.bulk} page={page} />;
  if (end.confirm) return <ConfirmEndScreen title={end.confirm.session.title} prompt={end.confirm.prompt} force={end.confirm.force} />;
  const d = state.dialog;
  if (d) {
    const live = sorted.find((r) => r.key === d.key);
    const row = live ?? d.row;
    return <CleanupDialogView d={d} row={row} git={gits.get(row.key) ?? d.git} offers={env.offers(row)} sizes={sizes.get(row.key)} />;
  }
  return (
    <CleanupList rows={visible} total={sorted.length} pending={pending} state={state} gits={gits} sizes={sizes} top={top.current} page={page} cols={stdout?.columns ?? 80} />
  );
}
