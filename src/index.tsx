#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { spawnSync } from "child_process";
import App from "./ui/App.tsx";
import { basename } from "path";
import {
  tmuxAvailable, enterLauncherSession, shortId, sessionName, liveTargetForShortId,
  liveManagedPaths, managedKind, capturePaneState, readPaneState, paneReadiness, paneShells, stripAnsi,
  sessionRoot, currentSessionName, killWindow, killManagedTarget, windowLocations, isPlaceholderWindow, exactTarget,
  paneResumeDialogActive, RESUME_DIALOG_WAIT_MS,
  type SessionKind, type Readiness,
} from "./tmux.ts";
import { FORWARDABLE_LAUNCH_FLAGS, launchTask, llmGuide, openSession, SELF_CMD, withSelfCmdEnv, type OpenPlan } from "./launch.ts";
import { SessionIndex } from "./sessions.ts";
import { findPeer } from "./peer.ts";
import { idleSeconds, isStalled, resolveStalledAfterMs } from "./idle.ts";
import { branchSync, type BranchSync } from "./gitrefs.ts";
import { restoreTabs, recordLaunchedSession, resolveWindowSession, forgetRestoreTab, idBearingName } from "./restore.ts";
import { resolveContext, normalizeCwd } from "./context.ts";
import { makeSessionScope, scopeFilter, scopeFlagValue, scopeNote, type SessionScope } from "./scope.ts";
import { loadModel, refreshLiveTmux, filterModelByRepos, type LoadedModel } from "./model.ts";
import { detectScopeProvider } from "./provider.ts";
import { printJson } from "./output.ts";
import { discoverGitReposUnder } from "./repos.ts";
import { parseDuration, runWaitCli } from "./wait.ts";
import { AGENTS } from "./types.ts";
import type { AgentSession, AgentSource, PRWithSessions, WorkItem, WorkflowStatus } from "./types.ts";
import { workflowStatus } from "./workflows.ts";
import { HELP } from "./cli/help.ts";
import { flushWarnings } from "./cli/warnings.ts";
import { readyCell, readyWidth, rowCompactionPercent, rowResetAt, timeAgo } from "./cli/cells.ts";
import { currentModelOptions } from "./cli/links.ts";
import { runStatus } from "./cli/status.ts";
import { runOpen } from "./cli/open.ts";
import { runSend } from "./cli/send.ts";
import { runUnblock } from "./cli/unblock.ts";

/**
 * Trailing marker for a stalled session, in the same slot as the ⛁ (background
 * shells) and ◆ (running workflows) markers. Deliberately a marker rather than a
 * new column or a changed `ready` value: readiness is load-bearing for `send` /
 * `wait` / auto-resume and must keep reading exactly as before. The `age` column
 * already carries the idle time this qualifies.
 */
const STALLED_MARK = "⚠stalled";

/** Short kind labels for the `list` columns, matching the menu's {bg}/{new} badges. */
const KIND_LABEL: Record<SessionKind, string> = {
  background: "bg",
  new: "new",
  workitem: "wi",
  pr: "pr",
  resumed: "—",
};

/**
 * Readiness states where closing a session would destroy work in flight, so
 * `close` refuses them without `--force` (mirroring how `send` refuses to type
 * into a non-ready pane): a turn being generated ("busy"), a conversation being
 * rewritten ("compacting"), text typed but not yet submitted ("queued"), or an
 * open question waiting on an answer ("dialog").
 *
 * The states NOT listed are deliberately closeable: "ready" (idle, the finished
 * session this command exists for), "limited" (stuck at its usage cap — a prime
 * close candidate) and "unknown". "unknown" is what a pane whose agent already
 * exited looks like — a bare shell prompt with no input box — which is the most
 * obvious thing of all to want closed; refusing it would push callers straight
 * back to hand-rolled `tmux kill-window`, the failure this command replaces.
 *
 * Close-specific, so it stays here rather than in wait.ts beside that command's
 * own BUSY_STATES: the two overlap today but answer different questions ("is it
 * still working?" vs "would ending it lose something?"), and `close` refuses two
 * settled-but-unsaved states that `wait` considers done. Declared before the
 * subcommand dispatch so the hoisted `runClose` never reads it in the temporal
 * dead zone.
 */
const UNSAFE_CLOSE_STATES = new Set<Readiness>(["busy", "compacting", "queued", "dialog"]);

/**
 * Parse a required duration flag, exiting with a clear error on bad/missing
 * input. Lives here because it validates argv for THIS module's flags
 * (`--stalled-after` on `status` and `list`); `wait` parses its own argv inside
 * wait.ts. The duration grammar itself is not duplicated — `parseDuration` is
 * imported from wait.ts, so `2s`/`5m`/`1h` mean the same thing everywhere.
 */
function requireDuration(cmd: string, flag: string, s: string | undefined): number {
  const ms = parseDuration(s);
  if (ms === null) {
    console.error(`${cmd}: ${flag} needs a duration like 500ms, 2s, 5m, 1h (got "${s ?? ""}")`);
    process.exit(1);
  }
  return ms;
}

if (process.argv.includes("--help") || process.argv.includes("-h") || process.argv[2] === "help") {
  console.log(HELP);
  process.exit(0);
}

// `--llm`: the detailed background-session workflow, kept out of the injected
// system prompt so it's only loaded when an agent actually needs it.
if (process.argv.includes("--llm") || process.argv[2] === "llm") {
  console.log(llmGuide());
  process.exit(0);
}

if (!tmuxAvailable()) {
  console.error("tmux is required but was not found on PATH.");
  process.exit(1);
}

// `status <id>`: print a session's state + the same recent-activity summary the
// menu shows, so an agent that launched a background session can poll it.
if (process.argv[2] === "status") {
  const rest = process.argv.slice(3);
  let full = false;
  // `--urls` opts into the backend round-trip that resolves the session's linked
  // PR / work item. Off by default: `status` is the command orchestrators poll,
  // and a model load costs network + backend auth on every call.
  let withUrls = false;
  let token: string | undefined;
  // The scope selectors don't pick the session (an id still does) — they narrow
  // the set the id is resolved against, so an orchestrator polling one repo can
  // never be handed a same-short-id session from a different project.
  let pathArg: string | undefined;
  let repoArg: string | undefined;
  // `--stalled-after` takes a value too, so the argv walk can't be a bare `find`
  // — none of these values may be mistaken for the session id.
  let stalledAfterMs: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--full" || a === "-F") full = true;
    else if (a === "--urls" || a === "--links") withUrls = true;
    else if (a === "--path") pathArg = requireValue("status", a, rest[++i]);
    else if (a === "--repo") repoArg = requireValue("status", a, rest[++i]);
    else if (a === "--stalled-after") stalledAfterMs = requireDuration("status", "--stalled-after", rest[++i]);
    // A dashed token can't be an id, so reject it rather than take it as one: a
    // typo'd or `=`-joined scope flag (`--rep x`, `--repo=x`) would otherwise
    // parse to "no scope" and print a confidently UNSCOPED report — defeating,
    // silently, the exact guard the caller asked for. The same goes for
    // `--stalled-after=1h`, which used to fall through to the id slot and fail
    // with a baffling `No session found for "--stalled-after=1h"`.
    else if (a.startsWith("-")) {
      console.error(`status: unknown argument "${a}"`);
      process.exit(1);
    } else if (token === undefined) token = a;
  }
  await runStatus(
    token,
    full,
    makeSessionScope({ path: pathArg, repo: repoArg }, process.cwd()),
    withUrls,
    stalledAfterMs,
  );
  process.exit(0);
}

