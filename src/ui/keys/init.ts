import type { Key } from "ink";
import type { KeyContext } from "./context.ts";
import { editLine } from "./lineEdit.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "beginInitDir" | "beginInit">;

// ── new local repo: name → parent folder (list, or a typed path) ──
// Three screens, one handler: they share the target/agent/name they carry and
// the two actions they call. Each owns every key while it is up.
export function handleInitKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;

  // ── the folder name ──
  if (mode.kind === "initName") {
    if (key.escape) { ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 }); return true; }
    if (key.return) {
      if (mode.value.trim()) ctx.beginInitDir(mode.target, mode.agent, mode.value);
      return true;
    }
    ctx.setMode((p) => {
      if (p.kind !== "initName") return p;
      const r = editLine(input, key, p.value, p.cursor);
      // Any edit clears a stale error — it described the *previous* value.
      return r ? { ...p, ...r, error: undefined } : p;
    });
    return true;
  }

  // ── the parent folder, from the list ──
  // The last row is "Other path…", which opens the typed-path prompt.
  if (mode.kind === "initDir") {
    const len = mode.candidates.length + 1;
    if (key.escape) {
      ctx.setMode({ kind: "initName", target: mode.target, agent: mode.agent, value: mode.name, cursor: mode.name.length });
      return true;
    }
    const move = (d: 1 | -1) =>
      ctx.setMode((p) =>
        // Moving off a row drops its "enter again to use it" offer and its error:
        // both were about the row the cursor just left.
        p.kind === "initDir" ? { ...p, cursor: (p.cursor + d + len) % len, error: undefined, existing: undefined } : p,
      );
    if (key.upArrow || input === "k") { move(-1); return true; }
    if (key.downArrow || input === "j") { move(1); return true; }
    if (key.return) {
      const chosen = mode.candidates[mode.cursor];
      if (chosen === undefined) {
        ctx.setMode({ ...mode, kind: "initPath", value: "", cursor: 0, error: undefined, existing: undefined });
      } else {
        ctx.beginInit(mode, chosen);
      }
      return true;
    }
    return true;
  }

  // ── the parent folder, typed ──
  if (mode.kind === "initPath") {
    if (key.escape) {
      // Back to the list when there was one; a first run (no known repos) came
      // straight from the name prompt and goes straight back to it.
      if (mode.candidates.length > 0) {
        ctx.setMode({ kind: "initDir", target: mode.target, agent: mode.agent, name: mode.name, candidates: mode.candidates, cursor: mode.candidates.length });
      } else {
        ctx.setMode({ kind: "initName", target: mode.target, agent: mode.agent, value: mode.name, cursor: mode.name.length });
      }
      return true;
    }
    if (key.return) {
      if (mode.value.trim()) ctx.beginInit(mode, mode.value);
      return true;
    }
    ctx.setMode((p) => {
      if (p.kind !== "initPath") return p;
      const r = editLine(input, key, p.value, p.cursor);
      return r ? { ...p, ...r, error: undefined, existing: undefined } : p;
    });
    return true;
  }

  return false;
}
