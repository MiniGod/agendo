import type { Key } from "ink";
import { pausedTabIn } from "../../cleanup/bulk.ts";
import { defaultSelection, needsConfirm, selectionProblem } from "../../cleanup/classify.ts";
import type { CleanupResult } from "../../cleanup/execute.ts";
import { nextFilter, type CleanupFilter, type Verdict } from "../../cleanup/filter.ts";
import { nextSort, type CleanupSort } from "../../cleanup/sort.ts";
import { BOXES, type CleanupRow, type GitState, type Offers, type Selection } from "../../cleanup/types.ts";
import type { KeyContext } from "./context.ts";
import { bulkKey, openBulk, type BulkDialog } from "./cleanupBulk.ts";
import { editLine } from "./lineEdit.ts";

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
  /** Which rows `f` keeps. Remembered by the screen for the rest of the TUI's run. */
  filter: CleanupFilter;
  /** The `/` text filter on title, branch and path; empty for none. */
  query: string;
  /** Whether keys are being typed into the `/` filter. */
  typing: boolean;
  /** Where in `query` the next typed text goes. */
  caret: number;
  dialog: CleanupDialog | null;
  /** D's delete-everything-safe confirmation, run and summary. */
  bulk: BulkDialog | null;
  /** A one-line answer to the last list key. */
  note: string | null;
}

/**
 * What the screen must do after a key: nothing, leave, quit, run the dialog's
 * plan, re-measure what a finished cleanup touched, re-scan everything (R),
 * switch to the focused row's live session, pause / kill / force-kill it, or
 * run D's delete-everything-safe.
 */
export type CleanupEffect = "none" | "back" | "quit" | "run" | "refresh" | "rescan" | "switch" | "pause" | "kill" | "forceKill" | "runAll";

export interface CleanupEnv {
  /** The rows on screen: sorted, then filtered. The list's cursor moves over these. */
  rows: readonly CleanupRow[];
  /**
   * Every row, filter or not. The dialog finds its row here, so a row that
   * leaves the filter while its dialog is open (it went active, say) is not
   * mistaken for one that is gone.
   */
  all: readonly CleanupRow[];
  offers: (row: CleanupRow) => Offers;
  git: (row: CleanupRow) => GitState | null | undefined;
  /**
   * A row's CURRENT verdict — `pending` while it is measured again, even though
   * the filter still lists it by its last one (`shownVerdict`). D deletes only
   * shown rows whose current verdict is `safe`.
   */
  verdict: (row: CleanupRow) => Verdict;
  /** How many rows the D dialog shows at once, so it scrolls only what does not fit. */
  page?: number;
  /** How many rows the `/` text matches that are still being checked, shown or hidden by `f`. */
  pending?: number;
}

export type Step = { state: CleanupState; effect: CleanupEffect };

export const INITIAL_CLEANUP: CleanupState = {
  cursor: 0, focus: null, sort: "updated", reversed: false, filter: "all", query: "", typing: false, caret: 0, dialog: null, bulk: null, note: null,
};

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
  // An empty list (a filter that matches nothing, for now) keeps the focus, so the row is found again when it is back.
  const focus = rows[cursor]?.key ?? state.focus;
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

function moveCursor(state: CleanupState, dir: -1 | 1, env: CleanupEnv): Step {
  const cursor = clamp(state.cursor + dir, env.rows.length);
  return stay({ ...state, cursor, focus: env.rows[cursor]?.key ?? state.focus });
}

/**
 * A key while typing into the `/` filter: enter keeps the text and goes back
 * to the list's keys, esc drops it, ↑/↓ still move, and everything else edits.
 */
function queryKey(state: CleanupState, input: string, key: Key, env: CleanupEnv): Step {
  if (key.return) return stay({ ...state, typing: false });
  if (key.escape) return stay({ ...state, typing: false, query: "", caret: 0 });
  if (key.upArrow || key.downArrow) return moveCursor(state, key.upArrow ? -1 : 1, env);
  const edit = editLine(input, key, state.query, state.caret);
  return edit ? stay({ ...state, query: edit.value, caret: edit.cursor }) : stay(state);
}

/** The session keys of the list: p pauses, x kills, X force-kills — the same actions as on the session rows. */
const END_KEYS: Record<string, CleanupEffect> = { p: "pause", x: "kill", X: "forceKill" };

/**
 * D's rows: every shown row that is safe to remove — except one whose checkout
 * a paused tab would wake up in; that one goes only from its own dialog — or,
 * when there is none, a note saying so. A paused pane whose session is no row
 * at all is caught by the check right before each row's turn.
 */