// `open <id>`: open the PR / work item a session links to in the browser — the
// CLI mirror of the menu's `o` action, resolved through the same model reverse
// index (`sessionLinks`). The URLs are always printed, so the command is useful
// as a "give me the link" even on a headless host with no browser to launch.
if (process.argv[2] === "open") {
  let token: string | undefined;
  let want: "pr" | "item" | undefined;
  let printOnly = false;
  // Same scope selectors as `status`, for the same reason: `open` resolves a
  // short id too, and launching a browser at the wrong repo's PR is a worse
  // outcome than printing the wrong status.
  let pathArg: string | undefined;
  let repoArg: string | undefined;
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const sel = a === "--pr" ? "pr" : a === "--issue" || a === "--work-item" || a === "--workitem" ? "item" : null;
    if (sel) {
      // Two conflicting selectors is a mistake, not a silent last-one-wins.
      if (want && want !== sel) {
        console.error(`open: use only one of --pr / --work-item`);
        process.exit(1);
      }
      want = sel;
    } else if (a === "--print" || a === "-p") printOnly = true;
    else if (a === "--path") pathArg = requireValue("open", a, rest[++i]);
    else if (a === "--repo") repoArg = requireValue("open", a, rest[++i]);
    else if (a.startsWith("-")) {
      console.error(`open: unknown argument "${a}"`);
      process.exit(1);
    } else if (token === undefined) token = a;
    else {
      console.error(`open: unexpected argument "${a}"`);
      process.exit(1);
    }
  }
  await runOpen(token, want, printOnly, makeSessionScope({ path: pathArg, repo: repoArg }, process.cwd()));
  process.exit(0);
}

// `launch [flags] <prompt>`: spin up a managed session without the menu. The
// launcher creates an isolated worktree (unless `--no-worktree`) and a
// `cl-bg-…` agent window it can attach to later (Claude by default, or Copilot /
// Codex via `--agent <name>` and its shorthand). Used both by humans and by a running agent
// the user asked to start a background session. Detached by default; `--attach`
// switches/attaches to it immediately. A small allowlist of agent flags
// (`FORWARDABLE_LAUNCH_FLAGS`, e.g. `--model`) is passed through to the new
// agent's argv; any other dashed argument is rejected rather than silently
// swallowed into the prompt, so a typo'd flag can't quietly change the task.
if (process.argv[2] === "launch") {
  let name: string | undefined;
  // undefined = "not specified", so the default can depend on --orchestrator below.
  let worktree: boolean | undefined;
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
    else if (a === "--worktree") worktree = true;
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
  // The agent can be named after a forwarded flag (`--model x --copilot`), so the
  // per-agent support check only makes sense once the whole argv is parsed.
  for (let i = 0; i < forwardArgv.length; i += 2) {
    const flag = forwardArgv[i];
    if (!FORWARDABLE_LAUNCH_FLAGS[flag]?.agents.includes(agent)) {
      console.error(`launch failed: ${flag} isn't supported by --agent ${agent}`);
      process.exit(1);
    }
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
  const { plan, id, cwd, error } = launchTask(process.cwd(), {
    prompt,
    name,
    worktree: useWorktree,
    agent,
    orchestrator,
    unattended,
    forwardArgv,
  });
  if (error || !plan) {
    console.error(`launch failed: ${error ?? "unknown error"}`);
    process.exit(1);
  }
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

// `send <id> <prompt>`: type a prompt into a running session's input and submit
// it — but only if the TUI looks idle/ready, so we never clobber an open
// question, a mid-turn generation, or text already queued in the box.
if (process.argv[2] === "send") {
  let id: string | undefined;
  let force = false;
  // How long to wait for the input box to come back after answering claude's
  // resume dialog (only used on that path).
  let dialogWaitMs = RESUME_DIALOG_WAIT_MS;
  let json = false;
  const parts: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--force" || a === "-f") force = true;
    // Recognized anywhere in argv, as --force already is: both are valueless, so
    // neither can swallow a word of the prompt, and `--` still passes either
    // spelling through literally.
    else if (a === "--json") json = true;
    // Only before the prompt begins: unlike --force, this flag consumes the NEXT
    // token, so recognizing it mid-prompt would eat a word of the message. Shares
    // `wait`'s duration grammar (and its parser, which lives in wait.ts) so the
    // two commands can't drift into accepting different spellings of "2s".
    else if (a === "--timeout" && parts.length === 0) {
      const ms = parseDuration(rest[++i]);
      if (ms === null) {
        console.error(`send: --timeout needs a duration like 500ms, 2s, 5m, 1h (got "${rest[i] ?? ""}")`);
        process.exit(1);
      }
      dialogWaitMs = ms;
    }
    else if (a === "--") { parts.push(...rest.slice(i + 1)); break; }
    else if (id === undefined) id = a;
    else parts.push(a);
  }
  await runSend(id, parts.join(" ").trim(), force, dialogWaitMs, json);
  process.exit(0);
}

// `list` (alias `ls`): print the managed sessions that are running right now —
// one per line, with input readiness and how each was started — so an agent (or
// human) can discover the background sessions it can `status`/`send` to. The
// default stays live-only and model-free (fast, no backend auth needed); the
// flags below opt into richer, association-resolving output for orchestrators.
if (process.argv[2] === "list" || process.argv[2] === "ls") {
  // Subcommand routing: `list pr|prs` and `list issues|wi|work-items|…` are
  // resource lists (open PRs / issues-work-items and their associated sessions),
  // distinct from the default session list. Only the exact keywords route here;
  // any other non-dash positional falls through to the session list's `[dir]`
  // path filter, and the dashed `--pr`/`--issue` stay session-list query flags.
  const sub = process.argv[3];
  const PR_SUBS = new Set(["pr", "prs"]);
  const ISSUE_SUBS = new Set(["issue", "issues", "wi", "work-item", "work-items", "workitem", "workitems"]);
  if (sub !== undefined && (PR_SUBS.has(sub) || ISSUE_SUBS.has(sub))) {
    let json = false;
    // Optional `[dir]` positional: the same path context the TUI takes, narrowing
    // the listing to the repos found inside it. `--repo-filter`/`--no-repo-filter`
    // override the default (on whenever a dir is given), mirroring the menu's `f`.
    let dirArg: string | undefined;
    let repoFilter: boolean | undefined;
    for (const a of process.argv.slice(4)) {
      if (a === "--json") json = true;
      else if (a === "--repo-filter") repoFilter = true;
      else if (a === "--no-repo-filter") repoFilter = false;
      else if (!a.startsWith("-") && dirArg === undefined) dirArg = a;
      else {
        console.error(`list ${sub}: unknown argument "${a}"`);
        process.exit(1);
      }
    }
    const root = dirArg ? resolveContext(dirArg, process.cwd()).filterRoot : null;
    const opts = { json, filterRoot: root, repoFilter: repoFilter ?? !!root };
    if (PR_SUBS.has(sub)) await runListPrs(opts);
    else await runListIssues(opts);
    process.exit(0);
  }
  let json = false;
  let all = false;
  let pr: number | undefined;
  let item: number | undefined;
  let stalledAfterMs: number | undefined;
  // Optional `[dir]` positional (or its `--path` flag form) scopes the listing to
  // sessions whose cwd is under it, mirroring the TUI's path filter; resolved
  // against the current directory. `--repo` scopes by repo instead/as well.
  let dirArg: string | undefined;
  let repoArg: string | undefined;
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--all" || a === "--include-idle") all = true;
    else if (a === "--stalled-after") stalledAfterMs = requireDuration("list", "--stalled-after", rest[++i]);
    else if (a === "--pr") pr = Number(rest[++i]);
    else if (a === "--issue" || a === "--work-item" || a === "--workitem") item = Number(rest[++i]);
    // `--path` and the `[dir]` positional are the SAME slot, so a second one is a
    // mistake — silently letting the later win would scope the listing to
    // something other than what the command line reads as. Both spellings share
    // one guard so the error doesn't depend on which came first.
    else if (a === "--path") {
      if (dirArg !== undefined) duplicatePathScope();
      dirArg = requireValue("list", a, rest[++i]);
    } else if (a === "--repo") repoArg = requireValue("list", a, rest[++i]);
    else if (!a.startsWith("-")) {
      if (dirArg !== undefined) duplicatePathScope();
      dirArg = a;
    } else {
      console.error(`list: unknown argument "${a}"`);
      process.exit(1);
    }
  }
  if ((pr !== undefined && !Number.isFinite(pr)) || (item !== undefined && !Number.isFinite(item))) {
    console.error(`list: --pr/--issue/--work-item need a numeric id`);
    process.exit(1);
  }
  await runList({
    json, all, pr, item,
    scope: makeSessionScope({ path: dirArg, repo: repoArg }, process.cwd()),
    stalledAfterMs,
  });
  process.exit(0);
}

