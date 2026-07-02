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
import { slugify, createWorktree } from "./worktree.ts";
import { repoRootForCwd } from "./repos.ts";

/** Is `cmd` resolvable as an executable on the current PATH? */
function onPath(cmd: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir && existsSync(join(dir, cmd)));
}

/**
 * How to re-invoke this launcher from a shell — injected into agent prompts, so
 * it must keep working minutes/hours later, not just at spawn time. We pick the
 * most robust form from two generic signals, never an ephemeral absolute path:
 *
 *  1. `npm_config_user_agent` is set only by an ephemeral package runner — `npx`
 *     (`npm/<version>…`) or `bunx`/`bun x` (`bun/<version>…`). Those run our bin
 *     out of a prunable cache that isn't on PATH, so embedding `argv[1]` would
 *     break after a `cache clean`. Re-invoke through the runner instead, which
 *     re-resolves `clops` from the registry. Check bun first: its user-agent
 *     also contains a bare `npm/?`, so match npm only when followed by a digit.
 *  2. No runner UA → `argv[1]` is a stable location. If a global install
 *     (`npm i -g`, `bun add -g`, pnpm, …) put `clops` on PATH, the bare name is
 *     the cleanest invocation — no absolute path baked in. Otherwise fall back
 *     to the literal argv (covers `bun run src/index.tsx` dev and odd layouts).
 */
