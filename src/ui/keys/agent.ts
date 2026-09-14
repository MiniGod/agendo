import type { Key } from "ink";
import type { AgentSource } from "../../shared/types.ts";
import type { FreshTarget } from "../models/targets.ts";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "setCloneNote" | "cloneNoteRef" | "proceedFresh">;

/** Every agent the fresh-session picker can offer, in display order. */
export const AGENT_CHOICES: { source: AgentSource; label: string; desc: string }[] = [
  { source: "claude", label: "Claude", desc: "claude --session-id …" },
  { source: "copilot", label: "Copilot", desc: "copilot --session-id …" },
  { source: "codex", label: "Codex", desc: "codex … (assigns its own session id)" },
];

/**
 * The choices actually offered for `target` — every agent, unless it is an
 * orchestrator target, which drops Copilot: orchestrator mode rides on a
 * system-prompt injection Copilot has no equivalent for (see
 * `orchestratorAgentClash`), so offering it here would let the picker promise
 * something the launch itself refuses.
 */
export function agentChoicesFor(target: Pick<FreshTarget, "orchestrator">): typeof AGENT_CHOICES {
  return target.orchestrator ? AGENT_CHOICES.filter((a) => a.source !== "copilot") : AGENT_CHOICES;
}

// ── agent picker (first step of every fresh flow) ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleAgentKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "agent") return false;
  const choices = agentChoicesFor(mode.target);
  const len = choices.length;
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
  if (key.return) { ctx.proceedFresh(mode.target, choices[mode.cursor].source); return true; }
  return true;
}
