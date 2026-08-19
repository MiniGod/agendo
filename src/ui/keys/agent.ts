import type { Key } from "ink";
import type { AgentSource } from "../../types.ts";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "setCloneNote" | "cloneNoteRef" | "proceedFresh">;

/** Agents offered by the fresh-session picker, in display order. */
export const AGENT_CHOICES: { source: AgentSource; label: string; desc: string }[] = [
  { source: "claude", label: "Claude", desc: "claude --session-id …" },
  { source: "copilot", label: "Copilot", desc: "copilot --session-id …" },
  { source: "codex", label: "Codex", desc: "codex … (assigns its own session id)" },
];

// ── agent picker (first step of every fresh flow) ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleAgentKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "agent") return false;
  const len = AGENT_CHOICES.length;
  if (key.escape) {
    // Last exit from the fresh flow, so it's where an unconsumed clone note
    // dies. Escaping all the way out (wtchoice → repo → agent → list) and
    // then resuming some existing session would otherwise prefix that
    // launch with "✓ cloned …", crediting it to an unrelated clone.
    ctx.setCloneNote(null);
    ctx.cloneNoteRef.current = null;
    ctx.setMode({ kind: "list" });
    return true;
  }
  if (key.upArrow || input === "k") {
    ctx.setMode((p) => (p.kind === "agent" ? { ...p, cursor: (p.cursor - 1 + len) % len } : p));
    return true;
  }
  if (key.downArrow || input === "j") {
    ctx.setMode((p) => (p.kind === "agent" ? { ...p, cursor: (p.cursor + 1) % len } : p));
    return true;
  }
  if (key.return) { ctx.proceedFresh(mode.target, AGENT_CHOICES[mode.cursor].source); return true; }
  return true;
}
