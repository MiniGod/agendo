import type { Key } from "ink";
import { defaultSelection, needsConfirm, selectionProblem } from "../../cleanup/classify.ts";
import type { CleanupResult } from "../../cleanup/execute.ts";
import { nextSort, type CleanupSort } from "../../cleanup/sort.ts";
import { BOXES, type CleanupRow, type GitState, type Offers, type Selection } from "../../cleanup/types.ts";
import type { KeyContext } from "./context.ts";

// ── cleanup view (C from the list) ──
// The view owns its own state and its own useInput (src/ui/screens/CleanupScreen.tsx),
// so App's chain only has to stay out of the way while it is up: this guard
// sits FIRST and takes every key in cleanup mode, so neither the search, the
// global q/esc nor the list below ever sees one.
export function handleCleanupModeKeys(_input: string, _key: Key, ctx: Pick<KeyContext, "mode">): boolean {
  return ctx.mode.kind === "cleanup";
}

export type DialogStage = "edit" | "confirm" | "running" | "done";

export interface CleanupDialog {
  /** The row the dialog is for, by key — rows re-sort under it as sizes land. */
  key: string;
  /** That row as it was when the dialog opened, still shown once a cleanup has removed it. */
  row: CleanupRow;
  cursor: number;
  sel: Selection;
  stage: DialogStage;
  /** A one-line answer to the last key (why a box can't be ticked, …). */
  note: string | null;
  /** The git state the user confirmed against, captured on enter. */
  git: GitState | null | undefined;
  confirmed: boolean;
  /** Whether the confirm screen warned that the row was active moments ago. */
  activeShown: boolean;
  results: CleanupResult[];
}

export interface CleanupState {
  cursor: number;
  /**
   * The key of the row the cursor is on. Rows re-sort under the cursor as sizes
   * land and sessions are touched, so the cursor follows this row, not an
   * index — Enter must open the row the user pointed at.
   */
  focus: string | null;
  sort: CleanupSort;
  reversed: boolean;
  dialog: CleanupDialog | null;
  /** A one-line answer to the last list key. */
  note: string | null;
}

/** What the screen must do after a key: nothing, leave, quit, run the dialog's plan, or re-probe. */
export type CleanupEffect = "none" | "back" | "quit" | "run" | "refresh";

export interface CleanupEnv {
  rows: readonly CleanupRow[];
  offers: (row: CleanupRow) => Offers;
  git: (row: CleanupRow) => GitState | null | undefined;
}

type Step = { state: CleanupState; effect: CleanupEffect };

export const INITIAL_CLEANUP: CleanupState = { cursor: 0, focus: null, sort: "updated", reversed: false, dialog: null, note: null };

const stay = (state: CleanupState): Step => ({ state, effect: "none" });

/** Up / down (or k / j) as -1 / +1, else 0. */
function vertical(input: string, key: Key): -1 | 0 | 1 {
  if (key.upArrow || input === "k") return -1;
  if (key.downArrow || input === "j") return 1;
  return 0;
}

const clamp = (n: number, len: number) => Math.max(0, Math.min(n, len - 1));

/**
 * The state with its cursor on the focused row wherever `rows` now put it.
 * When that row is gone (or nothing is focused yet) the cursor stays at its
 * index, pulled back onto the list, and focuses whatever row is there now.
 */
export function syncCursor(state: CleanupState, rows: readonly CleanupRow[]): CleanupState {
  const at = state.focus === null ? -1 : rows.findIndex((r) => r.key === state.focus);
  const cursor = at >= 0 ? at : clamp(state.cursor, rows.length);
  const focus = rows[cursor]?.key ?? null;
  return cursor === state.cursor && focus === state.focus ? state : { ...state, cursor, focus };
}

export function openDialog(row: CleanupRow, env: CleanupEnv): CleanupDialog {
  const git = env.git(row);
  return {
    key: row.key,
    row,
    cursor: 0,
    sel: defaultSelection(env.offers(row), git, row.active),
    stage: "edit",
    note: null,
    git,
    confirmed: false,
    activeShown: false,
    results: [],
  };
}

