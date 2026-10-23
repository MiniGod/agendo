// How an orchestrator watches what it launched without spending its own turns on
// it: a cheap background sub-agent per launch (or per wave) that reads the
// launcher read-only and returns on the first thing worth waking up for.
//
// Shared by both orchestrator prompts, so it lives in neither of their modules.
import type { AgentSource } from "../shared/types.ts";

/**
 * Which sub-agent to spawn and how it waits, per orchestrator agent — data
 * rather than branches. Claude Code blocks a foreground `sleep` in a sub-agent
 * and its Monitor tool expires within 30 minutes, hence the re-arm. (Copilot
 * can't run orchestrator mode; its entry only keeps the record total.)
 */
const MONITOR_BY_AGENT: Record<AgentSource, { how: string; wait: string[] }> = {
  claude: {
    how: 'Claude Code\'s Agent tool, model "haiku", run in the background',
    wait: [
      "  and waits in between with the Monitor tool (it expires within 30 minutes, so",
      "  re-arm it) or a background shell until-loop — never a foreground `sleep`.",
    ],
  },
  codex: {
    how: 'a background sub-agent on model "luna"',
    wait: ["  and waits in between however your sub-agents can without blocking you."],
  },
  copilot: {
    how: "a background sub-agent on your smallest model",
    wait: ["  and waits in between however your sub-agents can without blocking you."],
  },
};

/** What is being watched, and what "finished" looks like for it. */
export interface MonitorTarget {
  what: string;
  done: string;
}

/**
 * Prompt bullets for monitoring through cheap background sub-agents. `selfCmd`
 * is the launcher's own invocation and `agent` the orchestrator's own agent.
 * Interpolations sit on lines short enough that their varying length can't rag
 * the prose.
 */
export function monitorSubagentLines(selfCmd: string, agent: AgentSource, t: MonitorTarget): string[] {
  const m = MONITOR_BY_AGENT[agent];
  return [
    "- Watch through cheap monitor sub-agents, not by polling in your own main thread",
    "  or an ad-hoc shell loop — that is what `--llm`'s \"DON'T poll\" means; a cheap",
    "  monitor checking on a cadence is the sanctioned exception:",
    `  ${m.how}.`,
    "  Spawn one right after each launch, `send` or `resume` (or one per wave covering",
    `  several), unless one is already watching that ${t.what}.`,
    "  Brief it: READ-ONLY — every few minutes it checks",
    `      ${selfCmd} status <id>`,
    `      ${selfCmd} list`,
    "  (a codex launch prints no id yet: look it up in `list` as `launch` says, and brief",
    "  the monitor with the id)",
    ...m.wait,
    "  It notes the final response it starts with: only a changed one counts as work",
    "  done — an old one (after a `send`, or on a resume dialog) does not.",
    `  No git, tmux, builds or tests; it never \`send\`s to or changes the ${t.what}.`,
    `  It returns as soon as the ${t.what}`,
    `  ${t.done},`,
    "  asks a question or for a shared resource, becomes blocked or usage-limited, or",
    "  its window is gone, crashed or paused — reporting the trigger and the watched",
    `  ${t.what}'s final response — or after about an hour,`,
    '  reporting "still running".',
    "- When a monitor returns, re-spawn one for whatever it watched that is still in",
    '  flight — "still running" or the rest of its wave; a usage-limited one only once',
    "  the reset time `status` prints has passed. Its summary is a hint, not the",
    "  verdict: read `status <id>` yourself before acting on it.",
  ];
}
