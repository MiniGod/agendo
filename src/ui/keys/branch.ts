import type { Key } from "ink";
import type { KeyContext } from "./context.ts";
import { caretLeft, caretRight } from "./caret.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "startFresh">;

// ── new-branch / session name prompt — editable, with a movable cursor ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleBranchKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "branch") return false;
  if (key.escape) {
    if (mode.target.kind === "free") { ctx.setMode({ kind: "wtchoice", target: mode.target, agent: mode.agent, repo: mode.repo, cursor: mode.worktree ? 0 : 1 }); return true; }
    ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 });
    return true;
  }
  if (key.return) {
    if (mode.value.trim()) ctx.startFresh(mode.target, mode.repo, mode.value, mode.worktree, mode.agent, mode.seed);
    return true;
  }
  // Functional updates so batched keystrokes (e.g. two Lefts in one chunk)
  // each apply against the latest value/cursor instead of a stale snapshot.
  const edit = (fn: (v: string, c: number) => { value?: string; cursor: number }) =>
    ctx.setMode((p) => {
      if (p.kind !== "branch") return p;
      const r = fn(p.value, p.cursor);
      return { ...p, value: r.value ?? p.value, cursor: r.cursor };
    });
  // Whole code points, not string indices — see caret.ts for what splitting a
  // surrogate pair does to the value git is handed.
  if (key.leftArrow) { edit((v, c) => ({ cursor: caretLeft(v, c) })); return true; }
  if (key.rightArrow) { edit((v, c) => ({ cursor: caretRight(v, c) })); return true; }
  // Ctrl-A / Ctrl-E jump to start / end (terminals rarely send Home/End cleanly).
  if (key.ctrl && input === "a") { edit(() => ({ cursor: 0 })); return true; }
  if (key.ctrl && input === "e") { edit((v) => ({ cursor: v.length })); return true; }
  // Backspace (and Delete, which many terminals send for Backspace) removes
  // the whole character before the cursor — both halves of a surrogate pair.
  if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
    edit((v, c) => {
      if (c === 0) return { cursor: 0 };
      const i = caretLeft(v, c);
      return { value: v.slice(0, i) + v.slice(c), cursor: i };
    });
    return true;
  }
  // Same guard as the search prompt (see there, and clone.ts, for why an
  // ASCII-only class is the wrong test for names in this repo): printable is
  // "not a control character", and a chunk holding one is rejected whole
  // rather than stripped — search.ts spells out exactly what that does and
  // does not buy against a stray escape sequence.
  //
  // Safe for a BRANCH name specifically. Git refnames forbid control
  // characters, space and ~ ^ : ? * [ \ — but NOT letters outside ASCII, so
  // `worktree-þróun` is a perfectly legal ref while the punctuation this guard
  // has always accepted is not. That path is unchanged and already handles a
  // bad name: the value reaches git only as one argv element of a `spawnSync`
  // (`createWorktree`, src/worktree.ts), never a shell, so an invalid refname
  // fails loudly as "Worktree failed: <git's own message>" with nothing
  // created. The worktree DIRECTORY is not this string either —
  // `worktreeDirName` reduces it to letters, digits and interior dashes (a
  // hash if the name holds none), and BranchScreen previews that result live
  // under the input.
  if (input && !key.ctrl && !key.meta && !/\p{Cc}/u.test(input)) {
    edit((v, c) => ({ value: v.slice(0, c) + input + v.slice(c), cursor: c + input.length }));
    return true;
  }
  return true;
}
