// Building the argv for an agent process: the autonomy flags each CLI wants, the
// resume form for an existing session, and the fresh form for a new one.
import type { AgentSession, AgentSource } from "./types.ts";
import { isOrchestratorSession, orchestratorSystemPrompt } from "./orchestrator.ts";
import { SELF_CMD, withSelfCmdEnv } from "./selfCmd.ts";
import { launcherSystemPrompt } from "./launchPrompt.ts";

/**
 * Append our system-prompt additions to a claude argv — the launcher prompt
 * always, plus the orchestrator instructions when this session runs in
 * orchestrator mode.
 *
 * Both go into a SINGLE `--append-system-prompt` value. claude's flag takes one
 * value, so passing it twice would keep only the last occurrence and silently
 * drop the other prompt.
 */
export function withLauncherPrompt(argv: string[], orchestrator = false): string[] {
  const parts = [launcherSystemPrompt()];
  if (orchestrator) parts.push(orchestratorSystemPrompt(SELF_CMD));
  return [...argv, "--append-system-prompt", parts.join("\n\n")];
}

/**
 * Claude flags that let a background session start working without stalling on
 * interactive gates:
 *  - `--permission-mode auto` runs without per-action approval prompts (auto
 *    mode degrades to acceptEdits where unavailable) — no dangerous full bypass.
 *  - `enableAllProjectMcpServers`, injected via an ephemeral `--settings` JSON
 *    string (so the repo's own settings are untouched), auto-accepts the
 *    "N new MCP servers found in this project" prompt.
 * Only applied to launcher-spawned background sessions — interactive sessions
 * the user opens/resumes themselves keep normal prompts.
 */
const AUTONOMY_ARGV = [
  "--permission-mode",
  "auto",
  "--settings",
  JSON.stringify({ enableAllProjectMcpServers: true }),
];

/**
 * Copilot equivalent of AUTONOMY_ARGV: run an unattended background session
 * without stalling on confirmation. Two flags are needed together:
 *  - `--autopilot` starts in autopilot mode (the analog of Claude's
 *    `--permission-mode auto`), so the agent plans and continues on its own
 *    (bounded by `--max-autopilot-continues`).
 *  - `--allow-all-tools` auto-approves tool calls. Without it autopilot still
 *    stalls on per-tool permission prompts and won't actually proceed, so the
 *    two MUST be paired. (`--autopilot` is shorthand for `--mode autopilot`, so
 *    that part isn't also duplicated.)
 * Scoped to launcher-spawned background sessions only.
 */
const COPILOT_AUTONOMY_ARGV = ["--autopilot", "--allow-all-tools"];

/**
 * Codex equivalent of AUTONOMY_ARGV, and the closest analogue of Claude's
 * `--permission-mode auto` that codex has: `--approve-for-me` routes each
 * approval request through codex's own automatic review instead of stopping to
 * ask, and runs it under the workspace-write sandbox (the flag implies the
 * sandbox, so `--sandbox` is not also passed). Same shape as Claude's auto mode
 * — a classifier approves what looks safe — rather than a blanket yes.
 *
 * Deliberately NOT `--ask-for-approval never`, which disables the review rather
 * than automating it, and NOT `--dangerously-bypass-approvals-and-sandbox`:
 * unattended is not the same as unsandboxed. Scoped to launcher-spawned
 * background sessions; interactive sessions keep the user's own approval mode.
 */
const CODEX_AUTONOMY_ARGV = ["--approve-for-me"];

/**
 * Whether an agent's CLI accepts a caller-chosen session id for a BRAND-NEW
 * session (`--session-id <uuid>`). Claude and Copilot do, so their fresh windows
 * embed the id we minted and every later attach/status finds the exact session.
 * Codex does not — it assigns its own thread id and only exposes it after the
 * fact (in `~/.codex/sessions/…/rollout-…-<id>.jsonl`), so a codex session is
 * attributed to its window by working directory instead. See `kindName`'s `tag`.
 */
export function preassignsSessionId(agent: AgentSource): boolean {
  return agent !== "codex";
}

/**
 * Agent CLI flags `agendo launch` may forward verbatim into a BRAND-NEW
 * session's argv. Deliberately a small allowlist rather than a `--` catch-all:
 * every forwarded token is one we know the target agent accepts, so a typo fails
 * loudly instead of silently becoming prompt text (see the launch parser).
 *
 * Each entry lists the agents that take the flag with this exact
 * `<flag> <value>` syntax — the flags are NOT symmetric across agents:
 *  - `--model <name>`: all three agents, same syntax and meaning, so it forwards
 *    straight through with no per-agent translation.
 *  - `--fallback-model <name>`: Claude only; neither Copilot nor Codex has an
 *    equivalent, so `agendo launch --copilot --fallback-model …` is rejected
 *    rather than passed to a binary that would choke on it.
 * Forwarding applies to new sessions only — `resumeArgv` never sees these.
 */
export const FORWARDABLE_LAUNCH_FLAGS: Record<string, { agents: readonly AgentSource[] }> = {
  "--model": { agents: ["claude", "copilot", "codex"] },
  "--fallback-model": { agents: ["claude"] },
};

