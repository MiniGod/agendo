import type { Key } from "ink";
import { openSession } from "../../launch.ts";
import { sessionName } from "../../tmux.ts";
import type { Row } from "../rows.ts";
import { V } from "../vocabState.ts";
import type { KeyContext, View } from "./context.ts";
import { ancestorIndex, expandKeyOf, firstChildIndex, isExpandable, isOpen } from "./rowTree.ts";

type ViewCtx = Pick<
  KeyContext,
  | "view"
  | "switchView"
  | "filterRoot"
  | "setCursor"
  | "setGlobalView"
  | "setRepoFilterOn"
  | "setGrouped"
  | "setPrsGrouped"
  | "enterNewSession"
  | "enterOrchestrator"
  | "enterGlobalOrchestrator"
  | "setSearchFocus"
  | "setPrSort"
  | "setSessionSort"
  | "enterSettings"
  | "enterIdentity"
  | "setNotice"
  | "setActivity"
  | "requested"
  | "setRescanKey"
  | "reload"
>;
type RowActionCtx = Pick<
  KeyContext,
  "rows" | "cursor" | "setNotice" | "setMode" | "continueInOtherAgent" | "enterProfilePicker"
>;
type NavCtx = Pick<
  KeyContext,
  | "rows"
  | "cursor"
  | "setCursor"
  | "move"
  | "toggleExpand"
  | "toggleSection"
  | "ensureActivity"
  | "open"
  | "model"
  | "enterFresh"
  | "enterNewSession"
>;
type Ctx = ViewCtx & RowActionCtx & NavCtx;

// ── list mode ──
// The tail of the chain. Split into the three groups it already read as — the
// view-level keys, the row actions, then cursor movement and expand/collapse —
// dispatched in the same order they ran inline. Each group may decline a key
// and let the next one see it; all three declining means nothing is bound to
// that key, exactly as falling off the end of the old handler did.
export function handleListKeys(input: string, key: Key, ctx: Ctx): boolean {
  if (handleListViewKeys(input, key, ctx)) return true;
  if (handleListRowActionKeys(input, key, ctx)) return true;
  if (handleListNavKeys(input, key, ctx)) return true;
  return false;
}

function handleListViewKeys(input: string, key: Key, ctx: ViewCtx): boolean {
  // view switching (Tab forward, Shift-Tab back)
  if (key.tab) {
    const order: View[] = ["items", "prs", "sessions"];
    const dir = key.shift ? -1 : 1;
    const next = order[(order.indexOf(ctx.view) + dir + order.length) % order.length];
    ctx.switchView(next);
    return true;
  }
  if (input === "1") { ctx.switchView("items"); return true; }
  if (input === "2") { ctx.switchView("prs"); return true; }
  if (input === "3") { ctx.switchView("sessions"); return true; }

  // toggle path scope ↔ global (only when the launcher is scoped to a path;
  // bare `agendo` is already global, so there's nothing to toggle). `a` = "all".
  if (input === "a" && ctx.filterRoot) {
    ctx.setCursor(0);
    ctx.setGlobalView((v) => !v);
    return true;
  }

  // toggle the repo filter on the work-item / PR views (only when scoped to a
  // path — with no root there are no repos to narrow to). `f` = "filter".
  if (input === "f" && ctx.filterRoot) {
    ctx.setCursor(0);
    ctx.setRepoFilterOn((v) => !v);
    return true;
  }

  // toggle repo grouping (Sessions: whole view · PRs: subgroups per section)
  if (input === "g" && (ctx.view === "sessions" || ctx.view === "prs")) {
    ctx.setCursor(0);
    if (ctx.view === "sessions") { ctx.setGrouped((v) => !v); return true; }
    ctx.setPrsGrouped((v) => !v);
    return true;
  }

  if (handleSessionStartKeys(input, ctx)) return true;

  // focus the fuzzy-search input (all list views)
  if (input === "/") { ctx.setSearchFocus("input"); return true; }

  // toggle PR sort order (created ↔ last updated); drafts stay at the bottom
  if (input === "s" && ctx.view === "prs") {
    ctx.setCursor(0);
    ctx.setPrSort((s) => (s === "created" ? "updated" : "created"));
    return true;
  }

  // toggle session sort order (updated ↔ created)
  if (input === "s" && ctx.view === "sessions") {
    ctx.setCursor(0);
    ctx.setSessionSort((s) => (s === "updated" ? "created" : "updated"));
    return true;
  }

  // open the Settings page (backend · identity · filters · auth status)
  if (input === ",") { ctx.enterSettings(); return true; }

  // quick shortcut (also in Settings): switch who you are — Work items & PRs only
  if (input === "u") { ctx.enterIdentity(); return true; }

  if (input === "r") {
    ctx.setNotice(null);
    ctx.setActivity(new Map()); // drop cached activity so expanded sessions refetch
    ctx.requested.current.clear();
    ctx.setRescanKey((k) => k + 1); // re-walk the path context for new checkouts
    ctx.reload();
    return true;
  }
  return false;
}

/**
 * The three "start something new" keys of the sessions view.
 *
 * Split out of `handleListViewKeys` rather than left inline because they are one
 * group — a plain session and the two coordinator levels above it — and because
 * the caller is already at its statement budget; a third binding there would buy
 * a lint threshold bump for no structural gain.
 *
 * Both coordinator keys are CAPITALS, so the lowercase `o` (open in browser) and
 * `g` (group by repo) bindings next door keep working.
 */
