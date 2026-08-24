import type { Key } from "ink";
import { itemKey, liveKey, prKey } from "../../model.ts";
import { openSession } from "../../launch.ts";
import { SELECTABLE, sessionExpandKey, type Row } from "../rows.ts";
import { V } from "../vocabState.ts";
import type { KeyContext, View } from "./context.ts";

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

  // new arbitrary session (sessions view only)
  if (input === "n" && ctx.view === "sessions") { ctx.enterNewSession(); return true; }

  // new ORCHESTRATOR session (sessions view only) — a session that delegates
  // every unit of work to further background sessions instead of implementing.
  // Capital O, so the lowercase `o` open-in-browser binding is untouched.
  if (input === "O" && ctx.view === "sessions") { ctx.enterOrchestrator(); return true; }

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

function handleListNavKeys(input: string, key: Key, ctx: NavCtx): boolean {
  if (key.upArrow || input === "k") { ctx.move(-1); return true; }
  if (key.downArrow || input === "j") { ctx.move(1); return true; }

  // ── expand/collapse with →/← (or l/h) ──
  const isExpandable = (row: Row) =>
    row.kind === "item" || row.kind === "pr" || row.kind === "toggle" || row.kind === "session";
  const isOpen = (row: Row) =>
    row.kind === "item" || row.kind === "pr" || row.kind === "session"
      ? row.expanded
      : row.kind === "toggle"
        ? row.open
        : false;
  const flipOpen = (row: Row) => {
    if (row.kind === "item") ctx.toggleExpand(`wi:${itemKey(row.item)}`);
    else if (row.kind === "pr") ctx.toggleExpand(`pr:${prKey(row.pr)}`);
    else if (row.kind === "toggle") ctx.toggleSection(row.id);
    else if (row.kind === "session") {
      ctx.ensureActivity(row.session); // kick off the lazy parse on first expand
      ctx.toggleExpand(sessionExpandKey(row.key));
    }
  };
  // Nesting depth: sections/groups (toggle) = 0, work items / PRs = 1, the
  // sessions & fresh rows under them = 2. Used to climb one level on ←.
  const depthOf = (row: Row) =>
    row.kind === "session" || row.kind === "fresh" ? 2 : row.kind === "item" || row.kind === "pr" ? 1 : 0;

  if (key.rightArrow || input === "l") {
    const row = ctx.rows[ctx.cursor];
    if (!row || !isExpandable(row)) return true;
    if (!isOpen(row)) { flipOpen(row); return true; } // expand
    // already open → select the first child (the row right below it)
    const child = ctx.rows[ctx.cursor + 1];
    if (child && SELECTABLE.has(child.kind)) ctx.setCursor(ctx.cursor + 1);
    return true;
  }
  if (key.leftArrow || input === "h") {
    const row = ctx.rows[ctx.cursor];
    if (!row) return true;
    // An open expandable collapses first; only once it's collapsed (or it's a
    // leaf) does ← climb to the nearest selectable ancestor one level up
    // (child → work item/PR → its section/group).
    if (isExpandable(row) && isOpen(row)) { flipOpen(row); return true; }
    const d = depthOf(row);
    for (let i = ctx.cursor - 1; i >= 0; i--) {
      if (depthOf(ctx.rows[i]) < d && SELECTABLE.has(ctx.rows[i].kind)) { ctx.setCursor(i); return true; }
    }
    return true;
  }

  if (key.return) {
    const row = ctx.rows[ctx.cursor];
    if (!row) return true;
    if (row.kind === "item") ctx.toggleExpand(`wi:${itemKey(row.item)}`);
    else if (row.kind === "pr") ctx.toggleExpand(`pr:${prKey(row.pr)}`);
    else if (row.kind === "toggle") ctx.toggleSection(row.id);
    else if (row.kind === "session") {
      ctx.open(openSession(row.session, ctx.model?.liveWindows.get(liveKey(row.session))));
    } else if (row.kind === "fresh") {
      ctx.enterFresh(row.target);
    } else if (row.kind === "newsess") {
      ctx.enterNewSession();
    }
    return true;
  }
  return false;
}