// `resume <id>`: headless resume of an idle (or already-running) session. By
// default we create/attach its tmux window *detached* — the orchestrator gets
// the session back running without stealing the terminal — and print how to
// reach it. `--attach` hands the terminal over the way `launch --attach` does.
if (process.argv[2] === "resume") {
  let attach = false;
  let id: string | undefined;
  const rest = process.argv.slice(3);
  for (const a of rest) {
    if (a === "--attach" || a === "-a") attach = true;
    else if (id === undefined) id = a;
  }
  await runResume(id, attach);
  process.exit(0);
}

// `close <id>` (aliases `kill`, `stop`): end a running session by killing the
// tmux window it lives in, and nothing else. The aliases exist because an agent
// that guesses the wrong verb and gets "no such command" falls back to raw
// `tmux kill-window` — the exact hand-rolled tmux this subcommand exists to
// remove. Everything the session produced (worktree, branch, commits) stays on
// disk, so `resume` can bring it back.
if (process.argv[2] === "close" || process.argv[2] === "kill" || process.argv[2] === "stop") {
  const verb = process.argv[2];
  let id: string | undefined;
  let force = false;
  for (const a of process.argv.slice(3)) {
    if (a === "--force" || a === "-f") force = true;
    // A command that kills things parses strictly: an unknown flag or a stray
    // extra positional is a mistake, never something to silently ignore.
    else if (a.startsWith("-")) {
      console.error(`${verb}: unknown flag "${a}" (only --force/-f)`);
      process.exit(1);
    } else if (id === undefined) id = a;
    else {
      console.error(`${verb}: unexpected argument "${a}" — close takes exactly one session id`);
      process.exit(1);
    }
  }
  await runClose(id, force, verb);
  process.exit(0);
}

// `unblock <id>`: nudge a session sitting at its usage limit to continue — sends
// <esc>continue<enter>. Distinct from `resume` (which relaunches an idle session
// in a fresh window); this pokes a live, limited pane. Refuses unless the pane is
// still showing the usage-limit notice, so a recovered session isn't clobbered.
if (process.argv[2] === "unblock") {
  let id: string | undefined;
  let force = false;
  for (const a of process.argv.slice(3)) {
    if (a === "--force" || a === "-f") force = true;
    else if (id === undefined) id = a;
  }
  await runUnblock(id, force);
  process.exit(0);
}

// `wait [id...]`: block until the selected session(s) reach a desired state (like
// `gh run watch`), then exit 0; exit non-zero on timeout. It's the notification
// primitive for an orchestrator watching background sessions — run it in the
// background and let its EXIT be the wake-up, instead of re-polling `status` on a
// guessed cadence. See wait.ts for the poll contract and its cost.
if (process.argv[2] === "wait") {
  process.exit(await runWaitCli(process.argv.slice(3)));
}

// By default agendo runs inside a single canonical tmux host session — `agendo`
// unscoped, or `agendo-<basename of [path]>` when scoped — with the menu in its
// first window and every agent opening as another window in the same session.
// We (re-)enter that session here — creating it if needed, attaching from
// outside tmux or switch-client from inside — then run the menu inside its
// first window by re-invoking this entrypoint with `--no-tmux`. On a fresh
// create, previously-open agent tabs are lazily restored (see restore.ts).
//
// `--no-tmux` opts out: render the menu inline in the current terminal (each
// agent then runs as its own detached session we attach to). `--tmux` is still
// accepted for muscle memory — it's simply the default now. Subcommands above
// have already exited, so this only governs the interactive menu.
//
// The optional `[path]` positional + `-s/--session` override scope the menu
// (both the tmux-host bootstrap below and the bare menu render further down).
// Parsed here, once, so the two entry paths share one interpretation. A
// positional is a path only if it isn't a known subcommand — those were all
// handled above and exited, so anything reaching here is a path. Flags
// (`--tmux`, `--no-tmux`, `-s`, etc.) are skipped.
function parseMenuArgs(): { pathArg?: string; session?: string } {
  let pathArg: string | undefined;
  let session: string | undefined;
  const rest = process.argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-s" || a === "--session") session = rest[++i];
    else if (!a.startsWith("-") && pathArg === undefined) pathArg = a;
  }
  return { pathArg, session };
}
const { pathArg, session } = parseMenuArgs();
const ctx = resolveContext(pathArg, process.cwd(), session);

if (!process.argv.includes("--no-tmux")) {
  // Basename collision guard: refuse to attach a differently-rooted launcher to
  // an existing host session, so two paths sharing a basename don't merge. The
  // user disambiguates with `-s <name>`.
  if (ctx.filterRoot) {
    const existingRoot = sessionRoot(ctx.hostSession);
    if (existingRoot && existingRoot !== ctx.filterRoot) {
      console.error(`A launcher session "${ctx.hostSession}" is already scoped to ${existingRoot}.`);
      console.error(`Pass a distinct name:  agendo ${pathArg ?? "."} -s <name>`);
      process.exit(1);
    }
  }
  const menuArgs = [...(pathArg ? [pathArg] : []), ...(session ? ["-s", session] : []), "--no-tmux"];
  enterLauncherSession(
    ctx.hostSession,
    ctx.filterRoot,
    process.cwd(),
    // The menu inside tmux is the process that will actually spawn agents, so it
    // carries our invocation forward too (`SELF_CMD_ENV`) — otherwise it would
    // re-derive one from its own argv and hand the sessions it starts a different
    // way of naming the same build.
    withSelfCmdEnv([process.argv[0], process.argv[1], ...menuArgs]),
    () => restoreTabs(ctx.hostSession),
  );
  process.exit(0);
}

interface ListOptions {
  /** Emit JSON instead of a human table. */
  json: boolean;
  /** Also include idle (not-running) sessions. */
  all: boolean;
  /** Only sessions linked to this PR id (implies the enriched, model-backed path). */
  pr?: number;
  /** Only sessions linked to this work-item / issue id (enriched path). */
  item?: number;
  /** Scope to sessions by cwd (`[dir]`/`--path`) and/or repo (`--repo`); null = all. */
  scope: SessionScope | null;
  /** `--stalled-after` override, in ms; falls back to config (see src/idle.ts). */
  stalledAfterMs?: number;
}

