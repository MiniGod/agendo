// Orchestrates "open this session". Inside tmux, agents run as windows in the
// current session (so picking one opens a new tab next to you); outside tmux,
// each runs as its own detached session we attach to.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import type { AgentSession, AgentSource } from "./types.ts";
import {
  sessionName,
  shortId,
  kindName,
  liveTargetForShortId,
  hasSession,
  newDetached,
  newWindow,
  windowLocation,
  insideTmux,
  tmuxQuiet,
} from "./tmux.ts";
import { slugify, createWorktree, freeWorktreeBranch } from "./worktree.ts";
import { repoRootForCwd } from "./repos.ts";
import {
  ORCHESTRATOR_SLUG,
  isOrchestratorSession,
  markOrchestratorSession,
  orchestratorSystemPrompt,
} from "./orchestrator.ts";

/** Is `cmd` resolvable as an executable on the current PATH? */
function onPath(cmd: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, cmd)));
}

/** The npm/bun binary name this package installs. */
const BIN = "agendo";

/**
 * Environment variable carrying the launcher's own invocation into every session
 * it spawns (and on into the sessions THOSE spawn). A chain of sessions therefore
 * all drives the same build — the one the human started the chain with.
 *
 * Propagating beats leaving each process to work it out for itself. What survives
 * of the original invocation is thin and runner-specific (`bunx` happens to leave
 * its spec in `npm_lifecycle_script`; `npx` leaves only the bin name), and it is
 * inherited indiscriminately, so a process that merely DESCENDS from a runner looks
 * exactly like one the runner started. Nor does the environment travel by itself:
 * a session's window is spawned by the tmux SERVER, which has whatever environment
 * it was started with, not ours — hence an explicit `env` prefix on the argv.
 *
 * Getting it wrong is worse than a version mismatch: a session launched from a PR
 * build would read its `--llm` instructions from — and run every list/send/wait/
 * close through — the published release, against on-disk state this build wrote.
 */
export const SELF_CMD_ENV = "AGENDO_SELF_CMD";

/**
 * The literal package-runner spec this process was started from, if the runner
 * exposes one. Measured against bun 1.3 / npm 11 rather than assumed:
 *
 *  - `bunx <spec>` sets `npm_lifecycle_script` to the spec EXACTLY as typed —
 *    `github:minigod/agendo#HEAD`, `agendo@0.1.0`, a bare `agendo`. That is the
 *    one string that reproduces this build, so it is what we reuse.
 *  - `npx <spec>` sets it to the resolved command line instead (`"agendo"`,
 *    quoted, with any arguments), which names the bin, not the spec — the
 *    original is simply not recoverable there. Callers fall back to argv.
 *
 * Two guards, because the variable is INHERITED by every child process: a spec
 * left behind by an unrelated runner further up the tree must not be adopted as
 * ours. npm's command form is rejected by its whitespace/quotes, and any spec
 * that doesn't name this package is rejected outright.
 */