function handleSessionStartKeys(
  input: string,
  ctx: Pick<KeyContext, "view" | "enterNewSession" | "enterOrchestrator" | "enterGlobalOrchestrator">,
): boolean {
  if (ctx.view !== "sessions") return false;

  // new arbitrary session
  if (input === "n") { ctx.enterNewSession(); return true; }

  // new REPO orchestrator — a session that delegates every unit of work in one
  // repo to further background sessions instead of implementing.
  if (input === "O") { ctx.enterOrchestrator(); return true; }

  // the GLOBAL orchestrator — one level up again: it coordinates the per-repo
  // orchestrators and never touches a repo itself. Launches on the keystroke
  // (no repo or worktree left to pick) beside this menu.
  if (input === "G") { ctx.enterGlobalOrchestrator(); return true; }

  return false;
}

function handleListRowActionKeys(input: string, key: Key, ctx: RowActionCtx): boolean {
  // continue the hovered session in the other agent: convert its transcript
  // and resume the result. Works on a session row in any view. Guard against
  // ctrl-c (handled earlier as quit) so a bare `c` is required.
  if (input === "c" && !key.ctrl && !key.meta) {
    const row = ctx.rows[ctx.cursor];
    if (!row || row.kind !== "session") {
      ctx.setNotice("Select a session row first to continue it in another agent.");
      return true;
    }
    ctx.continueInOtherAgent(row.session);
    return true;
  }

  // move the hovered session to another Claude profile (~/.claude*). Works on
  // a session row in any view, like `c`.
  if (input === "m" && !key.ctrl && !key.meta) {
    const row = ctx.rows[ctx.cursor];
    if (!row || row.kind !== "session") {
      ctx.setNotice("Select a session row first to move it to another profile.");
      return true;
    }
    ctx.enterProfilePicker(row.session);
    return true;
  }

  // open the hovered work item / PR / session in the browser
  if (input === "o") {
    const row = ctx.rows[ctx.cursor];
    if (!row || (row.kind !== "item" && row.kind !== "pr" && row.kind !== "session")) {
      ctx.setNotice("Nothing to open in the browser for this row.");
      return true;
    }
    const targets = row.open;
    if (!targets || (!targets.pr && !targets.workItem)) {
      ctx.setNotice("Nothing to open in the browser for this row.");
      return true;
    }
    const title =
      row.kind === "item"
        ? `#${row.item.id} — ${row.item.title}`
        : row.kind === "pr"
          ? `PR ${V.prPrefix}${row.pr.id} — ${row.pr.title}`
          : row.session.title;
    ctx.setNotice(null);
    ctx.setMode({ kind: "open", targets, title });
    return true;
  }
  return false;
}

type FlipCtx = Pick<NavCtx, "toggleExpand" | "toggleSection" | "ensureActivity">;

/** Open a closed expandable row or close an open one; a no-op for every other kind. */
function flipOpen(row: Row, ctx: FlipCtx): void {
  if (row.kind === "toggle") return ctx.toggleSection(row.id);
  if (row.kind === "session") ctx.ensureActivity(row.session); // kick off the lazy parse on first expand
  const k = expandKeyOf(row);
  if (k) ctx.toggleExpand(k);
}

// → (or l): expand a closed row; on an open one, select its first child.
function expandOrDescend(ctx: NavCtx): boolean {
  const row = ctx.rows[ctx.cursor];
  if (!row || !isExpandable(row)) return true;
  if (!isOpen(row)) {
    flipOpen(row, ctx);
    return true;
  }
  const child = firstChildIndex(ctx.rows, ctx.cursor);
  if (child >= 0) ctx.setCursor(child);
  return true;
}

// ← (or h): an open expandable collapses first; only once it's collapsed (or
// it's a leaf) does ← climb to the nearest selectable ancestor one level up
// (child → work item/PR → its section/group).
function collapseOrClimb(ctx: NavCtx): boolean {
  const row = ctx.rows[ctx.cursor];
  if (!row) return true;
  if (isExpandable(row) && isOpen(row)) {
    flipOpen(row, ctx);
    return true;
  }
  const up = ancestorIndex(ctx.rows, ctx.cursor);
  if (up >= 0) ctx.setCursor(up);
  return true;
}

// enter: resume a session, start a fresh or new one, or toggle anything else.
function activateRow(ctx: NavCtx): boolean {
  const row = ctx.rows[ctx.cursor];
  if (!row) return true;
  if (row.kind === "session") ctx.open(openSession(row.session, ctx.model?.liveWindows.get(sessionName(row.session))));
  else if (row.kind === "fresh") ctx.enterFresh(row.target);
  else if (row.kind === "newsess") ctx.enterNewSession();
  else flipOpen(row, ctx);
  return true;
}

type Nav = "up" | "down" | "right" | "left" | "enter";
const VI_KEYS = new Map<string, Nav>([
  ["k", "up"],
  ["j", "down"],
  ["l", "right"],
  ["h", "left"],
]);

/** The navigation a key means — arrows and enter, or their vi letters — or null. */
export function navKeyOf(input: string, key: Key): Nav | null {
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.rightArrow) return "right";
  if (key.leftArrow) return "left";
  if (key.return) return "enter";
  return VI_KEYS.get(input) ?? null;
}

export function handleListNavKeys(input: string, key: Key, ctx: NavCtx): boolean {
  switch (navKeyOf(input, key)) {
    case "up":
      ctx.move(-1);
      return true;
    case "down":
      ctx.move(1);
      return true;
    case "right":
      return expandOrDescend(ctx);
    case "left":
      return collapseOrClimb(ctx);
    case "enter":
      return activateRow(ctx);
    default:
      return false;
  }
}
