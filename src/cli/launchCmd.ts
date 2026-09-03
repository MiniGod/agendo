// `launch [flags] <prompt>`: spin up a managed session without the menu. The
// launcher creates an isolated worktree (unless `--no-worktree`) and a
// `cl-bg-…` agent window it can attach to later (Claude by default, or Copilot /
// Codex via `--agent <name>` and its shorthand). Used both by humans and by a running agent
// the user asked to start a background session. Detached by default; `--attach`
// switches/attaches to it immediately. A small allowlist of agent flags
// (`FORWARDABLE_LAUNCH_FLAGS`, e.g. `--model`) is passed through to the new
// agent's argv; any other dashed argument is rejected rather than silently
// swallowed into the prompt, so a typo'd flag can't quietly change the task.

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { currentSessionName } from "../tmux.ts";
import {
  FORWARDABLE_LAUNCH_FLAGS, launchGlobalOrchestrator, launchTask, SELF_CMD,
  type GlobalLayout, type LaunchResult,
} from "../launch.ts";
import { recordLaunchedSession } from "../restore.ts";
import { SessionIndex } from "../sessions.ts";
import { discoverRepos, globalOrchestratorCwd } from "../repos.ts";

import { AGENTS } from "../types.ts";
import type { AgentSource } from "../types.ts";

// The agent can be named after a forwarded flag (`--model x --copilot`), so the
// per-agent support check only makes sense once the whole argv is parsed.
function checkForwardedFlags(forwardArgv: string[], agent: AgentSource): void {
  for (let i = 0; i < forwardArgv.length; i += 2) {
    const flag = forwardArgv[i];
    if (!FORWARDABLE_LAUNCH_FLAGS[flag]?.agents.includes(agent)) {
      console.error(`launch failed: ${flag} isn't supported by --agent ${agent}`);
      process.exit(1);
    }
  }
}

/**
 * `--worktree` has two meanings, told apart by the `=`: bare, it forces a fresh
 * worktree (returns undefined); `--worktree=<path>` adopts an existing one
 * (returns the path). `eq` is the index of the `=` in the token, or -1 for the
 * bare form. The two-token `--worktree <path>` form is deliberately NOT
 * accepted — bare `--worktree` has always been followed directly by the prompt,
 * so the next token can't be read as a value. What it must not do either is
 * quietly swallow a path into the prompt and create a NEW worktree, the
 * opposite of what was asked: a next token that looks like a path is refused.
 */
function parseWorktreeFlag(a: string, eq: number, next: string | undefined): string | undefined {
  if (eq >= 0) {
    const p = a.slice(eq + 1);
    if (!p) {
      console.error(`launch failed: --worktree= needs a path`);
      process.exit(1);
    }
    return p;
  }
  if (next !== undefined && !next.startsWith("-") && (next.includes("/") || existsSync(next))) {
    console.error(
      `launch failed: "${next}" after a bare --worktree looks like a path; ` +
      `use --worktree=${next} to adopt an existing worktree, or put the prompt after a bare --`,
    );
    process.exit(1);
  }
  return undefined;
}

/** The `--agent <name>` shorthands, as a table: three cases in the parse chain
 *  buy nothing over one lookup. */
const AGENT_SHORTHAND: Record<string, AgentSource> = {
  "--claude": "claude",
  "--copilot": "copilot",
  "--codex": "codex",
};

/**
 * The global-orchestrator flags, lifted out of the main parse chain: its own
 * spelling (`--global-orchestrator` / `-G`), `--global` as a modifier on
 * `--orchestrator`, and the two layout choices. Returns null when `a` is none of
 * them, so the caller falls through to the next branch.
 *
 * Both spellings exist because a reader who knows `-O` will reach for a modifier
 * and a reader who knows neither will look for a long flag; neither should have
 * to guess which one this build implemented.
 */