/** One session as reported by the enriched (`--json` / `--all` / query) list. */
interface ListRow {
  id: string;
  shortId: string;
  source: AgentSource;
  running: boolean;
  /** Input readiness from the live pane, or null when idle (no pane to read). */
  readiness: Readiness | null;
  /**
   * Sitting on claude's OWN resume dialog — the same signal `wait --json`
   * reports. Carried here because it is the one case where a large `idleSeconds`
   * means the opposite of what it looks like: the session hasn't run yet, so the
   * age belongs to the previous run and `stalled` is deliberately false. Without
   * it a consumer would have to re-infer that from the pane itself.
   */
  resumeDialog: boolean;
  /**
   * When the usage limit resets, as an ISO 8601 instant — set only for a
   * "limited" row whose pane states a time (the numbered limit dialog hides it,
   * and we never press a key to reveal it), null otherwise. Machine-readable on
   * purpose: the human list renders the same instant in the local locale.
   *
   * The other reason a consumer wants it: a `limited` row is never `stalled`
   * however old it is (see src/idle.ts), and this is what says when it stops
   * being someone else's problem.
   */
  limitResetAt: string | null;
  /**
   * How far a "compacting" row's progress bar has got (0-100), null for every other
   * state and for a compacting pane that isn't drawing one yet. Like `limitResetAt`,
   * it says how long someone else's pause has left to run — a compacting session is
   * blocked but progressing, and this is the difference between "wait" and "stuck".
   */
  compactionPercent: number | null;
  /** Background shells the running pane reports (0 when idle/unknown). */
  shells: number;
  /** How it was launched, when running (from the live-tmux reconciliation). */
  kind: SessionKind | null;
  branch: string | null;
  cwd: string;
  dir: string;
  title: string;
  /** When the session was last active (ISO 8601), for machine consumers. */
  lastUsed: string;
  /** Seconds since that last activity — idle age, without parsing a timestamp. */
  idleSeconds: number;
  /**
   * QUALIFIER, not a readiness state: the session is live, isn't mid-turn, and
   * has done nothing for at least `stalledAfterSeconds`. It does NOT mean the
   * work is unfinished — agendo cannot know that. See src/idle.ts.
   */
  stalled: boolean;
  /** The threshold `stalled` was judged against, so the flag reads standalone. */
  stalledAfterSeconds: number;
  /**
   * Local-vs-origin state of the session's checkout, read from `.git` ref files
   * (never a `git` process, never a fetch). `null` when undeterminable — which
   * is NOT the same as "in sync". See src/gitrefs.ts.
   */
  git: BranchSync | null;
  /** Linked PR, resolved through the model's reverse index (null if none/unknown). */
  pr: { id: number; url: string } | null;
  /** Linked work item / issue, resolved through the model's reverse index. */
  workItem: { id: number; url: string } | null;
  /**
   * The same two links flattened to top-level fields — null when unlinked, never
   * a partially-built URL. Agents consume this JSON to hand a human a clickable
   * link; a first-class field beats making them reach into a nested object (or,
   * worse, reconstruct the URL from an id and guess the host shape).
   */
  prUrl: string | null;
  workItemUrl: string | null;
  /** Workflow-tool runs the session launched, with their effective status. */
  workflows: { runId: string; name: string; status: WorkflowStatus; summary: string | null }[];
}

/**
 * List sessions. The default (no flags) is unchanged: the live `cl-…` tmux
 * targets, one per line, resolved back to their session and reported with
 * readiness/kind/id/dir/title — fast and needing no backend auth. The `--json`,
 * `--all`/`--include-idle`, and `--pr`/`--issue`/`--work-item` query flags opt
 * into the enriched path, which loads the model so each row carries its branch
 * and linked PR / work item (via `sessionLinks`) and can include idle sessions.
 * An optional scope narrows every mode — plain, enriched and `--json` alike — to
 * the sessions under a path and/or in a repo.
 */
async function runList(opts: ListOptions): Promise<void> {
  const index = await SessionIndex.build();
  const thresholdMs = resolveStalledAfterMs(opts.stalledAfterMs);
  const inScope = scopeFilter(opts.scope);
  const enriched = opts.json || opts.all || opts.pr !== undefined || opts.item !== undefined;
  // The threshold is resolved ONCE, above the mode split, and passed down: every
  // row in every mode is judged against the same number, and the scope filter
  // only decides which rows are printed — never what any of them says.
  //
  // Resolving it read config.json, so drain any complaint about that file before
  // the plain path returns — it never reaches the flush below, and a silently
  // ignored `stalledAfterMinutes` would show up only as a marker that doesn't
  // match what the user configured.
  if (!enriched) {
    flushWarnings("list");
    return runPlainList(index, inScope, thresholdMs);
  }

  const isQuery = opts.pr !== undefined || opts.item !== undefined;
  // Associations come from the model's reverse index. A query MUST have it (the
  // whole point); the other enriched modes degrade gracefully if the backend is
  // unreachable — we still list sessions, just without PR/work-item links.
  let model: LoadedModel | null = null;
  try {
    model = await loadModel(currentModelOptions());
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (isQuery) {
      console.error(`list: could not resolve associations from the backend: ${msg}`);
      process.exit(1);
    }
    console.error(`list: continuing without PR/work-item associations (${msg})`);
  }
  flushWarnings("list");

  const { live, liveKinds, liveWindows } = refreshLiveTmux(index.all);
  const linkOf = (s: AgentSession) => model?.sessionLinks.get(`${s.source}:${s.id}`);

  let sessions: AgentSession[];
  if (isQuery) {
    // Resolve the query against the model's FORWARD associations (the same lists
    // the TUI shows), NOT `sessionLinks` — that reverse index keeps only one
    // PR + one work item per session, so a session on a PR linked to two items
    // (or a branch matching two PRs) would be missed. `model` is guaranteed here
    // (a failed load already exited above). Dedupe by source:id across lists.
    const m = model!;
    const matched = new Map<string, AgentSession>();
    if (opts.pr !== undefined) {
      for (const pr of [...m.linkedPrs, ...m.orphanPrs, ...m.reviewPrs])
        if (pr.id === opts.pr) for (const s of pr.sessions) matched.set(`${s.source}:${s.id}`, s);
    }
    if (opts.item !== undefined) {
      for (const it of [...m.current, ...m.other, ...m.prLinked])
        if (it.id === opts.item) for (const s of it.sessions) matched.set(`${s.source}:${s.id}`, s);
    }
    sessions = [...matched.values()];
  } else if (opts.all) {
    sessions = [...index.all];
  } else {
    sessions = index.all.filter((s) => live.has(sessionName(s)));
  }
  // Scoping (`[dir]`/`--path`, `--repo`): keep only the sessions it selects.
  sessions = sessions.filter(inScope);
  sessions.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());

  const rows: ListRow[] = sessions.map((s) => {
    const canon = sessionName(s);
    const running = live.has(canon);
    const window = liveWindows.get(canon);
    let readiness: Readiness | null = null;
    let shells = 0;
    // Parked on claude's own resume dialog: reads `ready`, but nothing has run
    // yet, so its idle age is the previous run's and it is never stalled.
    let resumeDialog = false;
    let resetAt: number | null = null;
    let compactionPercent: number | null = null;
    if (running && window) {
      const { raw, cursor } = capturePaneState(window);
      readiness = paneReadiness(raw, cursor);
      shells = paneShells(raw);
      resumeDialog = paneResumeDialogActive(raw);
      resetAt = rowResetAt(readiness, raw);
      compactionPercent = rowCompactionPercent(readiness, raw);
    }
    const l = linkOf(s);
    const idle = idleSeconds(s.lastUsed);
    // A link whose URL couldn't be built reads as absent — applied once here so
    // the nested object and the flattened *Url field can never disagree.
    const prLink = l?.pr?.url ? l.pr : null;
    const itemLink = l?.workItem?.url ? l.workItem : null;
    return {
      id: s.id,
      shortId: shortId(s.id),
      source: s.source,
      running,
      readiness,
      resumeDialog,
      limitResetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
      compactionPercent,
      shells,
      kind: running ? liveKinds.get(canon) ?? null : null,
      branch: s.branch ?? null,
      cwd: s.cwd,
      dir: basename(s.cwd) || s.cwd,
      title: s.title.replace(/\s+/g, " ").trim(),
      lastUsed: s.lastUsed.toISOString(),
      idleSeconds: idle,
      stalled: isStalled({ running, readiness, resumeDialog, idleSeconds: idle }, thresholdMs),
      // Exact, NOT floored: a consumer re-deriving `idleSeconds >= stalledAfterSeconds`
      // must reach the same verdict this row already carries, including for
      // sub-second thresholds.
      stalledAfterSeconds: thresholdMs / 1000,
      // Ref-file reads only, and only here on the one-shot CLI path — never from
      // SessionIndex.build()/loadLocalSessions(), which the 2s rescan drives.
      // Skipped entirely unless a JSON consumer will actually read it: the human
      // table below doesn't render it, and `--all` can enumerate every session
      // on disk.
      git: opts.json ? branchSync(s.cwd) : null,
      // Siblings of the fields above, not nested under them: a consumer reads
      // `stalled` and `prUrl` off the same row object.
      pr: prLink,
      workItem: itemLink,
      prUrl: prLink?.url ?? null,
      workItemUrl: itemLink?.url ?? null,
      workflows: (s.workflows ?? []).map((w) => ({
        runId: w.runId,
        name: w.name,
        status: workflowStatus(w, running),
        summary: w.summary ?? null,
      })),
    };
  });

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    // Name the scope when there is one: an empty listing under a `--repo` typo
    // otherwise reads as "nothing is running" rather than "nothing matched".
    const where = scopeNote(opts.scope);
    console.log(
      isQuery
        ? `No sessions linked to that item${where} (query covers open PRs / work items in the current identity's scope).`
        : `No sessions${where}.`,
    );
    return;
  }
  const itemLabel = model?.provider === "github" ? "issue" : "wi";
  const ready = rows.map((r) =>
    readyCell(r.readiness, r.limitResetAt === null ? null : Date.parse(r.limitResetAt), r.compactionPercent),
  );
  const rw = readyWidth(ready);
  console.log(
    ["", "ready".padEnd(rw), "kind".padEnd(3), "id".padEnd(12), "age".padEnd(8), "dir".padEnd(20), "pr".padEnd(6), itemLabel.padEnd(6), "title"].join("  "),
  );
  for (const [i, r] of rows.entries()) {
    const wfRunning = r.workflows.filter((w) => w.status === "running").length;
    console.log(
      [
        r.running ? "●" : "○",
        ready[i].padEnd(rw),
        (r.kind ? KIND_LABEL[r.kind] : "-").padEnd(3),
        r.shortId.padEnd(12),
        timeAgo(new Date(r.lastUsed)).padEnd(8),
        r.dir.slice(0, 20).padEnd(20),
        (r.pr ? `!${r.pr.id}` : "-").padEnd(6),
        (r.workItem ? `#${r.workItem.id}` : "-").padEnd(6),
        r.title.slice(0, 44) +
          (r.stalled ? `  ${STALLED_MARK}` : "") +
          (r.shells > 0 ? `  ⛁${r.shells}` : "") +
          (wfRunning > 0 ? `  ◆${wfRunning}` : ""),
      ].join("  ").trimEnd(),
    );
  }
}

