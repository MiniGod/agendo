import type { Key } from "ink";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "beginClone">;
type CloningCtx = Pick<KeyContext, "mode" | "cancelClone">;

// ── clone: paste a repo URL ──
// Same editable single-line input as the branch prompt (see there for why the
// updates are functional). Owns every key while it is up.
export function handleCloneKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "clone") return false;
  if (key.escape) { ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 }); return true; }
  if (key.return) {
    if (mode.value.trim()) ctx.beginClone(mode.target, mode.agent, mode.value.trim());
    return true;
  }
  const edit = (fn: (v: string, c: number) => { value?: string; cursor: number }) =>
    ctx.setMode((p) => {
      if (p.kind !== "clone") return p;
      const r = fn(p.value, p.cursor);
      // Any edit clears a stale error — it described the *previous* value.
      return { ...p, value: r.value ?? p.value, cursor: r.cursor, error: undefined };
    });
  if (key.leftArrow) { edit((v, c) => ({ cursor: Math.max(0, c - 1) })); return true; }
  if (key.rightArrow) { edit((v, c) => ({ cursor: Math.min(v.length, c + 1) })); return true; }
  if (key.ctrl && input === "a") { edit(() => ({ cursor: 0 })); return true; }
  if (key.ctrl && input === "e") { edit((v) => ({ cursor: v.length })); return true; }
  if (key.ctrl && input === "u") { edit(() => ({ value: "", cursor: 0 })); return true; }
  if (key.backspace || key.delete || input === "\x7f" || input === "\b") {
    edit((v, c) => (c === 0 ? { cursor: 0 } : { value: v.slice(0, c - 1) + v.slice(c), cursor: c - 1 }));
    return true;
  }
  // A PASTE arrives as one chunk, and copying a URL as a whole line brings
  // its trailing newline along. Ink doesn't read that chunk as Enter (the
  // `\r` isn't alone), so a printable-only guard like the branch prompt's
  // would reject the entire paste and insert nothing at all — on the one
  // prompt whose whole instruction is "paste a URL". Strip the control
  // characters and keep the rest. Deliberately NOT treated as submit: the
  // destination preview exists so no clone starts unreviewed.
  if (input && !key.ctrl && !key.meta) {
    // Only CONTROL characters are dropped — deliberately not "everything
    // outside printable ASCII". An ADO project name is routinely non-ASCII
    // (`…/innovamps/Þróun/_git/hmi-framework`, and Chrome's omnibox hands
    // that over unencoded), and stripping those letters doesn't reject the
    // URL — it quietly turns it into a *different, still valid* one
    // (`…/innovamps/run/_git/…`), which then previews a destination for a
    // repo the user never named and fails at clone time as "not found".
    // eslint-disable-next-line no-control-regex -- matching control bytes IS the job here, exactly as it was in App.tsx; .oxlintrc.json turns this rule off for App.tsx/tmux.ts but its glob list does not yet name src/ui/keys/.
    const text = input.replace(/[\x00-\x1f\x7f]+/g, "");
    if (!text) return true;
    edit((v, c) => ({ value: v.slice(0, c) + text + v.slice(c), cursor: c + text.length }));
    return true;
  }
  return true;
}

// ── clone in progress ── (esc kills git and removes the partial directory;
// everything else is ignored so a stray keystroke can't abandon the clone)
export function handleCloningKeys(_input: string, key: Key, ctx: CloningCtx): boolean {
  if (ctx.mode.kind !== "cloning") return false;
  if (key.escape) ctx.cancelClone();
  return true;
}