function parseOrchestratorFlag(a: string, flag: string, inline: boolean): boolean {
  if (flag !== "--orchestrator" && a !== "-O" && !a.startsWith("-O=")) return false;
  // A boolean flag: `--orchestrator=false` reads as "off" to a human but would
  // enable it here, so an inline value is refused, never guessed. `-O=…` is
  // checked separately because `inline` only recognises the `--` form, and
  // single-dash args fall through to the prompt rather than to the unknown-flag
  // guard — so without this it would silently become prompt text.
  if (inline || a.startsWith("-O=")) {
    console.error(`launch failed: --orchestrator takes no value (got "${a}")`);
    process.exit(1);
  }
  return true;
}

function parseGlobalFlag(a: string, flag: string, inline: boolean): { global?: true; layout?: "pane" | "window" } | null {
  if (flag === "--global-orchestrator" || a === "-G" || a.startsWith("-G=")) {
    // A boolean flag given a value reads as "off" to a human but would enable it
    // here, so refuse rather than guess — as `--orchestrator` does.
    if (inline || a.startsWith("-G=")) {
      console.error(`launch failed: --global-orchestrator takes no value (got "${a}")`);
      process.exit(1);
    }
    return { global: true };
  }
  if (a === "--global") return { global: true };
  if (a === "--window") return { layout: "window" };
  if (a === "--pane") return { layout: "pane" };
  return null;
}

/** Everything `launch` reads out of argv, once. */
export interface LaunchArgs {
  name?: string;
  /** undefined = not specified, so the default can depend on --orchestrator. */
  worktree?: boolean;
  /** `--worktree=<path>`: an existing worktree to adopt instead of creating one. */
  worktreePath?: string;
  attach: boolean;
  orchestrator: boolean;
  /** Launch the GLOBAL orchestrator — the level above the per-repo ones. */
  global: boolean;
  /** Preferred layout for the global orchestrator; undefined = its default. */
  layout?: "pane" | "window";
  unattended: boolean;
  agent: AgentSource;
  /** Flat `[flag, value, …]` tokens forwarded verbatim to the new agent. */
  forwardArgv: string[];
  positionals: string[];
}

// Parse `launch`'s argv tail. Exits on a bad flag rather than returning, so a
// typo can never be swallowed into the prompt as if it were part of the task.
/** One argv token, with the GNU `--flag=value` form split off. */
interface Token {
  a: string;
  /** The flag without its inline value (`--model` for `--model=opus`), else the token itself. */
  flag: string;
  inline: boolean;
  eq: number;
}

// Both agent CLIs accept the GNU `--model=opus` form as well as the two-token
// one, so split an inline value off here and normalize to `[flag, value]`.
// (`eq > 2` keeps the bare `--` separator and a leading `--=` out of this.)
function tokenOf(a: string): Token {
  const eq = a.indexOf("=");
  const inline = a.startsWith("--") && eq > 2;
  return { a, flag: inline ? a.slice(0, eq) : a, inline, eq };
}

// A flag that takes a value: the inline `=value`, else the next token, which is
// then consumed (`used` is how many extra argv tokens the flag took).
function takeValue(t: Token, next: string | undefined): { v: string | undefined; used: 0 | 1 } {
  return t.inline ? { v: t.a.slice(t.eq + 1), used: 0 } : { v: next, used: 1 };
}

function initialLaunchArgs(): LaunchArgs {
  return { attach: false, orchestrator: false, global: false, unattended: false, agent: "claude", forwardArgv: [], positionals: [] };
}

// The flags that are a switch and nothing more. True when the token was one.
//
// The orchestrator test must stay ahead of the unknown-`--flag` catch-all in
// parseLaunchArgs, or `--orchestrator` would be rejected outright and `-O`
// would fall through into the prompt — launching an ordinary session that
// looks like it was asked to orchestrate.
function applyToggle(d: LaunchArgs, t: Token): boolean {
  const { a, flag, inline } = t;
  if (a === "--attach" || a === "-a") d.attach = true;
  else if (a === "--no-worktree") d.worktree = false;
  else if (parseOrchestratorFlag(a, flag, inline)) d.orchestrator = true;
  else if (a === "--unattended") d.unattended = true;
  else if (AGENT_SHORTHAND[a]) d.agent = AGENT_SHORTHAND[a];
  else return false;
  return true;
}