function deleteAllSafe(state: CleanupState, env: CleanupEnv): CleanupState {
  const safe = env.rows.filter((r) => env.verdict(r) === "safe");
  const bulk = safe.filter((r) => !pausedTabIn(r, env.all));
  if (bulk.length > 0) return { ...state, bulk: openBulk(bulk) };
  if (safe.length > 0) return { ...state, note: "only paused tabs' checkouts are safe to remove here — D leaves them; use space on one" };
  // Under a filter the rows still being checked are hidden, so the view says how many there are.
  const checking = (env.pending ?? 0) > 0 || env.rows.some((r) => env.verdict(r) === "pending");
  return { ...state, note: checking ? "nothing shown is safe to remove yet — some rows are still being checked" : "nothing shown is safe to remove" };
}

/** Enter on a row whose session is live (running, or a paused tab) switches to it, as on the session rows. */
const isLive = (row: CleanupRow | undefined) => !!row?.session && row.run !== "idle";

/** The list's view keys: sort, reverse, filter, and the `/` prompt. Null for any other key. */
function viewKey(state: CleanupState, input: string): CleanupState | null {
  // A new order or filter keeps the focused row where it can; syncCursor finds it in the new rows.
  if (input === "s") return { ...state, sort: nextSort(state.sort) };
  if (input === "r") return { ...state, reversed: !state.reversed };
  if (input === "f") return { ...state, filter: nextFilter(state.filter) };
  if (input === "/") return { ...state, typing: true, caret: state.query.length };
  return null;
}

/** Leaving, moving, and the view keys. Null for any other key. */
function navKey(state: CleanupState, input: string, key: Key, env: CleanupEnv): Step | null {
  // esc drops a `/` filter first, and only then leaves.
  if (key.escape) return state.query ? stay({ ...state, query: "", caret: 0 }) : { state, effect: "back" };
  if (input === "q") return { state, effect: "quit" };
  const dir = vertical(input, key);
  if (dir) return moveCursor(state, dir, env);
  const view = viewKey(state, input);
  return view ? stay(view) : null;
}

/** The keys that act: on the session (p/x/X), on every safe row (D), on the scan (R). Null for any other key. */
function actionKey(state: CleanupState, input: string, key: Key, env: CleanupEnv): Step | null {
  const end = key.ctrl || key.meta ? undefined : END_KEYS[input];
  if (end) return { state, effect: end };
  if (input === "D") return stay(deleteAllSafe(state, env));
  if (input === "R") return { state, effect: "rescan" };
  return null;
}

/** Enter and space on the focused row: switch to its live session, or open its dialog. */
function rowKey(state: CleanupState, input: string, key: Key, env: CleanupEnv): Step {
  const row = env.rows[state.cursor];
  if (key.return && isLive(row)) return { state, effect: "switch" };
  if (!(key.return || input === " ") || !row) return stay(state);
  // The defaults are decided from the git state, so the dialog waits for it.
  if (env.git(row) === undefined) return stay({ ...state, note: "still checking git state…" });
  return stay({ ...state, dialog: openDialog(row, env) });
}

function listKey(prev: CleanupState, input: string, key: Key, env: CleanupEnv): Step {
  const state = prev.note ? { ...prev, note: null } : prev;
  if (state.typing) return queryKey(state, input, key, env);
  return navKey(state, input, key, env) ?? actionKey(state, input, key, env) ?? rowKey(state, input, key, env);
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
  const row = env.all.find((r) => r.key === d.key);
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
  const row = env.all.find((r) => r.key === d.key);
  if (!row) return stay({ ...state, dialog: null });
  const problem = selectionProblem(d.sel, env.offers(row), env.git(row));
  if (problem) return stay({ ...state, dialog: { ...d, stage: "edit", note: problem } });
  // Active since the prompt was drawn: show that too, and ask again.
  if (row.active && !d.activeShown) return stay({ ...state, dialog: { ...d, activeShown: true, note: "it became active since — y again to confirm" } });
  return { state: { ...state, dialog: { ...d, stage: "running", confirmed: true } }, effect: "run" };
}

function bulkStep(state: CleanupState, b: BulkDialog, input: string, key: Key, page?: number): Step {
  const r = bulkKey(b, input, key, page);
  // A key the run ignores must not write this (possibly stale) state over the progress landing meanwhile.
  if (r.bulk === b && r.effect === "none") return stay(state);
  if (r.effect === "cancel") return stay({ ...state, bulk: null, note: "nothing deleted" });
  return { state: { ...state, bulk: r.bulk }, effect: r.effect };
}

/** Apply one key to the cleanup screen. */
export function cleanupKey(state: CleanupState, input: string, key: Key, env: CleanupEnv): Step {
  if (state.bulk) return bulkStep(state, state.bulk, input, key, env.page);
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