export const SELF_CMD = (() => {
  const BIN = "clops";
  const ua = process.env.npm_config_user_agent ?? "";
  if (/\bbun\//i.test(ua)) return `bunx ${BIN}`;
  if (/\bnpm\/\d/i.test(ua)) return `npx ${BIN}`;
  if (onPath(BIN)) return BIN;
  const argv1 = process.argv[1];
  return argv1 ? `${process.argv[0]} ${argv1}` : BIN;
})();

/**
 * Injected into every claude we spawn. Rather than teach claude the tmux /
 * worktree / system-prompt mechanics, it points at the one `launch` subcommand
 * the launcher owns — so the launcher handles all the details and the
 * instructions propagate automatically to any nested session it starts.
 */
function launcherSystemPrompt(): string {
  return (
    "You are running inside clops, which manages claude sessions as attachable tmux " +
    "windows. If the user EXPLICITLY asks you to start, check on, or message a separate " +
    `background session (its own session/worktree — not a sub-agent), first run \`${SELF_CMD} --llm\` ` +
    "for exact instructions; do not hand-roll tmux or worktrees."
  );
}

/**
 * On-demand, agent-facing guide for the background-session workflow. Kept out of
 * the injected system prompt (which only points here) so every session isn't
 * bloated with detail it may never use. Printed by `clops --llm`.
 */
export function llmGuide(): string {
  return [
    "clops — running a separate background claude session",
    "",
    "Use this ONLY when the user explicitly asks to run work in a separate/background",
    "session (its own git worktree + claude). It is NOT for sub-agents within this session.",
    "",
    `Start one:    ${SELF_CMD} launch "<task prompt>"`,
    "  Creates an isolated git worktree, runs a new agent there in an attachable tmux",
    "  window, runs unattended (auto/autopilot mode), and prints its session id.",
    "  Flags: --name <slug> (name the worktree/branch) · --no-worktree (use the current",
    "         checkout) · --attach (switch to it now instead of leaving it detached) ·",
    "         --agent <claude|copilot> / --copilot (which agent to run; default claude).",
    "",
    `List yours:   ${SELF_CMD} list`,
    "  Lists the sessions running now (readiness, kind, id, dir, title) — to find ids.",
    "",
    `Check on it:  ${SELF_CMD} status <id>`,
    "  Prints its state, recent activity, and whether its input is ready for a prompt.",
    "",
    `Message it:   ${SELF_CMD} send <id> "<prompt>"`,
    "  Sends a follow-up prompt, but only when its input is idle/ready (not mid-turn, no",
    "  open question, nothing already typed). Refuses otherwise (--force to override).",
    "",
    "The <id> is printed when you launch. Background sessions you start carry these same",
    "instructions, so they can launch and coordinate their own background sessions too.",
  ].join("\n");
}

/** Append the launcher system prompt to a claude argv. */
function withLauncherPrompt(argv: string[]): string[] {
  return [...argv, "--append-system-prompt", launcherSystemPrompt()];
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

/** argv that resumes a given session in its working directory. */
export function resumeArgv(s: AgentSession): string[] {
  switch (s.source) {
    case "claude": {
      const cmd = withLauncherPrompt(["claude", "--resume", s.id]);
      // Point claude at the config dir the session lives in, so the right
      // subscription/profile (e.g. ~/.claude vs ~/.claude-work) finds it.
      return s.configDir ? ["env", `CLAUDE_CONFIG_DIR=${s.configDir}`, ...cmd] : cmd;
    }
    case "copilot":
      // Copilot CLI resumes by session id. `--resume` takes an *optional* value
      // (`-r, --resume[=value]`), so the id must be attached with `=` — a
      // space-separated `--resume <id>` would be parsed as a positional prompt,
      // not the session to resume. The tmux window is already created in the
      // session's cwd (openTarget passes `-c cwd`), and Copilot keeps all state
      // under ~/.copilot, so no extra env/dir wiring is needed. There's no
      // Copilot equivalent of claude's `--append-system-prompt`, so the launcher
      // system prompt is intentionally omitted for Copilot resumes.
      return ["copilot", `--resume=${s.id}`];
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
}

/**
 * Build the argv to start a BRAND-NEW session for `agent` in a tmux window.
 * Both agents support pre-assigning the session UUID (so the `cl-…-<id>` window
 * name can embed it) and an initial interactive prompt:
 *  - Claude: `--session-id <id>`, positional prompt, `AUTONOMY_ARGV`, plus the
 *    launcher system prompt appended so background-session coordination works.
 *  - Copilot: `--session-id <id>`, `--interactive <prompt>`,
 *    `COPILOT_AUTONOMY_ARGV`. Copilot has no `--append-system-prompt`, so the
 *    launcher prompt is omitted (background coordination is Claude-only today).
 */
function freshArgv(agent: AgentSource, opts: FreshArgvOptions = {}): string[] {
  if (agent === "copilot") {
    const argv = ["copilot"];
    if (opts.sessionId) argv.push("--session-id", opts.sessionId);
    if (opts.autonomy) argv.push(...COPILOT_AUTONOMY_ARGV);
    if (opts.prompt) argv.push("--interactive", opts.prompt);
    return argv;
  }
  const argv = ["claude"];
  if (opts.sessionId) argv.push("--session-id", opts.sessionId);
  if (opts.autonomy) argv.push(...AUTONOMY_ARGV);
  if (opts.prompt) argv.push(opts.prompt);
  return withLauncherPrompt(argv);
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
 * Open a kind-prefixed managed session for `agent` in `cwd`. We assign the
 * session id up front (`--session-id`) so the tmux window name embeds it — that
 * lets `openSession` find this exact window on a later attach (no duplicate),
 * and the `cl-bg-`/`cl-new-` prefix tells the human (and the UI badge) how it
 * started. Background sessions also get the autonomy flags so they run unattended.
 */
function launchManaged(
  cwd: string,
  kind: "background" | "new",
  agent: AgentSource,
  prompt?: string,
): { plan: OpenPlan; id: string } {
  const id = randomUUID();
  const tmuxName = kindName(kind, id);
  const argv = freshArgv(agent, { sessionId: id, prompt, autonomy: kind === "background" });
  return { plan: openTarget(tmuxName, cwd, argv), id };
}

/** Open a manual ("new session") flow session in an already-resolved `cwd`. */
export function launchNewSession(cwd: string, agent: AgentSource = "claude"): OpenPlan {
  return launchManaged(cwd, "new", agent).plan;
}

export interface LaunchOptions {
  /** Task prompt, passed to the new agent as a positional/interactive arg. */
  prompt?: string;
  /** Slug for the worktree/branch; derived from the prompt if omitted. */
  name?: string;
  /** Create an isolated git worktree to run in. Defaults to true. */
  worktree?: boolean;
  /** Which agent to launch. Defaults to Claude for back-compat. */
  agent?: AgentSource;
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
 * entry behind `clops launch`. Used by a running agent that the user asked to
 * spin up a background session (see `launcherSystemPrompt`).
 *
 * Creates an isolated worktree (unless disabled), then opens a `cl-bg-<id>` tmux
 * target running the chosen agent with the task prompt and (for Claude) the
 * launcher system prompt injected, so the convention propagates to whatever that
 * session spawns next. Defaults to Claude. Copilot is supported too, but has no
 * `--append-system-prompt` equivalent, so a Copilot background session won't
 * carry the launcher prompt — it runs the task under `--autopilot` but won't
 * autonomously spawn its own nested background sessions.
 */
export function launchTask(cwd: string, opts: LaunchOptions): LaunchResult {
  const slug = slugify(opts.name || opts.prompt || "") || "session";
  let runCwd = cwd;
  if (opts.worktree !== false) {
    const res = createWorktree(repoRootForCwd(cwd), `worktree-${slug}`);
    if (res.error) return { cwd, error: res.error };
    runCwd = res.path;
  }
  const { plan, id } = launchManaged(runCwd, "background", opts.agent ?? "claude", opts.prompt);
  return { plan, id, cwd: runCwd };
}