function applyGlobalFlag(d: LaunchArgs, t: Token): boolean {
  const g = parseGlobalFlag(t.a, t.flag, t.inline);
  if (!g) return false;
  if (g.global) d.global = true;
  if (g.layout) d.layout = g.layout;
  return true;
}

function agentOf(v: string | undefined): AgentSource {
  if (!AGENTS.includes(v as AgentSource)) {
    console.error(`launch failed: --agent must be one of ${AGENTS.join(", ")}, got "${v ?? ""}"`);
    process.exit(1);
  }
  return v as AgentSource;
}

// Value flags forwarded verbatim to the agent. A missing value (empty, or end
// of argv) or — in the two-token form, where it's ambiguous — another flag in
// its place is a mistake, not a model named "--attach".
function pushForwarded(d: LaunchArgs, t: Token, v: string | undefined): void {
  if (v === undefined || v === "" || (!t.inline && v.startsWith("--"))) {
    console.error(`launch failed: ${t.flag} needs a value`);
    process.exit(1);
  }
  d.forwardArgv.push(t.flag, v);
}

// The flags that take (or, for --worktree, may look at) a value. Returns how
// many extra argv tokens were consumed, or null when the token was none of them.
function applyWorktree(d: LaunchArgs, t: Token, next: string | undefined): 0 {
  const p = parseWorktreeFlag(t.a, t.inline ? t.eq : -1, next);
  if (p === undefined) d.worktree = true;
  else d.worktreePath = p;
  return 0;
}

function applyValueFlag(d: LaunchArgs, t: Token, next: string | undefined): 0 | 1 | null {
  if (t.flag === "--worktree") return applyWorktree(d, t, next);
  const { v, used } = takeValue(t, next);
  if (t.flag === "--name" || t.a === "-n") d.name = v;
  else if (t.flag === "--agent") d.agent = agentOf(v);
  else if (Object.hasOwn(FORWARDABLE_LAUNCH_FLAGS, t.flag)) pushForwarded(d, t, v);
  else return null;
  return used;
}

function failUnknownFlag(a: string): never {
  const known = Object.keys(FORWARDABLE_LAUNCH_FLAGS).join(", ");
  console.error(
    `launch failed: unknown flag "${a}" (forwardable agent flags: ${known}; ` +
    `use -- before prompt text that starts with --)`,
  );
  process.exit(1);
}

/** `agendo launch`'s argv after the command word, one token at a time. */
export function parseLaunchArgs(rest: string[]): LaunchArgs {
  const d = initialLaunchArgs();
  for (let i = 0; i < rest.length; i++) {
    const t = tokenOf(rest[i]);
    if (applyToggle(d, t) || applyGlobalFlag(d, t)) continue;
    const used = applyValueFlag(d, t, rest[i + 1]);
    if (used !== null) {
      i += used;
      continue;
    }
    if (t.a === "--") {
      d.positionals.push(...rest.slice(i + 1));
      break;
    }
    if (t.a.startsWith("--")) failUnknownFlag(t.a);
    d.positionals.push(t.a);
  }
  checkForwardedFlags(d.forwardArgv, d.agent);
  return d;
}

/**
 * The stderr line for a launch that landed in a worktree that already existed.
 * Always printed — reusing a directory is worth a sentence even when it is
 * exactly what was asked for — and upgraded to a `warning:` when there is
 * something in it the caller may not have expected: uncommitted entries, or a
 * branch other than the one the slug names (a `--name` adopt only; an explicit
 * `--worktree=<path>` has no expected branch). Either way the tree is used as
 * found: nothing in it is reset, stashed or checked out — those uncommitted
 * files are the work the launch exists to get back to (#37).
 */
function adoptionNotice(a: NonNullable<LaunchResult["adopted"]>): string {
  const branch = a.branch === null ? "a detached HEAD" : `branch ${a.branch}`;
  const drifted = a.expectedBranch !== undefined && a.branch !== a.expectedBranch;
  const dirty = a.dirty === 1 ? "1 uncommitted change" : `${a.dirty} uncommitted changes`;
  const parts = [`adopting existing worktree ${a.path} on ${branch}`];
  if (drifted) parts.push(`(expected ${a.expectedBranch})`);
  parts.push(a.dirty ? `with ${dirty}` : "(clean)");
  const line = parts.join(" ");
  return drifted || a.dirty ? `warning: ${line} — left as found, nothing reset, stashed or checked out` : `▸ ${line}`;
}

