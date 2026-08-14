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

/**
 * How to re-invoke this launcher from a shell — injected into agent prompts, so
 * it must keep working minutes/hours later, not just at spawn time. We pick the
 * most robust form from two generic signals, never an ephemeral absolute path:
 *
 *  1. `npm_config_user_agent` is set only by an ephemeral package runner — `npx`
 *     (`npm/<version>…`) or `bunx`/`bun x` (`bun/<version>…`). Those run our bin
 *     out of a prunable cache that isn't on PATH, so embedding `argv[1]` would
 *     break after a `cache clean`. Re-invoke through the runner instead, which
 *     re-resolves `agendo` from the registry. Check bun first: its user-agent
 *     also contains a bare `npm/?`, so match npm only when followed by a digit.
 *  2. No runner UA → `argv[1]` is a stable location. If a global install
 *     (`npm i -g`, `bun add -g`, pnpm, …) put `agendo` on PATH, the bare name is
 *     the cleanest invocation — no absolute path baked in. Otherwise fall back
 *     to the literal argv (covers `bun run src/index.tsx` dev and odd layouts).
 */
export const SELF_CMD = (() => {
  const BIN = "agendo";
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
    `Start one:    ${SELF_CMD} launch "<task prompt>"`,
    "  Creates an isolated git worktree, runs a new agent there in an attachable tmux",
    "  window, runs unattended (auto/autopilot mode), and prints its session id.",
    "  Flags: --name <slug> (name the worktree/branch) · --no-worktree (use the current",
    "         checkout) · --attach (switch to it now instead of leaving it detached) ·",
    "         --agent <claude|copilot> / --copilot (which agent to run; default claude) ·",
    "         --model <name> (model for the new session; both agents) · --fallback-model",
    "         <name> (claude only). Only these agent flags are forwarded — anything else",
    "         dashed is an error, so put prompt text that starts with -- after a bare --.",
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
    "  It lists EVERY session on the machine, so when you only care about one project",
    "  scope it rather than filtering the output yourself: --path <dir> (sessions whose",
    "  cwd is under dir) or --repo <name> (sessions in that repo — a bare name or an",
    "  owner/repo slug; a worktree counts as the repo it belongs to). Both also work on",
    `  ${SELF_CMD} status and ${SELF_CMD} wait, and with --json.`,
    "",
    `Check on it:  ${SELF_CMD} status <id>`,
    "  Prints its state, task checklist, Workflow-tool runs (with agent progress),",
    "  recent activity, and whether its input is ready for a prompt. A session parked on",
    "  claude's own resume dialog reports ready (and a `resume:` line saying so) — the",
    "  activity you see there is the PREVIOUS run's, until your next send resumes it.",
    "",
    `Message it:   ${SELF_CMD} send <id> "<prompt>"`,
    "  Sends a follow-up prompt, but only when its input is idle/ready (not mid-turn, no",
    "  open question, nothing already typed). Refuses otherwise (--force to override).",
    "  Exception: claude's OWN resume dialog (\"Resume from summary / Resume full session",
    "  as-is\") is not a question for you — such a session reports ready, and send answers",
    "  the dialog itself (config resumeDialogChoice), waits for the input box, then",
    "  delivers. If that box never appears, send fails WITHOUT delivering and --force will",
    "  not change that (pasting into the menu would pick an option) — retry, or attach.",
    "",
    `Be told when it needs you (DON'T poll):`,
    `              ${SELF_CMD} wait <id...> --any --json --timeout 30m`,
    "  Blocks until a session stops working — settles to a non-busy state, or its window",
    "  closes (\"exited\") — then exits. Run it in the BACKGROUND and treat its exit as the",
    "  notification: that is the whole point. Do NOT re-run `status` on a guessed cadence;",
    "  you will either check too often or find out too late.",
    "  --any wakes on the first of several sessions to settle, so one long-running session",
    "         can't hide the others. Without it, every target must settle.",
    "  --json prints what you woke up to find out: why it woke (satisfied / timeout /",
    "         unsatisfiable) and per session its from → state, changed, satisfied, cwd,",
    "         and resumeDialog — true means it woke you at claude's resume dialog, so",
    "         nothing has run yet and any activity you read is the PREVIOUS run's.",
    "  Instead of ids: --all, or --prefix <p>. --repo <name> / --path <dir> scope it to",
    "         one project, and narrow --all and explicit ids too rather than replacing them.",
    "  --state <s> waits for one exact state (ready, busy, queued, dialog, limited,",
    "         exited, …) — e.g. --state limited to be told the moment it hits its usage",
    "         cap, or --state exited to be told only when it is completely finished.",
    "         `dialog` means a question for YOU; claude's own resume dialog is not one",
    "         (it reads ready, per send above), so it won't wake a --state dialog wait.",
    "  Exit 0 = the condition held. Non-zero = timed out, or a session exited without",
    "  reaching it. Raise --timeout (default 120s) to the real length of the work.",
    "  Check the exit code before parsing --json: a setup error (unknown id, nothing",
    "  running) reports on stderr and prints no payload at all.",
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
 * Agent CLI flags `agendo launch` may forward verbatim into a BRAND-NEW
 * session's argv. Deliberately a small allowlist rather than a `--` catch-all:
 * every forwarded token is one we know the target agent accepts, so a typo fails
 * loudly instead of silently becoming prompt text (see the launch parser).
 *
 * Each entry lists the agents that take the flag with this exact
 * `<flag> <value>` syntax — the flags are NOT symmetric across agents:
 *  - `--model <name>`: both Claude and Copilot, same syntax and meaning, so it
 *    forwards straight through with no per-agent translation.
 *  - `--fallback-model <name>`: Claude only; Copilot has no equivalent, so
 *    `agendo launch --copilot --fallback-model …` is rejected rather than
 *    passed to a binary that would choke on it.
 * Forwarding applies to new sessions only — `resumeArgv` never sees these.
 */
export const FORWARDABLE_LAUNCH_FLAGS: Record<string, { agents: readonly AgentSource[] }> = {
  "--model": { agents: ["claude", "copilot"] },
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
 * Build the argv to start a BRAND-NEW session for `agent` in a tmux window.
 * Both agents support pre-assigning the session UUID (so the `cl-…-<id>` window
 * name can embed it) and an initial interactive prompt:
 *  - Claude: `--session-id <id>`, positional prompt, `AUTONOMY_ARGV`, plus the
 *    launcher system prompt appended so background-session coordination works.
 *  - Copilot: `--session-id <id>`, `--interactive <prompt>`,
 *    `COPILOT_AUTONOMY_ARGV`. Copilot has no `--append-system-prompt`, so the
 *    launcher prompt is omitted (background coordination is Claude-only today) —
 *    which is also why orchestrator mode is Claude-only, rejected at the entry
 *    points rather than silently degraded here.
 * Any `forwardArgv` (allowlisted flags from `agendo launch`) goes last among the
 * flags, so an explicit `--model` wins over anything the defaults might set.
 */
function freshArgv(agent: AgentSource, opts: FreshArgvOptions = {}): string[] {
  if (agent === "copilot") {
    const argv = ["copilot"];
    if (opts.sessionId) argv.push("--session-id", opts.sessionId);
    if (opts.autonomy) argv.push(...COPILOT_AUTONOMY_ARGV);
    if (opts.forwardArgv?.length) argv.push(...opts.forwardArgv);
    if (opts.prompt) argv.push("--interactive", opts.prompt);
    return argv;
  }
  const argv = ["claude"];
  if (opts.sessionId) argv.push("--session-id", opts.sessionId);
  if (opts.autonomy) argv.push(...AUTONOMY_ARGV);
  if (opts.forwardArgv?.length) argv.push(...opts.forwardArgv);
  if (opts.prompt) argv.push(opts.prompt);
  return withLauncherPrompt(argv, opts.orchestrator);
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
 * started. Background sessions also get the autonomy flags so they run unattended
 * — except orchestrators, which need `unattended` as well (see `ManagedOptions`).
 * `forwardArgv` carries the allowlisted agent flags `agendo launch` accepted; the
 * TUI's own launch paths pass none.
 *
 * An orchestrator launch also records the minted id, so a later cold resume can
 * re-inject the instructions claude itself doesn't remember.
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
): { plan: OpenPlan; id: string } {
  const { orchestrator = false, unattended = false, forwardArgv } = opts;
  const id = randomUUID();
  const tmuxName = kindName(kind, id);
  const argv = freshArgv(agent, {
    sessionId: id,
    prompt,
    // Orchestrators opt IN to autonomy; everything else keeps the old rule.
    autonomy: kind === "background" && (!orchestrator || unattended),
    orchestrator,
    forwardArgv,
  });
  if (orchestrator) markOrchestratorSession(id);
  return { plan: openTarget(tmuxName, cwd, argv), id };
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
 * session spawns next. Defaults to Claude. Copilot is supported too, but has no
 * `--append-system-prompt` equivalent, so a Copilot background session won't
 * carry the launcher prompt — it runs the task under `--autopilot` but won't
 * autonomously spawn its own nested background sessions.
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
