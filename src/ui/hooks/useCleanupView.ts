import { useCallback, useMemo, useRef } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import { offersFor } from "../../cleanup/classify.ts";
import { filterRows, shownVerdict, verdictOf, type Verdict } from "../../cleanup/filter.ts";
import { othersRunningIn } from "../../cleanup/rows.ts";
import { sortRows } from "../../cleanup/sort.ts";
import type { CleanupRow, GitState, RowSizes } from "../../cleanup/types.ts";
import type { CleanupState } from "../keys/cleanup.ts";
import { livePaneCwds } from "./useCleanupRuns.ts";

/**
 * What the cleanup view shows of its rows: each row's offers and verdict, the
 * rows sorted, then filtered by `f` and `/`, and how many of the rows the text
 * matches are still being measured.
 */
export function useCleanupView({
  model,
  rows,
  gits,
  sizes,
  state,
}: {
  model: LoadedModel;
  rows: readonly CleanupRow[];
  gits: ReadonlyMap<string, GitState | null>;
  sizes: ReadonlyMap<string, RowSizes>;
  state: CleanupState;
}) {
  // Re-read with every model refresh; run() reads it afresh again before deleting.
  const panes = useMemo(() => livePaneCwds(), [model]); // eslint-disable-line react-hooks/exhaustive-deps -- `model` is the refresh tick, not an input
  const offers = useCallback((row: CleanupRow) => offersFor(row, gits.get(row.key), othersRunningIn(row, rows, panes)), [gits, rows, panes]);
  const git = useCallback((row: CleanupRow) => gits.get(row.key), [gits]);
  const sorted = useMemo(() => sortRows(rows, state.sort, state.reversed, sizes), [rows, state.sort, state.reversed, sizes]);
  // The filter judges each row with the dialog's own offers and defaults (see `verdictOf`).
  const verdicts = useMemo(() => new Map(sorted.map((r) => [r.key, verdictOf(r, git(r), offers(r))])), [sorted, git, offers]);
  const verdict = useCallback((r: CleanupRow): Verdict => verdicts.get(r.key) ?? "pending", [verdicts]);
  // Each row's last measured verdict, so one being measured again keeps its place in the list (see `shownVerdict`).
  const measured = useRef(new Map<string, Verdict>());
  for (const [k, v] of verdicts) if (v !== "pending") measured.current.set(k, v);
  const visible = useMemo(
    () => filterRows(sorted, state.filter, state.query, (r) => shownVerdict(verdict(r), measured.current.get(r.key)), git),
    [sorted, state.filter, state.query, verdict, git],
  );
  // Of the rows the `/` text matches, those not yet judged.
  const pending = useMemo(
    () => filterRows(sorted, "all", state.query, verdict, git).filter((r) => verdict(r) === "pending").length,
    [sorted, state.query, verdict, git],
  );
  return { offers, git, sorted, verdict, visible, pending };
}