/** How each resolved layout reads in the launch report. */
const LAYOUT_NOTE: Record<GlobalLayout, string> = {
  pane: "split pane beside the agendo TUI",
  window: "its own tmux window",
  session: "its own tmux session",
};

/**
 * Launch the global orchestrator, choosing where it should sit.
 *
 * It belongs to no repo, so there is nothing to derive a cwd from the way
 * `launchTask` derives one from the checkout it was invoked in. We pick a
 * vantage point instead: the deepest directory containing every repo agendo
 * knows about, stepping up out of a lone repo so the session does not look like
 * it lives in one (see `globalOrchestratorCwd`). Falls back to the caller's cwd
 * when there are no known repos at all.
 */
async function launchGlobal(prompt: string, layout: "pane" | "window" | undefined, unattended: boolean) {
  const index = await SessionIndex.build();
  const roots = discoverRepos(index.all).map((r) => r.root);
  const cwd = globalOrchestratorCwd(roots, process.cwd());
  return launchGlobalOrchestrator(cwd, { prompt, layout, unattended });
}

/**
 * Refuse the flag combinations that contradict each other, before anything is
 * launched. They are all the same shape — one flag says where or how to run and
 * another says something incompatible — and accept-and-ignore is the failure
 * mode to avoid: a caller who wrote the second flag believes it changed
 * something. Exits rather than returning, so `runLaunch` reads as the happy path.
 */
function validateLaunchArgs(a: LaunchArgs): void {
  // `--worktree=<path>` says exactly where to run, so the flags that would pick
  // a different directory are contradictions, not overrides to be resolved by
  // position: `--name` would name a worktree that isn't used, `--no-worktree`
  // would run in cwd, and a bare `--worktree` would create one.
  if (a.worktreePath !== undefined && (a.name !== undefined || a.worktree !== undefined)) {
    const other = a.name !== undefined ? "--name" : a.worktree ? "a bare --worktree" : "--no-worktree";
    console.error(`launch failed: --worktree=<path> can't be combined with ${other} (it already says where to run)`);
    process.exit(1);
  }
  // Orchestrator mode rides on `--append-system-prompt`, which Copilot has no
  // equivalent for, so a Copilot orchestrator would run with none of the
  // coordinate-don't-implement instructions. Refuse loudly rather than degrade.
  // `agent` defaults to claude, so "copilot" here can only mean a flag asked for
  // it — no need to track explicitness separately.
  if ((a.orchestrator || a.global) && a.agent !== "claude") {
    const flag = a.global ? "--global-orchestrator" : "--orchestrator";
    console.error(`launch failed: ${flag} is Claude-only (no --append-system-prompt equivalent in --agent ${a.agent})`);
    process.exit(1);
  }
  // A global orchestrator belongs to no repository — it coordinates the per-repo
  // orchestrators, never a checkout — so the repo-shaped flags have no meaning
  // for it.
  if (a.global && (a.worktree !== undefined || a.worktreePath !== undefined)) {
    console.error(`launch failed: --global-orchestrator is tied to no repo, so --worktree/--no-worktree don't apply`);
    process.exit(1);
  }
  if (a.global && a.name !== undefined) {
    console.error(`launch failed: --global-orchestrator creates no worktree or branch, so --name doesn't apply`);
    process.exit(1);
  }
  if (a.layout !== undefined && !a.global) {
    console.error(`launch failed: --window/--pane only apply to --global-orchestrator`);
    process.exit(1);
  }
  // `--unattended` only ever loosens an ORCHESTRATOR's approvals — a plain
  // background session is already unattended. `-G` IS an orchestrator flag, so it
  // qualifies on its own; requiring `--orchestrator` beside it would refuse a
  // combination that means exactly what it says.
  if (a.unattended && !a.orchestrator && !a.global) {
    console.error(`launch failed: --unattended only applies with --orchestrator (background sessions already run unattended)`);
    process.exit(1);
  }
}

