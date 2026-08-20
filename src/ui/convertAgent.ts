import { openSession, type OpenPlan } from "../launch.ts";
import { isOrchestratorSession } from "../orchestrator.ts";
import { convertTarget, runConvert } from "./convert.ts";
import type { AgentSession } from "../types.ts";
import type { Mode } from "./keys/context.ts";

/**
 * Convert a session to the other agent and resume it. Lifted out of App
 * unchanged; it is a plain async closure with no React shape of its own, so
 * moving it cannot affect hook or effect order.
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
  // Convert a session's transcript into the other agent's format (via the
  // external converter) and resume the resulting session. Claude→Copilot keeps
  // the source cwd (the converter copies it but omits it from JSON); Copilot→
  // Claude takes the cwd the converter reports. The new claude session lands in
  // the default ~/.claude config dir (where the converter writes), so no
  // configDir override is needed for resume.
  const continueInOtherAgent = async (s: AgentSession) => {
    const dest = convertTarget(s.source);
    if (!dest) {
      setNotice(`No cross-agent convert for ${s.source} sessions (the converter only speaks Claude↔Copilot).`);
      return;
    }
    // Copilot has no `--append-system-prompt` equivalent, so converting an
    // orchestrator to it would produce a session with none of the coordinate-
    // don't-implement instructions — an "orchestrator" that just starts editing.
    // Refuse, the way `launch --orchestrator --copilot` does on the CLI.
    if (dest === "copilot" && isOrchestratorSession(s.id)) {
      setNotice("That's an orchestrator session — Copilot can't carry the orchestrator instructions, so it won't convert.");
      return;
    }
    const direction = s.source === "claude" ? "claude-to-copilot" : "copilot-to-claude";
    setNotice(null);
    setBusy(`Converting session to ${dest} (npx converter)…`);
    try {
      const res = await runConvert(direction, s.id);
      const converted: AgentSession = {
        id: res.id,
        source: dest,
        cwd: res.cwd ?? s.cwd,
        branch: s.branch,
        repository: dest === "copilot" ? s.repository : undefined,
        title: s.title,
        lastUsed: new Date(),
      };
      setBusy(null);
      setMode({ kind: "list" });
      open(openSession(converted));
    } catch (e: any) {
      setBusy(null);
      setMode({ kind: "list" });
      setNotice(`Convert to ${dest} failed: ${e?.message ?? e}`);
    }
  };

  return continueInOtherAgent;
}