/**
 * The default, unchanged `list`: the managed sessions running right now, one per
 * line. We walk the live `cl-…` tmux targets and resolve each back to its
 * session — id-bearing names (`cl-bg-`/`cl-new-`/`cl-claude-`/`cl-copilot-`/
 * `cl-codex-`) by embedded short id, work-item / PR / agent-assigns-its-own-id
 * names by working directory (as in model.ts)
 * — then report readiness, kind, id, location and title. Running-only and
 * model-free by design. `inScope` is the `--path`/`--repo` filter (match-all when
 * no selector was given); `thresholdMs` (already resolved by the caller) decides
 * the ⚠stalled marker. The two are independent: scoping picks which sessions are
 * listed, and each listed session is judged exactly as it would be unscoped.
 */
function runPlainList(
  index: SessionIndex,
  inScope: (s: AgentSession) => boolean,
  thresholdMs: number,
): void {
  const seen = new Set<string>();
  // Cells, not finished lines: the readiness column's width isn't known until
  // every row is in (a `limited <time>` cell is wider than the state words).
  const rows: string[][] = [];
  for (const { name, cwd, placeholder } of liveManagedPaths()) {
    const kind = managedKind(name);
    if (!kind) continue;
    // Skip restored-but-unopened placeholder windows — they're idle bash waiting
    // for a keypress, not running agents, so listing them would mislead.
    if (placeholder) continue;
    // Same attribution the TUI uses (id-bearing → exact session; id-less
    // cl-wi-/cl-pr- → MRU session in the pane's cwd, matched on a normalized
    // path). Shared so the CLI list can't drift from the menu's running state.
    const s = resolveWindowSession(index.all, name, cwd);
    if (!s) continue;
    // Scoping: skip sessions the requested path / repo filter doesn't select.
    if (!inScope(s)) continue;
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { raw, cursor } = capturePaneState(name);
    const shells = paneShells(raw);
    const readiness = paneReadiness(raw, cursor);
    // Running-workflow marker (◆N): the session is live here by construction.
    const wfRunning = (s.workflows ?? []).filter((w) => workflowStatus(w, true) === "running").length;
    // …and so is the liveness the stall qualifier requires. A pane on claude's
    // own resume dialog is excluded there: it reads `ready` but hasn't run yet.
    // A `limited` one is excluded too, by the shared settled test — the readiness
    // cell beside this already says when its cap lifts, so the two never both
    // describe the same pause.
    const stalled = isStalled(
      { running: true, readiness, resumeDialog: paneResumeDialogActive(raw), idleSeconds: idleSeconds(s.lastUsed) },
      thresholdMs,
    );
    rows.push([
      "●",
      readyCell(readiness, rowResetAt(readiness, raw), rowCompactionPercent(readiness, raw)),
      KIND_LABEL[kind].padEnd(3),
      shortId(s.id),
      timeAgo(s.lastUsed).padEnd(8),
      (basename(s.cwd) || s.cwd).slice(0, 24).padEnd(24),
      s.title.replace(/\s+/g, " ").slice(0, 44),
      [stalled ? STALLED_MARK : "", shells > 0 ? `⛁${shells}` : "", wfRunning > 0 ? `◆${wfRunning}` : ""]
        .filter(Boolean)
        .join(" "),
    ]);
  }
  if (rows.length === 0) {
    console.log("No running sessions.");
    return;
  }
  const rw = readyWidth(rows.map((r) => r[1]));
  for (const [dot, ready, ...rest] of rows) console.log([dot, ready.padEnd(rw), ...rest].join("  ").trimEnd());
}

/** A session working a PR / issue's branch, as reported by the resource lists. */
interface AssocSession {
  id: string;
  shortId: string;
  source: AgentSource;
  running: boolean;
}

/**
 * The sessions matched onto a PR / work item, ranked best-first: running before
 * idle, then most-recently-used. The human table shows only the first (the one
 * an orchestrator would poke); JSON keeps them all, first being the best pick.
 */