export async function runLaunch(): Promise<void> {
  const args = parseLaunchArgs(process.argv.slice(3));
  validateLaunchArgs(args);
  const { name, worktree, worktreePath, attach, orchestrator, global, layout, unattended, agent, forwardArgv, positionals } = args;
  // An orchestrator squash-merges into the main branch, and git allows the main
  // branch in only ONE working tree — the primary checkout. A worktree would give
  // it an empty branch it never commits to while forcing every merge to reach out
  // to the repo root, so orchestrators run in the main checkout unless asked
  // otherwise. Ordinary background sessions keep their isolation.
  const useWorktree = worktree ?? !orchestrator;
  const prompt = positionals.join(" ").trim();
  // Resolved once so the layout report below can read it off the same value the
  // launch produced — `"layout" in result` would widen the union and lose it.
  const globalRes = global ? await launchGlobal(prompt, layout, unattended) : null;
  const launched: LaunchResult =
    globalRes ??
    launchTask(process.cwd(), {
      prompt,
      name,
      worktree: useWorktree,
      worktreePath,
      agent,
      orchestrator,
      unattended,
      forwardArgv,
    });
  const { plan, id, cwd, adopted, error } = launched;
  if (error || !plan) {
    console.error(`launch failed: ${error ?? "unknown error"}`);
    process.exit(1);
  }
  // On stderr, so a caller parsing the stdout summary still sees the same shape
  // it always did; the directory itself is repeated in the `window:` line below.
  if (adopted) console.error(adoptionNotice(adopted));
  // Persist this background session into the restore snapshot right away. The CLI
  // runs as its own process and never goes through loadModel, so `captureRestore`
  // wouldn't see it until the menu's next full reload — and a brand-new session
  // has no on-disk log yet to attribute by, only the short id in its tmux name.
  // Recording it here (with the full id we just minted) makes the tab survive a
  // relaunch immediately; no-op if the window didn't land in the canonical session.
  //
  // Skipped for Codex, which mints its own id: there's nothing to resume by yet.
  // Its window is attributed by cwd instead, so the menu's next reload picks the
  // session up and `captureRestore` snapshots it from there.
  if (id) {
    recordLaunchedSession(
      {
        id,
        cwd,
        title: prompt || (global ? "global orchestrator session" : orchestrator ? "orchestrator session" : "background session"),
        source: agent,
        // Claude is profile-scoped via CLAUDE_CONFIG_DIR; Copilot keeps all state
        // under ~/.copilot, so it carries no config dir.
        configDir: agent === "claude" ? process.env.CLAUDE_CONFIG_DIR : undefined,
      },
      plan.tmuxName,
      // Record into the restore bucket of the host session the window landed in
      // (the current tmux session), so a scoped launcher restores its own tabs.
      currentSessionName() ?? undefined,
    );
  }
  if (attach) {
    const [cmd, ...args] = plan.handover;
    spawnSync(cmd, args, { stdio: "inherit" });
  } else {
    // Print machine-readable next steps for the agent/human that launched it.
    // `status` is keyed by session id; codex assigns its own only once the
    // session starts, so send the caller to `list` to pick it up from there.
    const kind = global ? "global orchestrator" : orchestrator ? "orchestrator" : "background";
    console.log(`▸ launched ${kind} session ${id ?? `— ${agent} assigns its own id`}`);
    console.log(`  window:  ${plan.tmuxName}   (in ${cwd})`);
    console.log(id ? `  status:  ${SELF_CMD} status ${id}` : `  id:      ${SELF_CMD} list   (then: ${SELF_CMD} status <id>)`);
    if (globalRes) console.log(`  layout:  ${LAYOUT_NOTE[globalRes.layout]}${globalRes.layoutNote ? ` — ${globalRes.layoutNote}` : ""}`);
    console.log(`  attach:  open agendo and pick it (running → attach), or rerun with --attach`);
  }
  process.exit(0);
}
