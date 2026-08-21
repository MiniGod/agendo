import type { Key } from "ink";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<
  KeyContext,
  "mode" | "setMode" | "reposForTarget" | "canClone" | "setCloneNote" | "cloneNoteRef" | "chooseRepo"
>;

/**
 * Cursor value for the repo picker's "＋ Clone from URL…" row. A sentinel rather
 * than `repos.length`, so a background rescan that grows the repo list can't
 * slide the cursor off it onto a real repo.
 */
export const CLONE_ROW = -1;

// ── repo picker ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleRepoKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "repo") return false;
  const repos = ctx.reposForTarget(mode.target);
  const len = repos.length || 1;
  const openClone = () =>
    ctx.setMode({ kind: "clone", target: mode.target, agent: mode.agent, value: "", cursor: 0 });
  // The clone row is rendered last but addressed by a SENTINEL, never by
  // `repos.length`: the background rescan replaces `model.repos` while the
  // picker is open (a sibling session starting in a new repo grows the list),
  // and a positional index would slide off the clone row onto whatever repo
  // took its place — enter would then launch a session instead of cloning.
  const onClone = mode.cursor === CLONE_ROW;
  // ↑/↓ treat the clone row as one past the end, wrapping through it.
  const move = (d: 1 | -1) =>
    ctx.setMode((p) => {
      if (p.kind !== "repo") return p;
      if (!ctx.canClone) return { ...p, cursor: (p.cursor + d + len) % len };
      if (p.cursor === CLONE_ROW) return { ...p, cursor: d === 1 ? 0 : len - 1 };
      const next = p.cursor + d;
      return { ...p, cursor: next < 0 || next >= len ? CLONE_ROW : next };
    });
  // The orchestrator flow entered here directly (no agent step to go back to),
  // which makes THIS the last exit out of the fresh flow for it — so it also
  // takes on the agent step's job of dropping an unconsumed clone note. Without
  // that, escaping out after a clone and then resuming some existing session
  // would prefix that launch with "✓ cloned …", crediting it to a clone it had
  // nothing to do with (same failure the agent-mode escape guards against).
  if (key.escape) {
    if (mode.target.orchestrator) {
      ctx.setCloneNote(null);
      ctx.cloneNoteRef.current = null;
      ctx.setMode({ kind: "list" });
      return true;
    }
    ctx.setMode({ kind: "agent", target: mode.target, cursor: 0 });
    return true;
  }
  if (key.upArrow || input === "k") { move(-1); return true; }
  if (key.downArrow || input === "j") { move(1); return true; }
  if (input === "c" && ctx.canClone) { openClone(); return true; }
  if (key.return && onClone && ctx.canClone) { openClone(); return true; }
  if (key.return && repos[mode.cursor]) {
    // Picking a repo off the list is not the result of a clone. Without
    // this, backing out of the post-clone flow and choosing a different repo
    // would carry "✓ cloned ada/newthing…" onto a dialog about another one.
    ctx.setCloneNote(null);
    ctx.cloneNoteRef.current = null;
    ctx.chooseRepo(mode.target, repos[mode.cursor], mode.agent);
    return true;
  }
  return true;
}
