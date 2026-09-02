import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";
import { applyLineEdit, lineEditFor } from "./lineEdit.ts";
import type { SearchEditFn } from "./searchEdit.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "startFresh">;
type BranchMode = Extract<Mode, { kind: "branch" }>;

/**
 * Same guard as the search prompt (see there, and clone.ts, for why an
 * ASCII-only class is the wrong test for names in this repo): printable is
 * "not a control character", and a chunk holding one is rejected whole
 * rather than stripped — search.ts spells out exactly what that does and
 * does not buy against a stray escape sequence.
 *
 * Safe for a BRANCH name specifically. Git refnames forbid control
 * characters, space and ~ ^ : ? * [ \ — but NOT letters outside ASCII, so
 * `worktree-þróun` is a perfectly legal ref while the punctuation this guard
 * has always accepted is not. That path is unchanged and already handles a
 * bad name: the value reaches git only as one argv element of a `spawnSync`
 * (`createWorktree`, src/worktree.ts), never a shell, so an invalid refname
 * fails loudly as "Worktree failed: <git's own message>" with nothing
 * created. The worktree DIRECTORY is not this string either —
 * `worktreeDirName` reduces it to letters, digits and interior dashes (a
 * hash if the name holds none), and BranchScreen previews that result live
 * under the input.
 */
export function rejectControls(input: string): string {
  return /\p{Cc}/u.test(input) ? "" : input;
}

/** The branch prompt's edits: the shared table minus ^U, which was never bound here. */
export function branchEditFor(input: string, key: Key): SearchEditFn | null {
  if (key.ctrl && input === "u") return null;
  return lineEditFor(input, key, rejectControls);
}

/**
 * The functional `setMode` update one edit makes, a no-op off the branch
 * prompt. Functional so batched keystrokes (e.g. two Lefts in one chunk) each
 * apply against the latest value/cursor instead of a stale snapshot. Whole
 * code points, not string indices — see caret.ts for what splitting a
 * surrogate pair does to the value git is handed.
 */
export function branchEdit(fn: SearchEditFn): (p: Mode) => Mode {
  return function editBranchPrompt(p: Mode): Mode {
    if (p.kind !== "branch") return p;
    return { ...p, ...applyLineEdit(fn, p.value, p.cursor) };
  };
}

// esc: back to the worktree choice for a free target, else to the repo list.
function leaveBranchPrompt(mode: BranchMode, ctx: Ctx): void {
  if (mode.target.kind === "free") {
    ctx.setMode({ kind: "wtchoice", target: mode.target, agent: mode.agent, repo: mode.repo, cursor: mode.worktree ? 0 : 1 });
    return;
  }
  ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 });
}

// ── new-branch / session name prompt — editable, with a movable cursor ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleBranchKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "branch") return false;
  if (key.escape) { leaveBranchPrompt(mode, ctx); return true; }
  if (key.return) {
    if (mode.value.trim()) ctx.startFresh(mode.target, mode.repo, mode.value, mode.worktree, mode.agent, mode.seed);
    return true;
  }
  const fn = branchEditFor(input, key);
  if (fn) ctx.setMode(branchEdit(fn));
  return true;
}
