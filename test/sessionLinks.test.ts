// The instruction to name a session as an agendo:// link, wherever an agent is
// told how to report sessions: the `--llm` guide and both orchestrator prompts.
// Asserted on the text after the command prefix only — that prefix differs
// between a local checkout and CI.
import { describe, expect, test } from "bun:test";
import { llmGuide } from "../src/launch/index.ts";
import { orchestratorSystemPrompt } from "../src/orchestration/index.ts";
import { globalOrchestratorSystemPrompt } from "../src/orchestration/global.ts";

const LINK = "[<window name or short id>](agendo://focus?session=<short id>)";
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("session links", () => {
  test("--llm says to link a mentioned session, and what clicking one needs", () => {
    const g = flat(llmGuide());
    expect(g).toContain(LINK);
    expect(g).toContain("Whenever you mention a session to the user");
    expect(g).toContain(" url-handler install`");
    expect(g).toContain("`set -as terminal-features 'xterm*:hyperlinks'`");
  });

  test("both orchestrator prompts say it too, with the codex case, and point at --llm for the rest", () => {
    for (const p of [orchestratorSystemPrompt("x", "claude"), globalOrchestratorSystemPrompt("x", "claude")]) {
      expect(flat(p)).toContain(LINK);
      expect(flat(p)).toContain("`x --llm` has the rest");
      expect(flat(p)).toContain("A codex session with no id yet: use the `link:` line");
    }
  });
});