function listKey(prev: CleanupState, input: string, key: Key, env: CleanupEnv): Step {
  const state = prev.note ? { ...prev, note: null } : prev;
  if (key.escape) return { state, effect: "back" };
  if (input === "q") return { state, effect: "quit" };
  const dir = vertical(input, key);
  if (dir) {
    const cursor = clamp(state.cursor + dir, env.rows.length);
    return stay({ ...state, cursor, focus: env.rows[cursor]?.key ?? null });
  }
  // A new order keeps the focused row; syncCursor finds it in the re-sorted rows.
  if (input === "s") return stay({ ...state, sort: nextSort(state.sort) });
  if (input === "r") return stay({ ...state, reversed: !state.reversed });
  const row = env.rows[state.cursor];
  if (!(key.return || input === " ") || !row) return stay(state);
  // The defaults are decided from the git state, so the dialog waits for it.
  if (env.git(row) === undefined) return stay({ ...state, note: "still checking git state…" });
  return stay({ ...state, dialog: openDialog(row, env) });
}

function toggle(d: CleanupDialog, offers: Offers): CleanupDialog {
  const box = BOXES[d.cursor];
  // Unticking is always allowed: a box can go unavailable after it was ticked.
  if (!offers[box].enabled && !d.sel[box]) return { ...d, note: `can't select ${box}: ${offers[box].reason}` };
  return { ...d, sel: { ...d.sel, [box]: !d.sel[box] }, note: null };
}

function submit(d: CleanupDialog, row: CleanupRow, env: CleanupEnv): { dialog: CleanupDialog; run: boolean } {
  const offers = env.offers(row);
  const git = env.git(row);
  const problem = selectionProblem(d.sel, offers, git);
  if (problem) return { dialog: { ...d, note: problem }, run: false };
  if (needsConfirm(d.sel, git, row.active)) return { dialog: { ...d, stage: "confirm", git, activeShown: !!row.active, note: null }, run: false };
  return { dialog: { ...d, stage: "running", git, confirmed: false, note: null }, run: true };
}

function editKey(state: CleanupState, d: CleanupDialog, input: string, key: Key, env: CleanupEnv): Step {
  if (key.escape) return stay({ ...state, dialog: null });
  const row = env.rows.find((r) => r.key === d.key);
  if (!row) return stay({ ...state, dialog: null }); // the row went away under the dialog
  const dir = vertical(input, key);
  if (dir) return stay({ ...state, dialog: { ...d, cursor: clamp(d.cursor + dir, BOXES.length), note: null } });
  if (input === " ") return stay({ ...state, dialog: toggle(d, env.offers(row)) });
  if (!key.return) return stay(state);
  const next = submit(d, row, env);
  return { state: { ...state, dialog: next.dialog }, effect: next.run ? "run" : "none" };
}

/**
 * The second confirmation: only `y` goes ahead; anything else goes back to the
 * boxes. The prompt may have sat open, so `y` re-checks the row as it is NOW —
 * a session that started running meanwhile offers nothing any more.
 */
function confirmKey(state: CleanupState, d: CleanupDialog, input: string, env: CleanupEnv): Step {
  if (input !== "y" && input !== "Y") return stay({ ...state, dialog: { ...d, stage: "edit", note: "not deleted" } });
  const row = env.rows.find((r) => r.key === d.key);
  if (!row) return stay({ ...state, dialog: null });
  const problem = selectionProblem(d.sel, env.offers(row), env.git(row));
  if (problem) return stay({ ...state, dialog: { ...d, stage: "edit", note: problem } });
  // Active since the prompt was drawn: show that too, and ask again.
  if (row.active && !d.activeShown) return stay({ ...state, dialog: { ...d, activeShown: true, note: "it became active since — y again to confirm" } });
  return { state: { ...state, dialog: { ...d, stage: "running", confirmed: true } }, effect: "run" };
}

/** Apply one key to the cleanup screen. */
export function cleanupKey(state: CleanupState, input: string, key: Key, env: CleanupEnv): Step {
  const d = state.dialog;
  if (!d) return listKey(state, input, key, env);
  if (d.stage === "edit") return editKey(state, d, input, key, env);
  if (d.stage === "confirm") return confirmKey(state, d, input, env);
  if (d.stage === "done") return { state: { ...state, dialog: null }, effect: "refresh" };
  return stay(state); // running: keys wait
}

/** The run finished: show its summary until the next key. */
export function finishRun(state: CleanupState, results: CleanupResult[]): CleanupState {
  if (!state.dialog) return state;
  return { ...state, dialog: { ...state.dialog, stage: "done", results } };
}