function assocSessions(sessions: AgentSession[], live: Set<string>): AssocSession[] {
  return [...sessions]
    .sort((a, b) => {
      const ra = live.has(sessionName(a));
      const rb = live.has(sessionName(b));
      if (ra !== rb) return ra ? -1 : 1;
      return b.lastUsed.getTime() - a.lastUsed.getTime();
    })
    .map((s) => ({ id: s.id, shortId: shortId(s.id), source: s.source, running: live.has(sessionName(s)) }));
}

/** Shared options of the two resource lists (`list pr` / `list issues`). */
interface ResourceListOptions {
  /** Emit JSON instead of a human table. */
  json: boolean;
  /** Path context from the `[dir]` positional (absolute), or null for none. */
  filterRoot: string | null;
  /** Whether to narrow the listing to the repos inside that path context. */
  repoFilter: boolean;
}

/**
 * Load the model the way the menu does for a path context: the git repos found
 * under `[dir]` widen the fetch set (so a repo there that never hosted a session
 * is still queried), and — unless `--no-repo-filter` — narrow the work-item / PR
 * lists to them. A dir holding no repo at all is far more likely a wrong path
 * than an intentional "show nothing", so we say so and leave the list unfiltered.
 * The backend is resolved from the dir too — the tracker its origin points at
 * (or, for a plain parent folder, its repos' origins) wins over the persisted
 * default, exactly as the menu does — otherwise we'd query one backend and filter
 * it against the other's repo identities.
 */
async function loadScopedModel(opts: ResourceListOptions): Promise<LoadedModel> {
  const scopeRepos = opts.filterRoot ? discoverGitReposUnder(opts.filterRoot) : [];
  if (opts.filterRoot && scopeRepos.length === 0)
    console.error(`list: no git repos found under ${opts.filterRoot} — listing everything.`);
  const forced = opts.filterRoot ? detectScopeProvider(opts.filterRoot, scopeRepos) : null;
  const model = await loadModel({ ...currentModelOptions(forced), scopeRepos });
  return filterModelByRepos(model, opts.repoFilter ? model.repoScope : null);
}

/**
 * `list pr|prs`: the current identity's OPEN pull requests from the active
 * backend, each with the session working its branch (running one preferred) — an
 * orchestrator's "what PRs are in flight and which can I delegate to / poke". We
 * reuse the model's forward PR lists (linkedPrs + orphanPrs — PRs I created;
 * review PRs are someone else's, so excluded) and its live-tmux set for the
 * association, so there's no new matcher. `--json` emits the full rows (id +
 * branch + status + ci + sessions[]) for scripting.
 */
async function runListPrs(opts: ResourceListOptions): Promise<void> {
  let model: LoadedModel;
  try {
    model = await loadScopedModel(opts);
  } catch (e) {
    flushWarnings("list pr");
    console.error(`list pr: could not load pull requests from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
    return;
  }
  flushWarnings("list pr");
  // PRs I created: linked-to-a-work-item + orphans. Dedupe by repo:id — GitHub PR
  // numbers are per-repo, so id alone can collide across repos.
  const seen = new Set<string>();
  const prs: PRWithSessions[] = [];
  for (const pr of [...model.linkedPrs, ...model.orphanPrs]) {
    const key = `${pr.repositoryId}:${pr.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prs.push(pr);
  }
  prs.sort((a, b) => b.updatedDate - a.updatedDate || b.id - a.id);

  const prPrefix = model.provider === "github" ? "#" : "!";
  const rows = prs.map((pr) => ({
    id: pr.id,
    title: pr.title.replace(/\s+/g, " ").trim(),
    status: pr.status,
    isDraft: pr.isDraft,
    ci: pr.ci,
    approvedCount: pr.approvedCount,
    requiredCount: pr.requiredCount,
    branch: pr.branch,
    repositoryId: pr.repositoryId,
    repositoryName: pr.repositoryName ?? null,
    // null rather than the "" a backend payload without repo scope yields, so a
    // consumer never pastes a half-built link (see PullRequest.url).
    url: pr.url || null,
    sessions: assocSessions(pr.sessions, model.liveTmux),
  }));

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log("No open pull requests.");
    return;
  }
  console.log(
    ["", "pr".padEnd(6), "ci".padEnd(8), "appr".padEnd(5), "branch".padEnd(24), "session".padEnd(12), "title"].join("  "),
  );
  for (const r of rows) {
    const best = r.sessions[0];
    console.log(
      [
        best?.running ? "●" : r.sessions.length ? "○" : " ",
        `${prPrefix}${r.id}`.padEnd(6),
        r.ci.padEnd(8),
        `${r.approvedCount}/${r.requiredCount}`.padEnd(5),
        r.branch.slice(0, 24).padEnd(24),
        (best?.shortId ?? "-").padEnd(12),
        (r.isDraft ? "[draft] " : "") + r.title.slice(0, 44),
      ].join("  ").trimEnd(),
    );
  }
}

/**
 * `list issues` (aliases `wi` / `work-items`): issues / work items known to the
 * active backend, each with any associated session. Provider-aware vocab —
 * GitHub says "issue", Azure DevOps "work item". Reuses the model's item lists
 * (current + other + prLinked) and its live-tmux set; `--json` emits full rows
 * (id + state + sessions[]).
 */
async function runListIssues(opts: ResourceListOptions): Promise<void> {
  let model: LoadedModel;
  try {
    model = await loadScopedModel(opts);
  } catch (e) {
    flushWarnings("list issues");
    console.error(`list issues: could not load work items from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
    return;
  }
  flushWarnings("list issues");
  const label = model.provider === "github" ? "issue" : "work item";
  const seen = new Set<number>();
  const items: WorkItem[] = [];
  for (const it of [...model.current, ...model.other, ...model.prLinked]) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  items.sort((a, b) => b.id - a.id);

  const rows = items.map((it) => ({
    id: it.id,
    type: it.type,
    title: it.title.replace(/\s+/g, " ").trim(),
    state: it.state,
    url: it.url || null,
    sessions: assocSessions(it.sessions, model.liveTmux),
  }));

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(`No ${label}s found.`);
    return;
  }
  console.log(
    ["", "id".padEnd(7), "state".padEnd(14), "session".padEnd(12), label].join("  "),
  );
  for (const r of rows) {
    const best = r.sessions[0];
    console.log(
      [
        best?.running ? "●" : r.sessions.length ? "○" : " ",
        `#${r.id}`.padEnd(7),
        (r.state || "-").slice(0, 14).padEnd(14),
        (best?.shortId ?? "-").padEnd(12),
        r.title.slice(0, 50),
      ].join("  ").trimEnd(),
    );
  }
}

/**
 * Resolve a session by id-or-tmux-name and resume it. Mirrors `runStatus`'s
 * resolution. Detached by default: `openSession` creates (or navigates to) the
 * session's tmux window without handing over the terminal, so an orchestrator
 * gets it running again headlessly; we then record it into the restore snapshot
 * (a no-op unless it landed in the canonical launcher session) and print how to
 * reach it. `--attach` runs the handover the way `launch --attach` does.
 *
 * We resolve the session's actual live window through `refreshLiveTmux` (the same
 * reconciliation the menu uses) and pass it to `openSession`, so a session
 * already running under a non-id-bearing window (`cl-wi-…`/`cl-pr-…`) is
 * navigated to rather than duplicated. A restored-but-unopened placeholder squats
 * the canonical name but isn't a real agent, so we kill it first — otherwise
 * `openSession` would "navigate" onto the idle bash pane and falsely report success.
 */
