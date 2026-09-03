import type { Key } from "ink";
import type { KeyContext, Mode } from "./context.ts";
import { editLine } from "./lineEdit.ts";
import { listStep } from "./nav.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "beginInitDir" | "beginInit">;
type InitName = Extract<Mode, { kind: "initName" }>;
type InitDir = Extract<Mode, { kind: "initDir" }>;
type InitPath = Extract<Mode, { kind: "initPath" }>;

/** Back to the name prompt with the name it had, the caret at its end. */
export function backToName(mode: InitDir | InitPath): InitName {
  return { kind: "initName", target: mode.target, agent: mode.agent, value: mode.name, cursor: mode.name.length };
}

/** Back to the list, with the cursor on the "Other path…" row the prompt was opened from. */
function backToDir(mode: InitPath): InitDir {
  return { kind: "initDir", target: mode.target, agent: mode.agent, name: mode.name, candidates: mode.candidates, cursor: mode.candidates.length };
}

/** The list cursor after a step, wrapping over the candidates plus the "Other path…" row. */
export function nextInitCursor(candidates: number, cursor: number, d: 1 | -1): number {
  const len = candidates + 1;
  return (cursor + d + len) % len;
}

// ── the folder name ──
function nameKeys(input: string, key: Key, mode: InitName, ctx: Ctx): void {
  if (key.escape) { ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 }); return; }
  if (key.return) {
    if (mode.value.trim()) ctx.beginInitDir(mode.target, mode.agent, mode.value);
    return;
  }
  ctx.setMode((p) => {
    if (p.kind !== "initName") return p;
    const r = editLine(input, key, p.value, p.cursor);
    // Any edit clears a stale error — it described the *previous* value.
    return r ? { ...p, ...r, error: undefined } : p;
  });
}

// ── the parent folder, from the list ──
// The last row is "Other path…", which opens the typed-path prompt.
function dirKeys(input: string, key: Key, mode: InitDir, ctx: Ctx): void {
  if (key.escape) { ctx.setMode(backToName(mode)); return; }
  const d = listStep(input, key);
  if (d !== null) {
    ctx.setMode((p) =>
      // Moving off a row drops its "enter again to use it" offer and its error:
      // both were about the row the cursor just left.
      p.kind === "initDir"
        ? { ...p, cursor: nextInitCursor(p.candidates.length, p.cursor, d), error: undefined, existing: undefined }
        : p,
    );
    return;
  }
  if (!key.return) return;
  const chosen = mode.candidates[mode.cursor];
  if (chosen === undefined) {
    ctx.setMode({ ...mode, kind: "initPath", value: "", cursor: 0, error: undefined, existing: undefined });
  } else {
    ctx.beginInit(mode, chosen);
  }
}

// ── the parent folder, typed ──
function pathKeys(input: string, key: Key, mode: InitPath, ctx: Ctx): void {
  if (key.escape) {
    // Back to the list when there was one; a first run (no known repos) came
    // straight from the name prompt and goes straight back to it.
    ctx.setMode(mode.candidates.length > 0 ? backToDir(mode) : backToName(mode));
    return;
  }
  if (key.return) {
    if (mode.value.trim()) ctx.beginInit(mode, mode.value);
    return;
  }
  ctx.setMode((p) => {
    if (p.kind !== "initPath") return p;
    const r = editLine(input, key, p.value, p.cursor);
    return r ? { ...p, ...r, error: undefined, existing: undefined } : p;
  });
}

// ── new local repo: name → parent folder (list, or a typed path) ──
// Three screens, one handler: they share the target/agent/name they carry and
// the two actions they call. Each owns every key while it is up.
export function handleInitKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  switch (mode.kind) {
    case "initName": nameKeys(input, key, mode, ctx); return true;
    case "initDir": dirKeys(input, key, mode, ctx); return true;
    case "initPath": pathKeys(input, key, mode, ctx); return true;
    default: return false;
  }
}
