import { useRef, type Dispatch, type SetStateAction } from "react";
import { runBulk, type BulkCheck } from "../../cleanup/bulk.ts";
import { defaultSelection, offersFor } from "../../cleanup/classify.ts";
import { claudeTmpRoot } from "../../cleanup/disk.ts";
import { executeCleanup, type CleanupPlan, type CleanupResult } from "../../cleanup/execute.ts";
import { verdictOf } from "../../cleanup/filter.ts";
import { probeGit } from "../../cleanup/git.ts";
import { othersRunningIn, sharedActivityPaths } from "../../cleanup/rows.ts";
import type { CleanupRow } from "../../cleanup/types.ts";
import { liveManagedPaths } from "../../runtime/tmux/index.ts";
import { finishRun, type CleanupDialog, type CleanupState } from "../keys/cleanup.ts";
import { bulkDone, bulkStepped, type BulkDialog } from "../keys/cleanupBulk.ts";
import { canonical } from "./useCleanupData.ts";

/**
 * Where every live (non-placeholder) agendo pane is working, as realpaths —
 * and this TUI itself, whose own cwd vanishing under it would crash it later.
 */
export function livePaneCwds(): string[] {
  const panes = liveManagedPaths()
    .filter((t) => !t.placeholder)
    .map((t) => canonical(t.cwd));
  try {
    return [...panes, canonical(process.cwd())];
  } catch {
    return panes;
  }
}

type Choice = Pick<CleanupPlan, "sel" | "git" | "confirmed" | "activeConfirmed">;

/** A plan for `row` as the disk and the panes are NOW, with what the user chose. */
function planFor(row: CleanupRow, rows: readonly CleanupRow[], choice: Choice): CleanupPlan {
  return {
    row,
    ...choice,
    othersRunning: othersRunningIn(row, rows, livePaneCwds()),
    tmpRoot: claudeTmpRoot(),
    uid: process.getuid?.() ?? 0,
    now: Date.now(),
    shared: sharedActivityPaths(row, rows),
  };
}

/**
 * One row of D's run, judged again from the latest rows and a fresh git probe:
 * it goes only if it is still safe to remove, and then with exactly the boxes
 * its own dialog would start ticked, unconfirmed — so the run-time checks in
 * execute.ts also refuse anything that turns risky between this probe and theirs.
 */
async function bulkCheck(key: string, title: string, rows: readonly CleanupRow[]): Promise<BulkCheck> {
  const row = rows.find((r) => r.key === key);
  if (!row) return { title, skip: "skipped — the row is gone" };
  const git = await probeGit(row.repoRoot, row.path, row.branchHint);
  // Another row of this run took the same worktree and branch with it.
  if (git === null) return { title, skip: "skipped — its worktree and branch are already gone" };
  const offers = offersFor(row, git, othersRunningIn(row, rows, livePaneCwds()));
  if (verdictOf(row, git, offers) !== "safe") return { title, skip: "skipped — no longer safe to remove" };
  return { title, plan: planFor(row, rows, { sel: defaultSelection(offers, git, row.active), git, confirmed: false, activeConfirmed: false }) };
}

const failed = (e: unknown): CleanupResult[] => [{ ok: false, text: String(e) }];

/** The cleanup view's two ways of deleting: one row's dialog, and D's every-safe-row run. */
export function useCleanupRuns({
  rows,
  setState,
}: {
  rows: readonly CleanupRow[];
  setState: Dispatch<SetStateAction<CleanupState>>;
}) {
  // D runs across many renders; each row must be judged from the rows as they are then.
  const latest = useRef({ rows });
  latest.current = { rows };

  // The plan is built from the row as it is NOW, not the dialog's snapshot: a
  // session that started running while the dialog was open must be refused.
  const run = (d: CleanupDialog) => {
    const live = rows.find((r) => r.key === d.key);
    if (!live) {
      setState((s) => finishRun(s, [{ ok: false, text: "refused — the row is gone; nothing was deleted" }]));
      return;
    }
    const choice = { sel: d.sel, git: d.git, confirmed: d.confirmed, activeConfirmed: d.confirmed && d.activeShown };
    executeCleanup(planFor(live, rows, choice))
      .catch(failed)
      .then((results) => setState((s) => finishRun(s, results)));
  };

  const onBulk = (fn: (b: BulkDialog) => BulkDialog) => setState((s) => (s.bulk ? { ...s, bulk: fn(s.bulk) } : s));
  const runAll = (b: BulkDialog) => {
    const titles = new Map(b.rows.map((r) => [r.key, r.title]));
    void runBulk([...titles.keys()], {
      check: (key) => bulkCheck(key, titles.get(key) ?? key, latest.current.rows),
      execute: executeCleanup,
      onStep: (step) => onBulk((x) => bulkStepped(x, step)),
    }).then(() => onBulk(bulkDone));
  };

  return { run, runAll };
}
