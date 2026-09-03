import type { Key } from "ink";
import { openSession } from "../../launch.ts";
import { sessionName } from "../../tmux.ts";
import type { Row } from "../rows.ts";
import type { KeyContext, View } from "./context.ts";
import { handleListRowActionKeys, type RowActionCtx } from "./rowActions.ts";
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

const VIEW_KEYS: Record<string, View> = { "1": "items", "2": "prs", "3": "sessions" };

/** Tab / Shift-Tab cycle the views; `1` `2` `3` jump to one. */
export function handleViewSwitchKeys(input: string, key: Key, ctx: Pick<ViewCtx, "view" | "switchView">): boolean {
  if (key.tab) {
    const order: View[] = ["items", "prs", "sessions"];
    const dir = key.shift ? -1 : 1;
    const next = order[(order.indexOf(ctx.view) + dir + order.length) % order.length];
    ctx.switchView(next);
    return true;
  }
  const jump = VIEW_KEYS[input];
  if (jump) {
    ctx.switchView(jump);
    return true;
  }
  return false;
}

/**
 * `a` toggles path scope ↔ global and `f` the repo filter — only when the
 * launcher is scoped to a path: bare `agendo` is already global, so there is
 * nothing to toggle, and with no root there are no repos to narrow to. `a` =
 * "all", `f` = "filter"; the repo filter is on the work-item / PR views.
 */
export function handleScopeKeys(
  input: string,
  ctx: Pick<ViewCtx, "filterRoot" | "setCursor" | "setGlobalView" | "setRepoFilterOn">,
): boolean {
  if (!ctx.filterRoot) return false;
  if (input === "a") {
    ctx.setCursor(0);
    ctx.setGlobalView((v) => !v);
    return true;
  }
  if (input === "f") {
    ctx.setCursor(0);
    ctx.setRepoFilterOn((v) => !v);
    return true;
  }
  return false;
}

/**
 * `g` toggles repo grouping (Sessions: whole view · PRs: subgroups per section)
 * and `s` flips the sort order (PRs: created ↔ last updated, drafts staying at
 * the bottom · Sessions: updated ↔ created). Neither is bound on the items view.
 */
export function handleGroupSortKeys(
  input: string,
  ctx: Pick<ViewCtx, "view" | "setCursor" | "setGrouped" | "setPrsGrouped" | "setPrSort" | "setSessionSort">,
): boolean {
  if (ctx.view === "sessions") {
    if (input === "g") {
      ctx.setCursor(0);
      ctx.setGrouped((v) => !v);
      return true;
    }
    if (input === "s") {
      ctx.setCursor(0);
      ctx.setSessionSort((s) => (s === "updated" ? "created" : "updated"));
      return true;
    }
  }
  if (ctx.view === "prs") {
    if (input === "g") {
      ctx.setCursor(0);
      ctx.setPrsGrouped((v) => !v);
      return true;
    }
    if (input === "s") {
      ctx.setCursor(0);
      ctx.setPrSort((s) => (s === "created" ? "updated" : "created"));
      return true;
    }
  }
  return false;
}

/** `/` focuses the fuzzy search, `,` opens Settings, `u` switches who you are (Work items & PRs only). */
export function handleScreenKeys(input: string, ctx: Pick<ViewCtx, "setSearchFocus" | "enterSettings" | "enterIdentity">): boolean {
  if (input === "/") { ctx.setSearchFocus("input"); return true; }
  if (input === ",") { ctx.enterSettings(); return true; }
  if (input === "u") { ctx.enterIdentity(); return true; }
  return false;
}

/** `r`: drop the notice and every cached activity, re-walk the path context, reload. */
export function refreshList(ctx: Pick<ViewCtx, "setNotice" | "setActivity" | "requested" | "setRescanKey" | "reload">): void {
  ctx.setNotice(null);
  ctx.setActivity(new Map()); // drop cached activity so expanded sessions refetch
  ctx.requested.current.clear();
  ctx.setRescanKey((k) => k + 1); // re-walk the path context for new checkouts
  ctx.reload();
}

export function handleListViewKeys(input: string, key: Key, ctx: ViewCtx): boolean {
  if (handleViewSwitchKeys(input, key, ctx)) return true;
  if (handleScopeKeys(input, ctx)) return true;
  if (handleGroupSortKeys(input, ctx)) return true;
  if (handleSessionStartKeys(input, ctx)) return true;
  if (handleScreenKeys(input, ctx)) return true;
  if (input === "r") {
    refreshList(ctx);
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