/** argv that resumes a given session in its working directory. */
export function resumeArgv(s: AgentSession): string[] {
  switch (s.source) {
    case "claude": {
      // claude records neither `--append-system-prompt` nor `--agent` in its own
      // session state, so an orchestrator resumed cold would come back as a plain
      // session. Re-inject from our own marker file (see src/orchestrator.ts).
      const cmd = withLauncherPrompt(["claude", "--resume", s.id], isOrchestratorSession(s.id));
      // Point claude at the config dir the session lives in, so the right
      // subscription/profile (e.g. ~/.claude vs ~/.claude-work) finds it.
      return withSelfCmdEnv(cmd, s.configDir ? { CLAUDE_CONFIG_DIR: s.configDir } : {});
    }
    case "copilot":
      // Copilot CLI resumes by session id. `--resume` takes an *optional* value
      // (`-r, --resume[=value]`), so the id must be attached with `=` — a
      // space-separated `--resume <id>` would be parsed as a positional prompt,
      // not the session to resume. The tmux window is already created in the
      // session's cwd (openTarget passes `-c cwd`), and Copilot keeps all state
      // under ~/.copilot, so no extra dir wiring is needed. There's no Copilot
      // equivalent of claude's `--append-system-prompt`, so the launcher system
      // prompt is intentionally omitted for Copilot resumes — but the
      // self-command still propagates, so any agendo the session runs by hand is
      // the build that spawned it.
      return withSelfCmdEnv(["copilot", `--resume=${s.id}`]);
    case "codex":
      // `codex resume <SESSION_ID>` takes the thread UUID as a positional; the
      // bare `codex resume` would open its interactive picker instead. Codex
      // keeps all state under $CODEX_HOME (default ~/.codex) and we scan exactly
      // that home, so the child inherits the right one with no dir wiring. Like
      // Copilot, codex has no `--append-system-prompt`, so the launcher system
      // prompt is intentionally omitted — and, like Copilot, the self-command
      // still propagates so the resumed session drives the build that spawned it.
      return withSelfCmdEnv(["codex", "resume", s.id]);
  }
}

/** Options shaping a fresh-session argv (all optional; absent ⇒ omitted). */
export interface FreshArgvOptions {
  /** Pre-assigned session id, so the tmux name can embed it for later attach. */
  sessionId?: string;
  /** Initial task prompt to run on launch (interactive, not headless). */
  prompt?: string;
  /** Apply the agent's unattended-autonomy flags (background sessions only). */
  autonomy?: boolean;
  /**
   * Allowlisted agent flags to forward verbatim, already validated against the
   * agent as flat `[flag, value, …]` tokens (see `FORWARDABLE_LAUNCH_FLAGS`).
   * Each element becomes one argv token — tmux execs the argv directly, with no
   * shell in between, so values with spaces need no quoting or escaping.
   */
  forwardArgv?: string[];
  /** Run in orchestrator mode — inject the coordinate-don't-implement prompt. */
  orchestrator?: boolean;
}

/**
 * Build the argv to start a BRAND-NEW session for `agent` in a tmux window, each
 * with its initial interactive prompt and unattended-autonomy flags:
 *  - Claude: `--session-id <id>`, positional prompt, `AUTONOMY_ARGV`, plus the
 *    launcher system prompt appended so background-session coordination works.
 *  - Copilot: `--session-id <id>`, `--interactive <prompt>`,
 *    `COPILOT_AUTONOMY_ARGV`. Copilot has no `--append-system-prompt`, so the
 *    launcher prompt is omitted (background coordination is Claude-only today) —
 *    which is also why orchestrator mode is Claude-only, rejected at the entry
 *    points rather than silently degraded here.
 *  - Codex: positional prompt, `CODEX_AUTONOMY_ARGV`. Codex has no
 *    `--session-id` (see `preassignsSessionId`) — `opts.sessionId` is ignored
 *    rather than forced in — and no `--append-system-prompt`, so it is
 *    orchestrator-ineligible for the same reason copilot is.
 * Any `forwardArgv` (allowlisted flags from `agendo launch`) goes last among the
 * flags, so an explicit `--model` wins over anything the defaults might set.
 * Either way the argv is prefixed with our `env` block, so the new session
 * inherits the invocation that started it (`SELF_CMD_ENV`).
 */
export function freshArgv(agent: AgentSource, opts: FreshArgvOptions = {}): string[] {
  switch (agent) {
    case "copilot": {
      const argv = ["copilot"];
      if (opts.sessionId) argv.push("--session-id", opts.sessionId);
      if (opts.autonomy) argv.push(...COPILOT_AUTONOMY_ARGV);
      if (opts.forwardArgv?.length) argv.push(...opts.forwardArgv);
      if (opts.prompt) argv.push("--interactive", opts.prompt);
      return withSelfCmdEnv(argv);
    }
    case "codex": {
      const argv = ["codex"];
      if (opts.autonomy) argv.push(...CODEX_AUTONOMY_ARGV);
      if (opts.forwardArgv?.length) argv.push(...opts.forwardArgv);
      // Codex's prompt is a bare positional, so it must come after every flag
      // (a `[PROMPT]` before one would be read as that flag's value). The `env`
      // prefix goes on afterwards and takes the whole thing as its command, so
      // it doesn't disturb that ordering.
      if (opts.prompt) argv.push(opts.prompt);
      return withSelfCmdEnv(argv);
    }
    case "claude": {
      const argv = ["claude"];
      if (opts.sessionId) argv.push("--session-id", opts.sessionId);
      if (opts.autonomy) argv.push(...AUTONOMY_ARGV);
      if (opts.forwardArgv?.length) argv.push(...opts.forwardArgv);
      if (opts.prompt) argv.push(opts.prompt);
      return withSelfCmdEnv(withLauncherPrompt(argv, opts.orchestrator));
    }
  }
}