function runnerSpec(): string | null {
  const script = (process.env.npm_lifecycle_script ?? "").trim();
  if (!script || /[\s"']/.test(script)) return null;
  return script.includes(BIN) ? script : null;
}

/**
 * `argv[1]` when it sits inside a package runner's own cache — `bunx`'s
 * `/tmp/bunx-<uid>-<pkg>@…/` staging dir or npm's `<cache>/_npx/<hash>/`. Verified
 * against bun 1.3 / npm 11; any other layout simply falls through to the ordinary
 * argv branch below, which names the same build anyway.
 *
 * This is also what says we are REALLY running under a runner, which the
 * environment alone cannot: `npm_config_user_agent` and `npm_lifecycle_script` are
 * inherited by every descendant, so a plain `agendo` (or a `bun run src/index.tsx`)
 * started from a shell inside a bunx-launched session sees both and would otherwise
 * claim to be a build it is not.
 */
function runnerCacheArgv(): string | null {
  const argv1 = process.argv[1] ?? "";
  return /(^|\/)(bunx-[^/]*|_npx)\//.test(argv1) ? argv1 : null;
}

/**
 * How to re-invoke this launcher from a shell when nothing was propagated to us —
 * someone ran `agendo` themselves. Injected into agent prompts, so it must keep
 * working minutes/hours later, not just at spawn time:
 *
 *  1. Running out of a package runner's cache (`npx`, `bunx`/`bun x`): reuse the
 *     literal spec the runner was handed when it exposes one (`runnerSpec`) — that
 *     is the only form that reproduces a non-default build such as
 *     `github:owner/agendo#pull/8/head`. `npm_config_user_agent` names the runner
 *     to prefix it with; check bun first, as its user-agent also contains a bare
 *     `npm/?`, so match npm only when followed by a digit. With no spec (npx never
 *     exposes one) fall back to the cached copy itself: a bare `npx agendo` would
 *     re-resolve the PUBLISHED package instead of the one running.
 *  2. Otherwise `argv[1]` is a stable location. If a global install (`npm i -g`,
 *     `bun add -g`, pnpm, …) put `agendo` on PATH, the bare name is the cleanest
 *     invocation — no absolute path baked in. Otherwise fall back to the literal
 *     argv (covers `bun run src/index.tsx` dev and odd layouts).
 */
function derivedSelfCmd(): string {
  const cached = runnerCacheArgv();
  if (cached) {
    const ua = process.env.npm_config_user_agent ?? "";
    const runner = /\bbun\//i.test(ua) ? "bunx" : /\bnpm\/\d/i.test(ua) ? "npx" : null;
    const spec = runnerSpec();
    if (runner && spec) return `${runner} ${spec}`;
    return `${process.argv[0]} ${cached}`;
  }
  if (onPath(BIN)) return BIN;
  const argv1 = process.argv[1];
  return argv1 ? `${process.argv[0]} ${argv1}` : BIN;
}

/**
 * The command every agent-facing string tells agents to run: what our own
 * launcher was invoked as, propagated down (`SELF_CMD_ENV`), or derived from this
 * process when we are the start of the chain.
 */
export const SELF_CMD = process.env[SELF_CMD_ENV]?.trim() || derivedSelfCmd();

/**
 * The next step after any "session is not running" refusal — every command that
 * needs a live tmux window prints it (`send`, `unblock`, `wait`).
 *
 * It exists because the bare refusal reads as a death notice: an orchestrator that
 * hit it concluded the session could not be revived and relaunched the whole task
 * in a fresh worktree, abandoning the branch and commits the original had already
 * made. `resume` is the one command that answers it, so the refusal has to name it.
 *
 * `then` completes "…brings the session back, <then>" with whatever the caller was
 * trying to do.
 */
export function notRunningHint(token: string, then: string): string {
  return [
    `  It is NOT lost: its worktree, branch, commits and transcript are all still on disk.`,
    `  Bring it back with \`${SELF_CMD} resume ${token}\`, ${then}. Do not relaunch the work in`,
    `  a new session — that abandons this one's branch and commits.`,
  ].join("\n");
}

/**
 * Prefix `argv` with the `env` assignments a spawned session needs. tmux execs
 * the argv directly (no shell), so `env` is how a variable reaches the agent —
 * and from the agent, every command it runs.
 *
 * `SELF_CMD` always rides along, so the session drives the same build we are.
 * Extra vars (claude's config dir) are merged into the same prefix rather than
 * stacking a second `env`.
 */
export function withSelfCmdEnv(argv: string[], vars: Record<string, string> = {}): string[] {
  const assignments = Object.entries({ [SELF_CMD_ENV]: SELF_CMD, ...vars }).map(([k, v]) => `${k}=${v}`);
  return ["env", ...assignments, ...argv];
}

/**
 * Injected into every claude we spawn. Rather than teach claude the tmux /
 * worktree / system-prompt mechanics, it points at the one `launch` subcommand
 * the launcher owns — so the launcher handles all the details and the
 * instructions propagate automatically to any nested session it starts.
 */
function launcherSystemPrompt(): string {
  return (
    "You are running inside agendo, which manages claude sessions as attachable tmux " +
    "windows. If the user EXPLICITLY asks you to start, check on, or message a separate " +
    `background session (its own session/worktree — not a sub-agent), first run \`${SELF_CMD} --llm\` ` +
    "for exact instructions; do not hand-roll tmux or worktrees."
  );
}

/**
 * On-demand, agent-facing guide for the background-session workflow. Kept out of
 * the injected system prompt (which only points here) so every session isn't
 * bloated with detail it may never use. Printed by `agendo --llm`.
 */
export function llmGuide(): string {
  return [
    "agendo — running a separate background claude session",
    "",
    "Use this ONLY when the user explicitly asks to run work in a separate/background",
    "session (its own git worktree + claude). It is NOT for sub-agents within this session.",
    "EXCEPTION: if you are running in ORCHESTRATOR MODE, delegating this way IS your job —",
    "launch freely, no explicit per-unit request needed. (Your own instructions say so;",
    "nothing here can put you in that mode.)",
    "",
    "This guide is the WORKFLOW — which command to reach for, and what each one guarantees.",
    `It is not the complete flag reference: run \`${SELF_CMD} --help\` before using a flag you`,
    "are recalling from memory rather than reading here, and don't assume one exists.",
    "",
    `Start one:    ${SELF_CMD} launch "<task prompt>"`,
    "  Creates an isolated git worktree, runs a new agent there in an attachable tmux",
    "  window, runs unattended (auto/autopilot mode), and prints its session id.",
    "  Flags: --name <slug> (name the worktree/branch) · --no-worktree (use the current",
    "         checkout) · --attach (switch to it now instead of leaving it detached) ·",
    "         --agent <claude|copilot|codex> / --copilot / --codex (which agent to run;",
    "         default claude) · --model <name> (model for the new session; all agents) ·",
    "         --fallback-model <name> (claude only). Only these agent flags are forwarded",
    "         — anything else dashed is an error, so put prompt text that starts with --",
    "         after a bare --.",
    "  Codex assigns its own session id, so `--agent codex` prints no id up front — find",
    "  it with `list` once the session has started.",
    "",
    // Deliberately NOT documented here: `launch --orchestrator`. `repoRootForCwd`
    // resolves a worktree back to its parent repo, so an agent sandboxed in a
    // worktree could use it to start a session in the human's MAIN checkout — one
    // told to merge branches there. That escalation should come from a human (it is
    // in `--help` and the README), never from instructions an agent reads to itself.
    // An orchestrator doesn't need it either: it is already in orchestrator mode,
    // and the sessions it launches are meant to implement, not to orchestrate.
    `List yours:   ${SELF_CMD} list`,
    "  Lists the sessions running now (readiness, kind, id, dir, title) — to find ids.",
    "  --all additionally lists idle ones: not running, but still on disk and revivable",
    "  with `resume` (below). A session missing from a plain `list` is not a lost session.",
    "  One at its usage limit reads \"limited <time>\" — when it comes back. Same instant",
    `  as an ISO 8601 limitResetAt field in ${SELF_CMD} list --json.`,
    "  It lists EVERY session on the machine, so when you only care about one project",
    "  scope it rather than filtering the output yourself: --path <dir> (sessions whose",
    "  cwd is under dir) or --repo <name> (sessions in that repo — a bare name or an",
    "  owner/repo slug; a worktree counts as the repo it belongs to). Both also work on",
    `  ${SELF_CMD} status, ${SELF_CMD} open and ${SELF_CMD} wait, and with --json.`,
    "",
    `Check on it:  ${SELF_CMD} status <id>`,
    "  Prints its state, task checklist, Workflow-tool runs (with agent progress),",
    "  recent activity, and whether its input is ready for a prompt. A session parked on",
    "  claude's own resume dialog reports ready (and a `resume:` line saying so) — the",
    "  activity you see there is the PREVIOUS run's, until your next send resumes it.",
    "",
    "Finished, or stalled?  Both look like `ready`. So list/status also report how long",
    "  since the session last did anything, and mark a live, non-busy one that has been",
    "  silent past a threshold (4h; --stalled-after <dur> to change it) with \"stalled\".",
    "  That ONLY means nothing has happened for that long — agendo cannot tell finished",
    "  from fell-over, so read the final response before deciding. It also cannot see a",
    "  session BUSY doing nothing (a shell loop polling for a file reads as busy forever),",
    "  and a limited or resume-dialog session is never marked stalled — it is waiting, not",
    "  hung. --json adds per session: idleSeconds, stalled, stalledAfterSeconds (the",
    "  threshold it was judged against), resumeDialog, limitResetAt, compactionPercent (how",
    "  far a compacting session has got), and git — the",
    "  checkout's branch/upstream and whether it holds commits the remote does not",
    "  (unpushed). \"idle for hours AND unpushed work\" is the parked-session signal.",
    "",
    `Link to it:   ${SELF_CMD} open <id> --print`,
    "  Prints the FULL URLs of the PR / work item the session links to (drop --print to",
    "  open the PR in a browser; --work-item picks the other one). Use it whenever you",
    "  report a PR or work item to a human — hand over the whole clickable link, never a",
    `  bare number, and never hand-assemble one. \`${SELF_CMD} list --json\` carries the`,
    "  same links per session as prUrl / workItemUrl.",
    "",
    `Message it:   ${SELF_CMD} send <id> "<prompt>"`,
    "  Sends a follow-up prompt. A claude session takes it on its messaging socket, which",
    "  QUEUES it even mid-turn, so you don't have to wait for one to go idle first; a",
    "  session without that channel (Copilot) has it typed into the pane, and that needs",
    "  an idle input and refuses otherwise (--force to override). Either way it refuses a",
    "  session at its usage limit — check back with `status` or `wait`.",
    "  Exception: claude's OWN resume dialog (\"Resume from summary / Resume full session",
    "  as-is\") is not a question for you — such a session reports ready, and send answers",
    "  the dialog itself (config resumeDialogChoice), waits for the input box, then",
    "  delivers. Answering it is always keystrokes — the socket can't do it, since a frame",
    "  arrives as a peer message the receiver won't take as the answer to a prompt — so if",
    "  that box never appears, send fails WITHOUT delivering by EITHER route, and --force",
    "  will not change that (pasting into the menu would pick an option) — retry, or attach.",
    "  The socket does not shorten that wait: it replaces the DELIVERY step only, never the",
    "  dialog step, so the retry advice under `resume` below applies exactly as written.",
    "  \"Session <id> is not running\" is not a dead end either: `resume` it (below), then send.",
    "  (A session that IS running but has the socket switched off says so instead, and names",
    "  the switch — don't `resume` that one, it is already alive.)",
    "  It always NAMES the route: \"queued via socket\" means the message is sitting in that",
    "  session's queue and may not be read for a while; \"pasted into pane\" means it is on",
    "  screen now, and the pane had to be idle to accept it. Do not assume which you got —",
    "  `--json` carries the same as route: \"socket\" | \"pane\" plus queued: true/false.",
    "  The socket can be switched off (AGENDO_PEER_SOCKET=0, or \"peerSocket\": false in",
    "  ~/.agendo/config.json), in which case every send is the pane route and refuses a",
    "  busy session — so route reporting is the only reliable way to know what you have.",
    "",
    `Be told when it needs you (DON'T poll):`,
    `              ${SELF_CMD} wait <id...> --any --json --timeout 30m`,
    "  Blocks until a session settles — a non-busy state that isn't limited or unknown, or",
    "  its window closing (\"exited\") — then exits. A session parked at its usage cap does",
    "  NOT count as settled: it is paused, not finished. You are still woken promptly, but",
    "  with a non-zero exit and woke=\"blocked\" plus limitResetAt (which can already be past,",
    "  if it is parked beyond its own reset), so you can back off until then.",
    "  Run it in the BACKGROUND and treat its exit as the notification: that is the whole",
    "  point. Do NOT re-run `status` on a guessed cadence; you will either check too often",
    "  or find out too late.",
    "  --any wakes on the first of several sessions to settle, so one long-running session",
    "         can't hide the others. Without it, every target must settle.",
    "  --json prints what you woke up to find out: why it woke (satisfied / timeout /",
    "         unsatisfiable / blocked) and per session its from → state, changed,",
    "         satisfied, cwd, limitResetAt, and resumeDialog — true means it woke you at",
    "         claude's resume dialog, so nothing has run yet and any activity you read is",
    "         the PREVIOUS run's.",
    "  Instead of ids: --all, or --prefix <p>. --repo <name> / --path <dir> scope it to",
    "         one project, and narrow --all and explicit ids too rather than replacing them.",
    "  --state <s> waits for one exact state (ready, busy, queued, dialog, limited,",
    "         exited, …) — e.g. --state limited to be told the moment it hits its usage",
    "         cap, or --state exited to be told only when it is completely finished.",
    "         `dialog` means a question for YOU; claude's own resume dialog is not one",
    "         (it reads ready, per send above), so it won't wake a --state dialog wait.",
    "         An explicit --state/--not is never pre-empted by the blocked wake, so",
    "         --state exited waits THROUGH a usage cap and --not limited waits it out.",
    "  Exit 0 = the condition held. Non-zero = timed out, a session exited without",
    "  reaching it, or one is stuck at its usage cap. Raise --timeout (default 120s) to",
    "  the real length of the work.",
    "  Check the exit code before parsing --json: a setup error (unknown id, nothing",
    "  running) reports on stderr and prints no payload at all.",
    "",
    `Close it:     ${SELF_CMD} close <id>`,
    "  Ends the session by killing ONLY its tmux window. Its git worktree, branch and",
    "  commits are guaranteed untouched on disk, so nothing is lost and `resume <id>`",
    "  brings it back — see \"Bring one back\" below. Refuses a session with work in flight",
    "  (--force to override).",
    "  Use this instead of `tmux kill-window`/`kill-session` — never hand-roll a kill.",
    "  A `wait` on a session you close ends at once, reporting it as \"exited\".",
    "",
    `Bring one back: ${SELF_CMD} resume <id>`,
    "  A session whose tmux window is GONE is NOT a lost session, and must never be",
    "  relaunched from scratch. That holds however the window went away: you closed it, the",
    "  agent exited, the tmux server was restarted, the machine rebooted. Its git worktree,",
    "  branch and commits are on disk and its transcript is in the agent's own history, so",
    "  `resume` starts it again in a fresh detached tmux window, where it picks up where it",
    "  left off. Relaunching the work in a new worktree instead ABANDONS that branch and",
    "  those commits — reach for `resume` first, every time. (--attach switches to it now,",
    "  the way `launch --attach` does.)",
    "  This is the answer to \"is not running\" from `send` / `unblock` / `wait`, and to a",
    "  session that `wait` reported \"exited\". Find ids for idle sessions with `list --all`.",
    "  AFTER A RESUME, GIVE IT A MOMENT. The agent comes back on claude's own resume dialog",
    "  and may compact before its input box exists, so the first `send` can legitimately",
    "  fail with \"answered claude's resume dialog but no input box appeared within <n>s\".",
    "  Nothing was delivered and nothing is broken: WAIT AND RETRY (a minute is usually",
    "  enough; --timeout <dur> raises the ceiling). Do NOT reach for --force — it cannot",
    "  paste into that menu by design, since the message would pick a menu option instead.",
    "",
    "The <id> is printed when you launch. Background sessions you start carry these same",
    "instructions, so they can launch and coordinate their own background sessions too.",
  ].join("\n");
}

/**
 * Append our system-prompt additions to a claude argv — the launcher prompt
 * always, plus the orchestrator instructions when this session runs in
 * orchestrator mode.
 *
 * Both go into a SINGLE `--append-system-prompt` value. claude's flag takes one
 * value, so passing it twice would keep only the last occurrence and silently
 * drop the other prompt.
 */
function withLauncherPrompt(argv: string[], orchestrator = false): string[] {
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
interface FreshArgvOptions {
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
function freshArgv(agent: AgentSource, opts: FreshArgvOptions = {}): string[] {
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

export interface OpenPlan {
  /** Whether a live tmux target already existed (we just navigate to it). */
  alreadyRunning: boolean;
  tmuxName: string;
  /**
   * "inline" (inside tmux): the agent runs as a window in the current session;
   * the caller runs `handover` *without* unmounting, so the menu stays alive in
   * its own window. "handover" (outside tmux): the agent is its own session; the
   * caller unmounts Ink first, then runs `handover` to attach.
   */
  mode: "inline" | "handover";
  /** argv to run to hand over to / navigate to the target. */
  handover: string[];
}

/**
 * Prepare to open a managed target `name` running `argv` in `cwd`, creating it
 * if needed.
 *
 * - Inside tmux: the agent is a window in the current session. If one already
 *   exists (here or in another session) we switch to it; otherwise we create a
 *   new window and select it — i.e. a new tab next to you. The menu keeps
 *   running in its own window (see `runInline`).
 * - Outside tmux: the agent is its own detached session that we attach to
 *   (attach blocks until you detach, then control returns to the menu).
 */
function openTarget(name: string, cwd: string, argv: string[]): OpenPlan {
  if (insideTmux()) {
    const loc = windowLocation(name);
    if (loc) return { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", loc] };
    // A session by this name may exist from an earlier outside-tmux launch.
    if (hasSession(name)) return { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", name] };
    newWindow(name, cwd, argv);
    return { alreadyRunning: false, tmuxName: name, mode: "inline", handover: ["tmux", "select-window", "-t", name] };
  }
  const alreadyRunning = hasSession(name);
  if (!alreadyRunning) newDetached(name, cwd, argv);
  return { alreadyRunning, tmuxName: name, mode: "handover", handover: ["tmux", "attach-session", "-t", name] };
}

/**
 * Execute an "inline" plan's handover (switch/select the target window) without
 * disturbing the still-mounted menu. The agent window already exists; this just
 * moves the client's focus to it. `handover[0]` is always the literal "tmux".
 */
export function runInline(plan: OpenPlan): void {
  tmuxQuiet(plan.handover.slice(1));
}

/**
 * Resume/attach an existing agent session. If the session is already running
 * under some launcher window — possibly a kind-prefixed one (`cl-bg-`/`cl-new-`)
 * whose name differs from the canonical `cl-claude-<id>` — navigate to that
 * exact window so we never spawn a duplicate. Otherwise (cold resume) open the
 * canonical target, which `claude --resume` fills in.
 *
 * `liveWindow` is the actual window the model attributed this session to
 * (`LoadedModel.liveWindows`). Prefer it: it's the SAME reconciliation that
 * decided the session is running, so it also covers windows `liveTargetForShortId`
 * can't — legacy non-id-bearing names (`cl-pr-…`/`cl-wi-…`/`cl-free-…`) matched by
 * cwd. Without it, a session shown as running under such a window would resume a
 * duplicate instead of attaching.
 */
export function openSession(s: AgentSession, liveWindow?: string): OpenPlan {
  const target = liveWindow ?? liveTargetForShortId(shortId(s.id)) ?? sessionName(s);
  return openTarget(target, s.cwd, resumeArgv(s));
}

/**
 * tmux target names for fresh (not-yet-resumable) sessions. `scope` folds a repo
 * discriminator into the name for backends whose ids aren't globally unique
 * (GitHub issue/PR numbers collide across repos); ADO omits it (ids are unique),
 * keeping its names unchanged. tmux forbids `.`/`:` in names, so scope is
 * reduced to `[a-z0-9-]`.
 */
function scopeTag(scope?: string): string {
  if (!scope) return "";
  const tag = scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return tag ? `${tag}-` : "";
}
export function freshName(workItemId: number, scope?: string): string {
  return `cl-wi-${scopeTag(scope)}${workItemId}`;
}
export function prFreshName(prId: number, scope?: string): string {
  return `cl-pr-${scopeTag(scope)}${prId}`;
}

/**
 * Launch a brand-new session for `agent` in `cwd` (a freshly created worktree),
 * under the managed target `name`. Used for work-item / PR launches, whose names
 * (`cl-wi-…` / `cl-pr-…`) are attributed back to their session by working
 * directory (see model.ts). Defaults to Claude for back-compat.
 */
export function launchFresh(cwd: string, name: string, agent: AgentSource = "claude"): OpenPlan {
  return openTarget(name, cwd, freshArgv(agent));
}

/**
 * Open a kind-prefixed managed session for `agent` in `cwd`. The `cl-bg-`/
 * `cl-new-` prefix tells the human (and the UI badge) how it started. Background
 * sessions also get the autonomy flags so they run unattended — except
 * orchestrators, which need `unattended` as well (see `ManagedOptions`).
 * `forwardArgv` carries the allowlisted agent flags `agendo launch` accepted; the
 * TUI's own launch paths pass none.
 *
 * For agents that take a caller-chosen id we assign it up front (`--session-id`)
 * so the window name embeds it — that lets `openSession` find this exact window
 * on a later attach instead of spawning a duplicate, and the returned `id` is
 * the real, resumable session id. An orchestrator launch also records the minted
 * id, so a later cold resume can re-inject the instructions claude itself doesn't
 * remember.
 *
 * Codex assigns its own id, so there is nothing to embed: the window gets an
 * id-LESS tagged name (`cl-bg-codex-…`, see `kindName`) and is attributed to its
 * session by working directory — the same route `cl-wi-…`/`cl-pr-…` take, and it
 * yields the genuine codex id once the session's rollout file lands on disk.
 * `id` is undefined in that case; callers must not present the uniquifier as a
 * session id. (Orchestrator mode is Claude-only, so the recorded-id path above
 * never meets this one.)
 */
interface ManagedOptions {
  /** Run in orchestrator mode (Claude only — see `freshArgv`). */
  orchestrator?: boolean;
  /**
   * Give an ORCHESTRATOR the unattended autonomy flags too. Off by default: an
   * orchestrator's whole job is to spawn further sessions and merge into the main
   * checkout, so auto-approving its actions turns one compromised or confused
   * agent into unreviewed writes on the user's primary working tree. Ordinary
   * background sessions are unaffected — they stay autonomous in their own
   * throwaway worktree, which is what makes `agendo launch` useful at all.
   */
  unattended?: boolean;
  /** Allowlisted agent flags to forward verbatim (see `FORWARDABLE_LAUNCH_FLAGS`). */
  forwardArgv?: string[];
}

// A single options object rather than trailing positionals: `orchestrator` (bool)
// and `forwardArgv` (string[]) sit next to each other, and swapping them at a call
// site type-checks under neither — but a third boolean beside `orchestrator` would
// swap silently, turning an ordinary launch into an auto-approving orchestrator.
function launchManaged(
  cwd: string,
  kind: "background" | "new",
  agent: AgentSource,
  prompt?: string,
  opts: ManagedOptions = {},
): { plan: OpenPlan; id?: string } {
  const { orchestrator = false, unattended = false, forwardArgv } = opts;
  const preassigned = preassignsSessionId(agent);
  const uniquifier = randomUUID();
  const tmuxName = kindName(kind, uniquifier, preassigned ? undefined : agent);
  const sessionId = preassigned ? uniquifier : undefined;
  const argv = freshArgv(agent, {
    sessionId,
    prompt,
    // Orchestrators opt IN to autonomy; everything else keeps the old rule.
    autonomy: kind === "background" && (!orchestrator || unattended),
    orchestrator,
    forwardArgv,
  });
  // Orchestrator mode is Claude-only, so there is always an id to record here;
  // the guard is for the type, not for a case that can happen.
  if (orchestrator && sessionId) markOrchestratorSession(sessionId);
  return { plan: openTarget(tmuxName, cwd, argv), id: sessionId };
}

/**
 * Open a manual ("new session") flow session in an already-resolved `cwd`.
 * `orchestrator` runs it in orchestrator mode (Claude only — see `freshArgv`).
 * The minted id is remembered by `launchManaged`, so the restore snapshot picks
 * the orchestrator framing back up via `resumeArgv` without extra bookkeeping here.
 *
 * This is the TUI's path, and `kind: "new"` carries no autonomy flags at all — a
 * session the user started from the menu keeps its normal approval prompts.
 */
export function launchNewSession(
  cwd: string,
  agent: AgentSource = "claude",
  orchestrator = false,
): OpenPlan {
  return launchManaged(cwd, "new", agent, undefined, { orchestrator }).plan;
}

export interface LaunchOptions {
  /** Task prompt, passed to the new agent as a positional/interactive arg. */
  prompt?: string;
  /** Slug for the worktree/branch; derived from the prompt if omitted. */
  name?: string;
  /**
   * Create an isolated git worktree to run in. Defaults to true — but callers
   * launching an orchestrator should pass `false` (the CLI does): it merges into
   * the main branch, which git only permits in the primary checkout.
   */
  worktree?: boolean;
  /** Which agent to launch. Defaults to Claude for back-compat. */
  agent?: AgentSource;
  /**
   * Allowlisted agent flags to forward to the new session, as flat
   * `[flag, value, …]` tokens (see `FORWARDABLE_LAUNCH_FLAGS`). The caller is
   * responsible for validating them against `agent` — `agendo launch` does.
   */
  forwardArgv?: string[];
  /**
   * Run the new session in orchestrator mode: it delegates every unit of work to
   * further background sessions instead of implementing anything itself (see
   * src/orchestrator.ts). Claude only.
   */
  orchestrator?: boolean;
  /**
   * Let an orchestrator run with the unattended autonomy flags. Ignored unless
   * `orchestrator` is set (ordinary background sessions are always unattended).
   * See `ManagedOptions.unattended` for why this is opt-in.
   */
  unattended?: boolean;
}

export interface LaunchResult {
  plan?: OpenPlan;
  /** The new session id (also embedded in the tmux name); use with `status`/`--resume`. */
  id?: string;
  /** Directory the new session runs in (the worktree, or `cwd` if `--no-worktree`). */
  cwd: string;
  error?: string;
}

/**
 * Launch a background (agent-spawned) session from a prompt — the programmatic
 * entry behind `agendo launch`. Used by a running agent that the user asked to
 * spin up a background session (see `launcherSystemPrompt`).
 *
 * Creates an isolated worktree (unless disabled), then opens a `cl-bg-<id>` tmux
 * target running the chosen agent with the task prompt and (for Claude) the
 * launcher system prompt injected, so the convention propagates to whatever that
 * session spawns next. Defaults to Claude. Copilot and Codex are supported too,
 * but neither has an `--append-system-prompt` equivalent, so their background
 * sessions won't carry the launcher prompt — they run the task unattended but
 * won't autonomously spawn their own nested background sessions.
 *
 * `id` is absent for Codex, which assigns its own session id (see
 * `launchManaged`); the session still appears in `agendo list` once its rollout
 * file lands, and `plan.tmuxName` identifies the window meanwhile.
 */
export function launchTask(cwd: string, opts: LaunchOptions): LaunchResult {
  // An orchestrator's slug should say what the session IS, not repeat the goal it
  // was handed. Only used on the opt-in `worktree: true` path — an orchestrator
  // normally runs in the main checkout and has no branch of its own.
  const fallbackSlug = opts.orchestrator ? ORCHESTRATOR_SLUG : slugify(opts.prompt || "") || "session";
  // Whether `--name` actually produced a usable slug — `--name "  "` / `"!!!"` are
  // truthy but slugify to nothing, so testing `opts.name` alone would treat them
  // as user-chosen and skip the collision stepping below.
  const named = slugify(opts.name || "");
  const slug = named || fallbackSlug;
  const root = repoRootForCwd(cwd);
  let runCwd = cwd;
  if (opts.worktree === false) {
    // An orchestrator integrates by squash-merging into the main branch, and git
    // allows the main branch in exactly ONE working tree — the primary checkout.
    // So run it AT the repo root, even when invoked from a subdirectory or from
    // inside another worktree: then "merge where you are" is literally true, and
    // it never has to reach outside its own cwd to do its one git job.
    if (opts.orchestrator) runCwd = root;
  } else {
    // The orchestrator slug names the ROLE, so it's identical for every unnamed
    // orchestrator in a repo. `createWorktree` treats an existing path as
    // success, so without stepping past it a second orchestrator would run in
    // the first one's checkout, on its branch — two coordinators sharing one
    // working tree, both doing integration merges. An explicit `--name` is the
    // user's own choice and keeps the existing reuse-if-present behaviour.
    const branch =
      opts.orchestrator && !named
        ? freeWorktreeBranch(root, `worktree-${slug}`)
        : `worktree-${slug}`;
    const res = createWorktree(root, branch);
    if (res.error) return { cwd, error: res.error };
    runCwd = res.path;
  }
  const { plan, id } = launchManaged(runCwd, "background", opts.agent ?? "claude", opts.prompt, {
    orchestrator: opts.orchestrator,
    unattended: opts.unattended,
    forwardArgv: opts.forwardArgv,
  });
  return { plan, id, cwd: runCwd };
}
