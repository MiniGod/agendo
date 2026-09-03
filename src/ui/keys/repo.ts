import type { Key } from "ink";
import type { RepoInfo } from "../../repos.ts";
import type { Mode, KeyContext } from "./context.ts";

type Ctx = Pick<
  KeyContext,
  "mode" | "setMode" | "reposForTarget" | "canClone" | "setCloneNote" | "cloneNoteRef" | "chooseRepo"
>;
type RepoMode = Extract<Mode, { kind: "repo" }>;

/**
 * Cursor value for the repo picker's "＋ Clone from URL…" row. A sentinel rather
 * than `repos.length`, so a background rescan that grows the repo list can't
 * slide the cursor off it onto a real repo.
 */
export const CLONE_ROW = -1;
/** Same, for the "＋ New local repo…" row that renders after it. */
export const INIT_ROW = -2;

/** What a key does in the repo picker; `none` is swallowed, since the picker owns every key. */
export type RepoAction = "back" | "up" | "down" | "clone" | "init" | "choose" | "none";

/** The enter key's meaning depends on the row: an action row, a repo, or nothing (an empty list). */
function repoEnterAction(cursor: number, canClone: boolean, onRepo: boolean): RepoAction {
  if (cursor === CLONE_ROW && canClone) return "clone";
  if (cursor === INIT_ROW) return "init";
  return onRepo ? "choose" : "none";
}

/** Escape and the two cursor keys, which mean the same on every row; null for anything else. */
function repoNavAction(input: string, key: Key): RepoAction | null {
  if (key.escape) return "back";
  if (key.upArrow || input === "k") return "up";
  if (key.downArrow || input === "j") return "down";
  return null;
}

/** The action a key names, for a cursor on `cursor` with `onRepo` saying whether a repo sits there. */
export function repoAction(input: string, key: Key, cursor: number, canClone: boolean, onRepo: boolean): RepoAction {
  const nav = repoNavAction(input, key);
  if (nav !== null) return nav;
  if (input === "c" && canClone) return "clone";
  if (input === "i") return "init";
  return key.return ? repoEnterAction(cursor, canClone, onRepo) : "none";
}

/**
 * The rows ↑/↓ walk, in order, wrapping through: the repos, then the clone row
 * (only when cloning is on offer), then the new-repo row (always). The action
 * rows are rendered last but addressed by SENTINELS, never by `repos.length`:
 * the background rescan replaces `model.repos` while the picker is open (a
 * sibling session starting in a new repo grows the list), and a positional
 * index would slide off an action row onto whatever repo took its place —
 * enter would then launch a session instead of cloning.
 */
export function repoOrder(repoCount: number, canClone: boolean): number[] {
  const len = repoCount || 1;
  return [...Array.from({ length: len }, (_, i) => i), ...(canClone ? [CLONE_ROW] : []), INIT_ROW];
}

/** The cursor one step along `order` from `cursor`, wrapping; an unknown cursor steps from the top. */
export function nextRepoCursor(order: number[], cursor: number, d: 1 | -1): number {
  const at = Math.max(0, order.indexOf(cursor));
  return order[(at + d + order.length) % order.length];
}

function moveRepoCursor(ctx: Ctx, repoCount: number, d: 1 | -1): void {
  const order = repoOrder(repoCount, ctx.canClone);
  ctx.setMode((p) => (p.kind === "repo" ? { ...p, cursor: nextRepoCursor(order, p.cursor, d) } : p));
}
function moveUp(ctx: Ctx, _mode: RepoMode, repos: RepoInfo[]): void {
  moveRepoCursor(ctx, repos.length, -1);
}
function moveDown(ctx: Ctx, _mode: RepoMode, repos: RepoInfo[]): void {
  moveRepoCursor(ctx, repos.length, 1);
}

/** Open the clone prompt or the new-repo name prompt for the picker's target and agent. */
function openClone(ctx: Ctx, mode: RepoMode): void {
  ctx.setMode({ kind: "clone", target: mode.target, agent: mode.agent, value: "", cursor: 0 });
}
function openInit(ctx: Ctx, mode: RepoMode): void {
  ctx.setMode({ kind: "initName", target: mode.target, agent: mode.agent, value: "", cursor: 0 });
}

/**
 * Escape. The orchestrator flow entered here directly (no agent step to go back
 * to), which makes THIS the last exit out of the fresh flow for it — so it also
 * takes on the agent step's job of dropping an unconsumed clone note. Without
 * that, escaping out after a clone and then resuming some existing session
 * would prefix that launch with "✓ cloned …", crediting it to a clone it had
 * nothing to do with (same failure the agent-mode escape guards against).
 */
function backFromRepo(ctx: Ctx, mode: RepoMode): void {
  if (!mode.target.orchestrator) {
    ctx.setMode({ kind: "agent", target: mode.target, cursor: 0 });
    return;
  }
  ctx.setCloneNote(null);
  ctx.cloneNoteRef.current = null;
  ctx.setMode({ kind: "list" });
}

/**
 * Picking a repo off the list is not the result of a clone. Without this,
 * backing out of the post-clone flow and choosing a different repo would carry
 * "✓ cloned ada/newthing…" onto a dialog about another one.
 */
function chooseRepoRow(ctx: Ctx, mode: RepoMode, repos: RepoInfo[]): void {
  const repo = repos[mode.cursor];
  if (!repo) return;
  ctx.setCloneNote(null);
  ctx.cloneNoteRef.current = null;
  ctx.chooseRepo(mode.target, repo, mode.agent);
}

const RUN: Record<Exclude<RepoAction, "none">, (ctx: Ctx, mode: RepoMode, repos: RepoInfo[]) => void> = {
  back: backFromRepo, up: moveUp, down: moveDown, clone: openClone, init: openInit, choose: chooseRepoRow,
};

// ── repo picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleRepoKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "repo") return false;
  const repos = ctx.reposForTarget(mode.target);
  const action = repoAction(input, key, mode.cursor, ctx.canClone, repos[mode.cursor] !== undefined);
  if (action !== "none") RUN[action](ctx, mode, repos);
  return true;
}
