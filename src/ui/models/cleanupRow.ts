// What each cell of the cleanup view says, decided apart from the component that
// paints it so every arm is unit tested (test/cleanupRow.test.ts) without
// rendering anything.
import type { CleanupSort } from "../../cleanup/sort.ts";
import type { GitState, RunState } from "../../cleanup/types.ts";

export interface Styled {
  text: string;
  color?: string;
  dim?: boolean;
}

const RUN: Record<RunState, Styled> = {
  running: { text: "● running", color: "green" },
  paused: { text: "◐ paused", color: "yellow" },
  idle: { text: "○ idle", dim: true },
};

export function runCell(run: RunState, hasSession: boolean): Styled {
  return hasSession ? RUN[run] : { text: "· no session", dim: true };
}

/** One cell per thing at stake, in display order; null where there is none of it. */
const RISK_CELLS: Array<(git: GitState) => Styled | null> = [
  (g) => (g.dirty > 0 ? { text: `${g.dirty} dirty`, color: "yellow" } : null),
  (g) => (g.statusError ? { text: "status?", color: "red" } : null),
  (g) => (g.ignored.length > 0 ? { text: `${g.ignored.length} ignored`, color: "yellow" } : null),
  (g) => (g.submodules > 0 ? { text: `${g.submodules} submodule${g.submodules === 1 ? "" : "s"}`, color: "yellow" } : null),
  (g) => (g.unpushed > 0 ? { text: `${g.unpushed} unpushed`, color: "red" } : null),
];

function stateCells(git: GitState): Styled[] {
  const risks = RISK_CELLS.map((cell) => cell(git)).filter((c): c is Styled => c !== null);
  const where: Styled[] = git.worktreeExists ? [] : [{ text: "branch only", dim: true }];
  const merged: Styled = git.merged ? { text: "merged", color: "green" } : { text: "unmerged", color: "yellow" };
  return [...where, ...(risks.length > 0 ? risks : [{ text: "clean", color: "green" }]), merged];
}

/** The git column: `…` while probing, then what is at stake, or `clean · merged`. */
export function gitCells(git: GitState | null | undefined): Styled[] {
  if (git === undefined) return [{ text: "…", dim: true }];
  if (git === null) return [{ text: "no checkout or branch", dim: true }];
  if (git.isMain) return [{ text: "main checkout", dim: true }];
  return stateCells(git);
}

export function sortLabel(sort: CleanupSort, reversed: boolean): string {
  const arrow = reversed ? "↑" : "↓";
  return `${sort} ${arrow}`;
}

/** The first visible row index that keeps `cursor` on a page of `page` rows. */
export function pageTop(cursor: number, len: number, page: number, prevTop: number): number {
  let top = prevTop;
  if (cursor < top) top = cursor;
  else if (cursor >= top + page) top = cursor - page + 1;
  return Math.max(0, Math.min(top, Math.max(0, len - page)));
}