async function runResume(token: string | undefined, attach: boolean): Promise<void> {
  if (!token) {
    console.error(`usage: ${SELF_CMD} resume <id> [--attach]`);
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const index = await SessionIndex.build();
  const s = index.all.find((x) => x.id === token || shortId(x.id) === sid);
  if (!s) {
    console.error(`No session found for "${token}".`);
    console.error(`  \`${SELF_CMD} list --all\` lists idle sessions as well as running ones.`);
    process.exit(1);
  }
  const { liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const canon = sessionName(s);
  const liveWindow = liveWindows.get(canon);
  // The session may already be running outside agendo, where there's no window
  // for us to find. Resuming would put a SECOND live claude on one transcript,
  // both appending — so refuse and point at the thing that does work.
  if (!liveWindow) {
    const peer = s.source === "claude" ? await findPeer((id) => id === s.id) : null;
    if (peer) {
      // Say where it actually is. "Outside agendo" is an inference from a failed
      // window lookup; `peer.tmux` is the session's own report, and the two differ
      // when a window exists but wasn't attributed to this session.
      const where = peer.tmux ? `pid ${peer.pid} in tmux ${peer.tmux}` : `pid ${peer.pid}, no tmux pane`;
      console.error(`Session ${shortId(s.id)} is already running outside agendo (${where}, ${peer.status ?? "running"}).`);
      console.error(`Resuming would run two agents on one transcript. Use \`${SELF_CMD} send ${shortId(s.id)} "<prompt>"\` to message it instead.`);
      process.exit(2);
    }
  }
  // A dormant placeholder holds the canonical name but no live agent; drop it so
  // the resume actually starts one instead of no-op'ing onto the idle bash pane.
  if (!liveWindow && livePlaceholders.has(canon)) killWindow(canon);
  const plan = openSession(s, liveWindow);
  if (attach) {
    const [cmd, ...args] = plan.handover;
    spawnSync(cmd, args, { stdio: "inherit" });
    return;
  }
  // Detached: persist a restore tab so the resumed window survives a relaunch
  // (no-op outside the canonical session), then print machine-readable next steps.
  recordLaunchedSession(
    { id: s.id, cwd: s.cwd, title: s.title, source: s.source, configDir: s.configDir },
    plan.tmuxName,
  );
  console.log(`▸ resumed session ${shortId(s.id)}${plan.alreadyRunning ? " (was already running)" : ""}`);
  console.log(`  window:  ${plan.tmuxName}   (in ${s.cwd})`);
  console.log(`  status:  ${SELF_CMD} status ${shortId(s.id)}`);
}

/**
 * End a running session: kill the tmux target it lives in — a window in a host
 * session, or the whole session when the agent was launched outside tmux — and
 * nothing else.
 *
 * WHAT IT DOES NOT TOUCH — this is a guarantee of the command, not a hope. The
 * only writes are the tmux kill itself and, when the window was a launcher tab,
 * dropping that one tab from the launcher's restore snapshot. Nothing under a
 * worktree is read, moved or removed: the worktree, its branch and every commit
 * in it survive, and the session's transcript stays on disk so `agendo resume
 * <id>` restarts it.
 *
 * The guards, in order, because a mistargeted kill in this environment can take
 * out someone's live agent — including the launcher itself:
 *  1. RESOLUTION. The id resolves exactly as it does for `status`/`send`/`resume`
 *     (full id, short id, or a `cl-…-<id>` tmux name), then the session's live
 *     window comes from `refreshLiveTmux` — the same reconciliation the menu and
 *     `wait` use — so a session running under a `cl-wi-…`/`cl-pr-…` window is
 *     found rather than missed. A session too new to have a transcript falls back
 *     to its id-bearing window (as `runStatus` does), since `agendo launch`
 *     prints an id well before the agent writes its log — otherwise the flow this
 *     command exists for (launch → it goes wrong → close) couldn't close it.
 *     An id that resolves to neither kills nothing.
 *  2. MANAGED-ONLY. The target must be a managed `cl-…` name (`managedKind`).
 *     That already holds by construction — `liveWindows` is built only from
 *     managed windows — so the check is defense in depth: if that ever stops
 *     holding, a typo must abort rather than kill the user's own shell or the
 *     launcher window.
 *  3. UNAMBIGUOUS ATTRIBUTION. A `cl-wi-…`/`cl-pr-…` window embeds an ITEM id,
 *     not a session id, so it is attributed to the most-recently-used session in
 *     its working directory. That heuristic is fine for reading a pane; for a
 *     kill it is not, because when two sessions share a directory the newest wins
 *     the attribution while the OTHER may be the agent actually running there.
 *     So an id-less window with rival sessions in its dir needs `--force`.
 *  4. WORK IN FLIGHT. A pane mid-turn (or compacting, or holding queued text /
 *     an open question) is refused unless `force` — killing an agent mid-write
 *     is how work gets lost. See UNSAFE_CLOSE_STATES. A pane that could not be
 *     READ is refused too: readiness classifies a blank screen as "unknown",
 *     which this guard lets through, so a failed read would pass for an idle
 *     session (see `readPaneState`).
 *
 * Both the readiness READ and the kill address a window through its
 * `session:index` location rather than by name (see `killManagedTarget`): a bare
 * window name resolves only inside the caller's current session, so from outside
 * tmux the read would come back empty — classifying "unknown", which guard 4
 * treats as closeable — while the kill quietly hit nothing. Two further checks
 * bound what a location can mean: more than one live window may carry the same
 * name (two launchers, one session), which is refused rather than guessed; and
 * the name at the location is re-read immediately before the kill, since tmux
 * renumbers windows when one closes. Finally, because every tmux write here is
 * fire-and-forget, the target is confirmed gone before success is reported.
 *
 * A dormant restore placeholder (an idle bash tab that was never opened) is
 * closeable too, and skips the readiness read: there's no agent in it to lose.
 */
async function runClose(token: string | undefined, force: boolean, verb = "close"): Promise<void> {
  if (!token) {
    console.error(`usage: ${SELF_CMD} ${verb} <id> [--force]`);
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const index = await SessionIndex.build();
  const s = index.all.find((x) => x.id === token || shortId(x.id) === sid);
  const { liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  // For a known session: its canonical name, and whatever window it's live in.
  // For one too new to be indexed: the live id-bearing window named after this
  // very short id — which is only ever that session's own window, so it's as
  // safe a target as the canonical name.
  const canon = s ? sessionName(s) : liveTargetForShortId(sid);
  if (!canon) {
    console.error(`No session found for "${token}" — refusing to close anything.`);
    process.exit(1);
  }
  const liveWindow = s ? liveWindows.get(canon) : canon;
  // A placeholder squats the canonical name with no agent behind it; close it by
  // that name (it's a real tmux window) when no live window vouches for the session.
  const placeholder = !liveWindow && livePlaceholders.has(canon);
  const target = liveWindow ?? (placeholder ? canon : undefined);
  const label = s ? shortId(s.id) : sid;
  if (!target) {
    // Already closed / never started. The desired end state holds, so this is a
    // success — `close` is idempotent for the scripts and agents driving it.
    console.log(`○ session ${label} is not running — nothing to close.`);
    // Idempotent success, but the caller may have expected a live session here; an
    // indexed one can still be brought back (an unindexed id has nothing to resume).
    if (s) console.log(`  resume:  ${SELF_CMD} resume ${label}   (its worktree, branch and commits are intact)`);
    return;
  }
  if (!managedKind(target)) {
    console.error(`Refusing to close "${target}": not a managed agendo window.`);
    process.exit(1);
  }
  // Guard 3: an id-less window is attributed by working directory, so it only
  // names one session unambiguously when it's the only session in that dir.
  if (!idBearingName(target) && !force) {
    const cwd = liveManagedPaths().find((p) => p.name === target)?.cwd;
    const rivals = cwd ? index.all.filter((x) => normalizeCwd(x.cwd) === normalizeCwd(cwd)) : [];
    if (rivals.length > 1) {
      console.error(
        `Not closing: window ${target} carries no session id, and ${rivals.length} sessions share ` +
          `its directory (${cwd}) — the one running in it may not be ${label}. Candidates: ` +
          `${rivals.map((x) => shortId(x.id)).join(", ")}. Pass --force to close that window anyway.`,
      );
      process.exit(2);
    }
  }
  // Where the window actually lives, used for BOTH the pane read and the kill so
  // neither falls back to tmux's current-session lookup. No location means the
  // target is a tmux session of its own (an agent launched outside tmux).
  //
  // tmux allows duplicate window names and this launcher produces them — a global
  // and a path-scoped launcher can each hold a tab for the same session — so more
  // than one location means we cannot tell which window the caller meant. Reading
  // the wrong one is harmless; killing it is not.
  const locations = windowLocations(target);
  if (locations.length > 1 && !force) {
    console.error(
      `Not closing: ${locations.length} live windows are named ${target} (${locations.join(", ")}) — ` +
        `agendo can't tell which one is ${label}. Close the one you mean from its launcher, or pass --force.`,
    );
    process.exit(2);
  }
  const location = locations[0] ?? null;
  const readTarget = exactTarget(location ?? target);
  // One pane read serves both the verdict and, if we refuse, the screen tail that
  // explains it — the same shape `send` uses when it declines.
  const pane = placeholder ? null : readPaneState(readTarget);
  // A read that FAILED is not evidence of an idle session. `paneReadiness` turns
  // an empty screen into "unknown", which guard 4 lets through — so a tmux read
  // that never landed (busy server, pane gone between the listing and here) would
  // silently disarm the only check standing between `close` and a mid-turn agent.
  // `wait` distrusts a single missed read for the same reason (EXIT_CONFIRM_TICKS);
  // this command is the destructive one, so it refuses outright.
  if (!placeholder && !pane && !force) {
    console.error(
      `Not closing: tmux could not read ${target}'s pane (${readTarget}), so agendo can't tell whether ` +
        `work is in flight. Re-run to try again, or pass --force to close it unread.`,
    );
    process.exit(2);
  }
  const readiness = pane ? paneReadiness(pane.raw, pane.cursor) : null;
  if (pane && readiness && UNSAFE_CLOSE_STATES.has(readiness) && !force) {
    console.error(`Not closing: session looks "${readiness}" — work is in flight. Pass --force to close it anyway.`);
    console.error(`\n  current screen (tail):`);
    for (const l of stripAnsi(pane.raw).split("\n").filter((x) => x.trim()).slice(-12)) console.error(`    ${l}`);
    process.exit(2);
  }
  // `how === "none"` means tmux listed the target a moment ago but can now place
  // it in neither a window nor a session — so nothing was killed, whatever the
  // (vacuously true) `gone` check says. Report the failure rather than the
  // reassuring lie; the caller can look and re-run.
  const { how, gone } = killManagedTarget(target, location);
  if (!gone || how === "none") {
    console.error(
      how === "moved"
        ? `Not closing ${target}: the window at ${location} is no longer it (tmux renumbered while we looked). Nothing was killed — re-run to pick it up at its new index.`
        : `Could not close ${target}: tmux ${how === "none" ? "can no longer place it in any session" : "still reports it live"}. Nothing else was changed.`,
    );
    process.exit(1);
  }
  // The host session the window we just killed lived in. A standalone agent
  // session (launched outside tmux) was never a tab in one.
  const host = location?.split(":")[0];
  // A dormant placeholder can carry the canonical name alongside the real window
  // we just killed — reconcileLive drops it from `livePlaceholders` in exactly
  // that case (a real window vouched for the name), so ask tmux directly rather
  // than trust the reconciled set. Without this the closed session is still
  // sitting in the tab strip as an unopened tab.
  //
  // Scoped to that one host session, and flag-checked inside it: the same
  // canonical name can be tabbed in a SECOND launcher (which is why
  // `isPlaceholderWindow` reads the flag per host), and that launcher's strip is
  // none of this command's business — we don't edit its restore snapshot either,
  // so killing its tab would only make it reappear there on its next start.
  if (!placeholder && host && isPlaceholderWindow(host, canon)) {
    const leftover = windowLocations(canon).find((l) => l.startsWith(`${host}:`));
    if (leftover) killManagedTarget(canon, leftover);
  }
  // Drop the tab from the restore snapshot of the host session that held the
  // window we just killed — and only that one, so a parallel path-scoped
  // launcher's tabs are untouched.
  if (host) forgetRestoreTab(canon, host);
  console.log(
    `▸ closed ${target}${placeholder ? " (unopened restore tab)" : readiness && readiness !== "ready" ? ` (was "${readiness}")` : ""}`,
  );
  console.log(`  kept:    worktree, branch and commits are untouched${s ? ` in ${s.cwd}` : ""}`);
  // Only an indexed session can be resumed by id — one whose transcript hasn't
  // landed yet has nothing for `resume` to find (that's why it took the
  // window-name path to get here in the first place).
  if (s) console.log(`  resume:  ${SELF_CMD} resume ${label}`);
}

/**
 * The exiting form of `scopeFlagValue`, for the subcommands parsed here (`wait`
 * uses the returning form directly — it turns its whole argv tail into an exit
 * code rather than exiting mid-parse). One guard, so a missing `--repo` can't be
 * an error on one subcommand and a silent "no filter" on another.
 */
function requireValue(cmd: string, flag: string, v: string | undefined): string {
  const value = scopeFlagValue(cmd, flag, v);
  if (value === null) process.exit(1);
  return value;
}

/** `list`'s path scope was named twice — as `[dir]`, as `--path`, or as both. */
function duplicatePathScope(): never {
  console.error(`list: the path scope was given twice — [dir] and --path <dir> name the same slot`);
  process.exit(1);
}

// Quit if our input stream goes away — e.g. the controlling terminal/PTY closed
// because a parent process died, orphaning us. Without this, Ink keeps the
// hung-up stdin fd registered and the event loop busy-spins at 100% CPU forever
// (epoll keeps reporting the fd "ready" via EPOLLHUP, which a read can't clear).
// A TUI whose input has ended has nothing left to do, so exiting is correct.
function quitOnInputLoss(): void {
  process.exit(0);
}
process.stdin.on("end", quitOnInputLoss);
process.stdin.on("close", quitOnInputLoss);
process.stdin.on("error", quitOnInputLoss);

/** Render the menu once; resolves with the chosen plan, or null if the user quit. */
function runMenu(): Promise<OpenPlan | null> {
  return new Promise((resolve) => {
    const chosen: { plan: OpenPlan | null } = { plan: null };
    const { waitUntilExit } = render(
      <App onOpen={(p) => { chosen.plan = p; }} filterRoot={ctx.filterRoot} hostSession={ctx.hostSession} />,
    );
    waitUntilExit().then(() => resolve(chosen.plan));
  });
}

// Loop: show menu → (outside tmux only) open a session → return to the menu.
// Outside tmux, picking a session resolves a "handover" plan: `attach` blocks
// until you detach, then the menu redraws. Inside tmux the menu handles opens
// itself (switches to the agent's window) and stays mounted, so it never
// resolves a plan here — the loop just waits for q/esc to quit (plan === null).
while (true) {
  const plan = await runMenu();
  if (!plan) break;

  // Clear the screen before handing over so tmux starts clean.
  process.stdout.write("\x1b[2J\x1b[H");
  const [cmd, ...args] = plan.handover;
  spawnSync(cmd, args, { stdio: "inherit" });
}

process.exit(0);
