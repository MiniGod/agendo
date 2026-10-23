// Both orchestrator prompts tell the orchestrator to watch its launches through
// cheap read-only sub-agents on its agent's smallest model. Asserted on prose
// only, never on the command prefix — that prefix differs between a local
// checkout and CI.
import { describe, expect, test } from "bun:test";
import { orchestratorSystemPrompt } from "../src/orchestration/index.ts";
import { globalOrchestratorSystemPrompt } from "../src/orchestration/global.ts";

const flat = (s: string) => s.replace(/\s+/g, " ");

/** Just the two monitor bullets, found inside the section `heading` opens. */
const monitorBullets = (s: string, heading: string) => {
  const sec = s.indexOf(heading);
  expect(sec).toBeGreaterThanOrEqual(0);
  const from = s.indexOf("- Watch through", sec);
  const next = s.indexOf("\n## ", sec + heading.length);
  expect(from).toBeGreaterThan(sec);
  if (next >= 0) expect(from).toBeLessThan(next);
  const last = s.indexOf("- When a monitor returns", from);
  const ends = [s.indexOf("\n- ", last), s.indexOf("\n\n", last)].filter((i) => i >= 0);
  return flat(s.slice(from, Math.min(...ends)));
};

const LEVELS = [
  ["repo", orchestratorSystemPrompt, "## Monitor and coordinate through the launcher", "branch ready, review clean"],
  ["global", globalOrchestratorSystemPrompt, "## Aggregate status", "goal delivered or a wave landed"],
] as const;

const CONTRACT = [
  "READ-ONLY",
  "that is what `--llm`'s \"DON'T poll\" means",
  "x status <id> x list",
  "Spawn one right after each launch, `send` or `resume` (or one per wave",
  "read `status <id>` yourself before acting on it",
  "No git, tmux, builds or tests; it never `send`s to",
  "asks a question or for a shared resource, becomes blocked or usage-limited",
  "window is gone, crashed or paused",
  'after about an hour, reporting "still running"',
  "a codex launch prints no id yet: look it up in `list` as `launch` says",
  "only a changed one counts as work done — an old one (after a `send`, or on a resume dialog) does not",
  "re-spawn one for whatever it watched that is still in flight",
  '"still running" or the rest of its wave; a usage-limited one only once',
  "hint, not the verdict",
];

describe("orchestrator monitoring", () => {
  for (const [level, build, heading, done] of LEVELS) {
    test(`${level} prompt monitors through read-only haiku sub-agents`, () => {
      const m = monitorBullets(build("x", "claude"), heading);
      expect(m).toContain('Agent tool, model "haiku", run in the background');
      expect(m).toContain("Monitor tool (it expires within 30 minutes, so re-arm it)");
      expect(m).toContain("or a background shell until-loop — never a foreground `sleep`");
      for (const rule of [...CONTRACT, done]) expect(m).toContain(rule);
    });

    test(`${level} prompt puts a codex orchestrator's monitors on luna, same contract`, () => {
      const m = monitorBullets(build("x", "codex"), heading);
      expect(m).toContain('sub-agent on model "luna"');
      expect(m).toContain("waits in between however your sub-agents can without blocking you");
      expect(m).not.toContain("haiku");
      expect(m).not.toContain("Monitor tool");
      for (const rule of [...CONTRACT, done]) expect(m).toContain(rule);
    });
  }
});
