// The shape of the list as a tree, read off the flat row array: which rows
// open, which are open, how deep each sits, and where ←/→ land from a given
// row. Pure functions over `Row[]`, so the arrow-key handler in list.ts is
// dispatch and nothing else.

import { itemKey, prKey } from "../../model.ts";
import { SELECTABLE, sessionExpandKey, type Row } from "../rows.ts";

/** Rows that →/← can open and close. */
export function isExpandable(row: Row): boolean {
  return row.kind === "item" || row.kind === "pr" || row.kind === "toggle" || row.kind === "session";
}

/** Whether an expandable row is currently open; false for every other kind. */
export function isOpen(row: Row): boolean {
  switch (row.kind) {
    case "item":
    case "pr":
    case "session":
      return row.expanded;
    case "toggle":
      return row.open;
    default:
      return false;
  }
}

/**
 * The expansion key `toggleExpand` takes for a row, or null for a row that
 * has none (sections toggle by id through `toggleSection` instead).
 */
export function expandKeyOf(row: Row): string | null {
  switch (row.kind) {
    case "item":
      return `wi:${itemKey(row.item)}`;
    case "pr":
      return `pr:${prKey(row.pr)}`;
    case "session":
      return sessionExpandKey(row.key);
    default:
      return null;
  }
}

/**
 * Nesting depth: sections/groups (toggle) = 0, work items / PRs = 1, the
 * sessions & fresh rows under them = 2. Used to climb one level on ←.
 */
export function depthOf(row: Row): 0 | 1 | 2 {
  switch (row.kind) {
    case "session":
    case "fresh":
      return 2;
    case "item":
    case "pr":
      return 1;
    default:
      return 0;
  }
}

/** The row right below `cursor` if it is selectable — the first child of an open row — else -1. */
export function firstChildIndex(rows: Row[], cursor: number): number {
  const child = rows[cursor + 1];
  return child && SELECTABLE.has(child.kind) ? cursor + 1 : -1;
}

/** The nearest selectable row above `cursor` that sits at a shallower depth, else -1. */
export function ancestorIndex(rows: Row[], cursor: number): number {
  const d = depthOf(rows[cursor]);
  for (let i = cursor - 1; i >= 0; i--) {
    if (depthOf(rows[i]) < d && SELECTABLE.has(rows[i].kind)) return i;
  }
  return -1;
}
