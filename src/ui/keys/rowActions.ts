// The row actions of list mode: `c` continues the hovered session in the
// other agent, `m` moves it to another Claude profile, `o` opens the hovered
// work item / PR / session in the browser. Each works on the row under the
// cursor in any view, and says in the notice what it needed when that row is
// the wrong kind. list.ts dispatches to this between the view keys and
// navigation; nothing here knows about focus or the view.

import type { Key } from "ink";
import type { AgentSession } from "../../types.ts";
import type { Row } from "../rows.ts";
import type { OpenTargets } from "../targets.ts";
import { V } from "../vocabState.ts";
import type { KeyContext } from "./context.ts";

export type RowActionCtx = Pick<
  KeyContext,
  "rows" | "cursor" | "setNotice" | "setMode" | "continueInOtherAgent" | "enterProfilePicker"
>;

/** The session under the cursor, or null after a notice saying which row the action needs. */
export function hoveredSession(ctx: RowActionCtx, notice: string): AgentSession | null {
  const row = ctx.rows[ctx.cursor];
  if (row?.kind === "session") return row.session;
  ctx.setNotice(notice);
  return null;
}

// continue the hovered session in the other agent: convert its transcript
// and resume the result.
function continueHovered(ctx: RowActionCtx): void {
  const s = hoveredSession(ctx, "Select a session row first to continue it in another agent.");
  if (s) ctx.continueInOtherAgent(s);
}

// move the hovered session to another Claude profile (~/.claude*).
function moveHovered(ctx: RowActionCtx): void {
  const s = hoveredSession(ctx, "Select a session row first to move it to another profile.");
  if (s) ctx.enterProfilePicker(s);
}

type OpenableRow = Extract<Row, { kind: "item" | "pr" | "session" }>;
const OPENABLE = new Set<Row["kind"]>(["item", "pr", "session"]);

/** The row kinds that can carry a browser link. */
export function isOpenable(row: Row | undefined): row is OpenableRow {
  return row !== undefined && OPENABLE.has(row.kind);
}

/** Whether the targets hold at least one URL to open. */
export function hasLink(t: OpenTargets | undefined): t is OpenTargets {
  return Boolean(t && (t.pr || t.workItem));
}

/** The title the open dialog shows for a row. */
export function openTitle(row: OpenableRow): string {
  if (row.kind === "item") return `#${row.item.id} — ${row.item.title}`;
  if (row.kind === "pr") return `PR ${V.prPrefix}${row.pr.id} — ${row.pr.title}`;
  return row.session.title;
}

// open the hovered work item / PR / session in the browser
function openHovered(ctx: RowActionCtx): void {
  const row = ctx.rows[ctx.cursor];
  if (!isOpenable(row) || !hasLink(row.open)) {
    ctx.setNotice("Nothing to open in the browser for this row.");
    return;
  }
  ctx.setNotice(null);
  ctx.setMode({ kind: "open", targets: row.open, title: openTitle(row) });
}

// `c` and `m` need the bare letter: ctrl-c is quit, handled earlier, and a
// chord is never one of these. `o` has always taken any modifier.
const ACTIONS = new Map<string, { bare: boolean; run: (ctx: RowActionCtx) => void }>([
  ["c", { bare: true, run: continueHovered }],
  ["m", { bare: true, run: moveHovered }],
  ["o", { bare: false, run: openHovered }],
]);

export function handleListRowActionKeys(input: string, key: Key, ctx: RowActionCtx): boolean {
  const action = ACTIONS.get(input);
  if (!action) return false;
  if (action.bare && (key.ctrl || key.meta)) return false;
  action.run(ctx);
  return true;
}
