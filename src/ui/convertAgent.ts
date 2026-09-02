import { messageOf } from "../errors.ts";
import { openSession, type OpenPlan } from "../launch.ts";
import { isOrchestratorSession } from "../orchestrator.ts";
import { convertTarget, runConvert, type ConvertDirection, type ConvertResult } from "./convert.ts";
import type { AgentSession, AgentSource } from "../types.ts";
import type { Mode } from "./keys/context.ts";

/** Either why a session cannot be converted, or where it goes. */
export type ConvertPlan = { refusal: string } | { dest: AgentSource; direction: ConvertDirection };

/**
 * Decide whether `s` can be converted and to what. Pure apart from the
 * orchestrator lookup, which is injectable so the refusal can be tested
 * without a `~/.agendo` on disk.
 */
export function planConvert(
  s: Pick<AgentSession, "id" | "source">,
  isOrchestrator: (id: string) => boolean = isOrchestratorSession,
): ConvertPlan {
  const dest = convertTarget(s.source);
  if (!dest) return { refusal: `No cross-agent convert for ${s.source} sessions (the converter only speaks Claude↔Copilot).` };
  // Copilot has no `--append-system-prompt` equivalent, so converting an
  // orchestrator to it would produce a session with none of the coordinate-
  // don't-implement instructions — an "orchestrator" that just starts editing.
  // Refuse, the way `launch --orchestrator --copilot` does on the CLI.
  if (dest === "copilot" && isOrchestrator(s.id)) {
    return { refusal: "That's an orchestrator session — Copilot can't carry the orchestrator instructions, so it won't convert." };
  }
  return { dest, direction: s.source === "claude" ? "claude-to-copilot" : "copilot-to-claude" };
}

/**
 * The session to resume once the converter has written it. Claude→Copilot
 * keeps the source cwd (the converter copies it but omits it from JSON);
 * Copilot→Claude takes the cwd the converter reports. The new claude session
 * lands in the default ~/.claude config dir (where the converter writes), so
 * no configDir override is needed for resume.
 */
export function convertedSession(s: AgentSession, dest: AgentSource, res: ConvertResult): AgentSession {
  return {
    id: res.id,
    source: dest,
    cwd: res.cwd ?? s.cwd,
    branch: s.branch,
    repository: dest === "copilot" ? s.repository : undefined,
    title: s.title,
    lastUsed: new Date(),
  };
}

/**
 * Convert a session to the other agent and resume it. Lifted out of App; it is
 * a plain async closure with no React shape of its own, so moving it cannot
 * affect hook or effect order. The decisions live in `planConvert` and
 * `convertedSession`; what is left here is the busy/notice choreography.
 */
export function makeContinueInOtherAgent({
  open,
  setMode,
  setNotice,
  setBusy,
}: {
  open: (plan: OpenPlan) => void;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
  setBusy: (b: string | null) => void;
}) {
  const continueInOtherAgent = async (s: AgentSession) => {
    const plan = planConvert(s);
    if ("refusal" in plan) {
      setNotice(plan.refusal);
      return;
    }
    setNotice(null);
    setBusy(`Converting session to ${plan.dest} (npx converter)…`);
    try {
      const res = await runConvert(plan.direction, s.id);
      setBusy(null);
      setMode({ kind: "list" });
      open(openSession(convertedSession(s, plan.dest, res)));
    } catch (e) {
      setBusy(null);
      setMode({ kind: "list" });
      setNotice(`Convert to ${plan.dest} failed: ${messageOf(e)}`);
    }
  };

  return continueInOtherAgent;
}
