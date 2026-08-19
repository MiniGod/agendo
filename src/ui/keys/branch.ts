import type { Key } from "ink";
import type { KeyContext } from "./context.ts";

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
  if (key.leftArrow) { edit((v, c) => ({ cursor: Math.max(0, c - 1) })); return true; }
  if (key.rightArrow) { edit((v, c) => ({ cursor: Math.min(v.length, c + 1) })); return true; }
  // Ctrl-A / Ctrl-E jump to start / end (terminals rarely send Home/End cleanly).
  if (key.ctrl && input === "a") { edit(() => ({ cursor: 0 })); return true; }
  if (key.ctrl && input === "e") { edit((v) => ({ cursor: v.length })); return true; }
  // Backspace (and Delete, which many terminals send for Backspace) removes
  // the character before the cursor.
  if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
    edit((v, c) => (c === 0 ? { cursor: 0 } : { value: v.slice(0, c - 1) + v.slice(c), cursor: c - 1 }));
    return true;
  }
  if (input && !key.ctrl && !key.meta && /^[\x20-\x7e]+$/.test(input)) {
    edit((v, c) => ({ value: v.slice(0, c) + input + v.slice(c), cursor: c + input.length }));
    return true;
  }
  return true;
}
