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
import { FORWARDABLE_LAUNCH_FLAGS, launchTask, SELF_CMD, type LaunchResult } from "../launch.ts";
import { recordLaunchedSession } from "../restore.ts";

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

/** Everything `launch` reads out of argv, once. */
interface LaunchArgs {
  name?: string;
  /** undefined = not specified, so the default can depend on --orchestrator. */
  worktree?: boolean;
  /** `--worktree=<path>`: an existing worktree to adopt instead of creating one. */
  worktreePath?: string;
  attach: boolean;
  orchestrator: boolean;
  unattended: boolean;
  agent: AgentSource;
  /** Flat `[flag, value, …]` tokens forwarded verbatim to the new agent. */
  forwardArgv: string[];
  positionals: string[];
}

// Parse `launch`'s argv tail. Exits on a bad flag rather than returning, so a
// typo can never be swallowed into the prompt as if it were part of the task.
function parseLaunchArgs(): LaunchArgs {
  let name: string | undefined;
  // undefined = "not specified", so the default can depend on --orchestrator below.
  let worktree: boolean | undefined;
  let worktreePath: string | undefined;
  let attach = false;
  let orchestrator = false;
  let unattended = false;
  let agent: AgentSource = "claude";
  // Flat `[flag, value, …]` tokens forwarded verbatim to the new agent.
  const forwardArgv: string[] = [];
  const positionals: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    // Both agent CLIs accept the GNU `--model=opus` form as well as the two-token
    // one, so split an inline value off here and normalize to `[flag, value]`.
    // (`eq > 2` keeps the bare `--` separator and a leading `--=` out of this.)
    const eq = a.indexOf("=");
    const inline = a.startsWith("--") && eq > 2;
    const flag = inline ? a.slice(0, eq) : a;
    if (a === "--attach" || a === "-a") attach = true;
    else if (a === "--no-worktree") worktree = false;
    else if (flag === "--worktree") {
      const p = parseWorktreeFlag(a, inline ? eq : -1, rest[i + 1]);
      if (p === undefined) worktree = true;
      else worktreePath = p;
    }
    else if (flag === "--name" || a === "-n") name = inline ? a.slice(eq + 1) : rest[++i];
    // Must stay ABOVE the unknown-`--flag` catch-all below, or `--orchestrator`
    // would be rejected outright and `-O` would fall through into the prompt —
    // launching an ordinary session that looks like it was asked to orchestrate.
    else if (flag === "--orchestrator" || a === "-O" || a.startsWith("-O=")) {
      // A boolean flag: `--orchestrator=false` reads as "off" to a human but
      // would enable it here, so an inline value is refused, never guessed.
      // `-O=…` is checked separately because `inline` only recognises the `--`
      // form, and single-dash args fall through to the prompt rather than to the
      // unknown-flag guard — so without this it would silently become prompt text.
      if (inline || a.startsWith("-O=")) {
        console.error(`launch failed: --orchestrator takes no value (got "${a}")`);
        process.exit(1);
      }
      orchestrator = true;
    }
    else if (a === "--unattended") unattended = true;
    else if (a === "--copilot") agent = "copilot";
    else if (a === "--claude") agent = "claude";
    else if (a === "--codex") agent = "codex";
    else if (flag === "--agent") {
      const v = inline ? a.slice(eq + 1) : rest[++i];
      if (!AGENTS.includes(v as AgentSource)) {
        console.error(`launch failed: --agent must be one of ${AGENTS.join(", ")}, got "${v ?? ""}"`);
        process.exit(1);
      }
      agent = v as AgentSource;
    } else if (Object.hasOwn(FORWARDABLE_LAUNCH_FLAGS, flag)) {
      // Value flags: take the inline `=value`, else the next token verbatim. A
      // missing value (empty, or end of argv) or — in the two-token form, where
      // it's ambiguous — another flag in its place is a mistake, not a model
      // named "--attach".
      const v = inline ? a.slice(eq + 1) : rest[++i];
      if (v === undefined || v === "" || (!inline && v.startsWith("--"))) {
        console.error(`launch failed: ${flag} needs a value`);
        process.exit(1);
      }
      forwardArgv.push(flag, v);
    } else if (a === "--") { positionals.push(...rest.slice(i + 1)); break; }
    else if (a.startsWith("--")) {
      const known = Object.keys(FORWARDABLE_LAUNCH_FLAGS).join(", ");
      console.error(
        `launch failed: unknown flag "${a}" (forwardable agent flags: ${known}; ` +
        `use -- before prompt text that starts with --)`,
      );
      process.exit(1);
    } else positionals.push(a);
  }
  checkForwardedFlags(forwardArgv, agent);
  return { name, worktree, worktreePath, attach, orchestrator, unattended, agent, forwardArgv, positionals };
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

