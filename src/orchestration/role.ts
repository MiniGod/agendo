// `OrchestratorRole` on its own so both index.ts (id-keyed marking, for agents
// that get a caller-chosen session id) and cwdMarks.ts (cwd-keyed marking, for
// Codex, which assigns its own) can import the type without one depending on
// the other (`import/no-cycle` is a hard error here).

/**
 * Which level of the coordination hierarchy a session sits at:
 *
 *     global orchestrator  →  per-repo orchestrators  →  per-worktree sessions
 *
 * `"repo"` coordinates the sessions of ONE repository and integrates their
 * branches; `"global"` coordinates the repo orchestrators themselves and touches
 * no repository at all (see src/orchestration/global.ts).
 */
export type OrchestratorRole = "repo" | "global";