export async function runLaunch(): Promise<void> {
  const { name, worktree, worktreePath, attach, orchestrator, unattended, agent, forwardArgv, positionals } = parseLaunchArgs();
  // `--worktree=<path>` says exactly where to run, so the flags that would pick
  // a different directory are contradictions, not overrides to be resolved by
  // position: `--name` would name a worktree that isn't used, `--no-worktree`
  // would run in cwd, and a bare `--worktree` would create one. Refuse all three
  // rather than pick a winner the caller can't see.
  if (worktreePath !== undefined && (name !== undefined || worktree !== undefined)) {
    const other = name !== undefined ? "--name" : worktree ? "a bare --worktree" : "--no-worktree";
    console.error(`launch failed: --worktree=<path> can't be combined with ${other} (it already says where to run)`);
    process.exit(1);
  }
  // Orchestrator mode rides on `--append-system-prompt`, which Copilot has no
  // equivalent for, so a Copilot orchestrator would run with none of the
  // coordinate-don't-implement instructions. Refuse loudly rather than degrade.
  // `agent` defaults to claude, so "copilot" here can only mean a flag asked for
  // it — no need to track explicitness separately.
  if (orchestrator && agent === "copilot") {
    console.error(`launch failed: --orchestrator is Claude-only (Copilot has no --append-system-prompt equivalent)`);
    process.exit(1);
  }
  // `--unattended` only ever loosens an ORCHESTRATOR's approvals — a plain
  // background session is already unattended. Accepting it elsewhere would read
  // as "this made a difference" when it changed nothing at all.
  if (unattended && !orchestrator) {
    console.error(`launch failed: --unattended only applies with --orchestrator (background sessions already run unattended)`);
    process.exit(1);
  }
  // An orchestrator squash-merges into the main branch, and git allows the main
  // branch in only ONE working tree — the primary checkout. A worktree would give
  // it an empty branch it never commits to while forcing every merge to reach out
  // to the repo root, so orchestrators run in the main checkout unless asked
  // otherwise. Ordinary background sessions keep their isolation.
  const useWorktree = worktree ?? !orchestrator;
  const prompt = positionals.join(" ").trim();
  const { plan, id, cwd, adopted, error } = launchTask(process.cwd(), {
    prompt,
    name,
    worktree: useWorktree,
    worktreePath,
    agent,
    orchestrator,
    unattended,
    forwardArgv,
  });
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
        title: prompt || (orchestrator ? "orchestrator session" : "background session"),
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
    const kind = orchestrator ? "orchestrator" : "background";
    console.log(`▸ launched ${kind} session ${id ?? `— ${agent} assigns its own id`}`);
    console.log(`  window:  ${plan.tmuxName}   (in ${cwd})`);
    console.log(id ? `  status:  ${SELF_CMD} status ${id}` : `  id:      ${SELF_CMD} list   (then: ${SELF_CMD} status <id>)`);
    console.log(`  attach:  open agendo and pick it (running → attach), or rerun with --attach`);
  }
  process.exit(0);
}
