#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { spawnSync } from "child_process";
import App from "./ui/App.tsx";
import { basename } from "path";
import {
  tmuxAvailable, enterLauncherSession, shortId, sessionName, liveTargets, liveTargetForShortId,
  liveManagedPaths, managedKind, capturePane, sendToPane, sendResume, paneReadiness, paneShells, stripAnsi,
  sessionRoot, currentSessionName, killWindow,
  type SessionKind, type Readiness,
} from "./tmux.ts";
import { parseResetTime, RESET_LOOKBACK_MS } from "./usageLimit.ts";
import { launchTask, llmGuide, openSession, SELF_CMD, type OpenPlan } from "./launch.ts";
import { SessionIndex, loadActivity } from "./sessions.ts";
import { restoreTabs, recordLaunchedSession, resolveWindowSession } from "./restore.ts";
import { resolveContext, isUnderRoot } from "./context.ts";
import { loadModel, refreshLiveTmux, type LoadedModel } from "./model.ts";
import { resolveInitialProvider } from "./provider.ts";
import { loadState } from "./config.ts";
import { repoRootForCwd } from "./repos.ts";
import type { AgentSession, AgentSource, Identity, PRWithSessions, WorkItem } from "./types.ts";

const HELP = `agendo — manage claude sessions as attachable tmux windows

Usage:
  agendo [path]                Open the launcher in its own tmux session (default:
                                session "agendo"). With a path, scope the launcher
                                to sessions under it (host session "agendo-<basename>").
                                Toggle scoped↔global at runtime with the a key.
      --session, -s <name>      Override the derived host session name (e.g. on a
                                basename collision between two paths)
  agendo --no-tmux             Open the menu inline, without a tmux session
  agendo launch [opts] <prompt>
                              Start a background session: own git worktree + a
                              new agent, in a tmux window attachable later from
                              the menu. Prints the new session id.
      --attach, -a              Switch/attach to it immediately (default: detached)
      --name, -n <slug>         Name the worktree/branch (else derived from prompt)
      --no-worktree             Run in the current checkout instead of a new worktree
      --agent <claude|copilot>  Which agent to launch (default: claude)
      --copilot / --claude      Shorthand for --agent copilot / --agent claude
  agendo list, ls [dir]        List the sessions running right now, one per line
                                (readiness, kind, id, dir, title). With a dir,
                                only sessions whose cwd is under it are shown.
      --json                    Emit machine-readable JSON (with branch + linked
                                PR + work-item/issue per session).
      --all, --include-idle     Also list idle (not-running) sessions, each marked
                                running vs idle.
      --pr <n>                  Only sessions linked to PR #n (resolved via the
                                backend, so gh/az data is fetched).
      --issue, --work-item <n>  Only sessions linked to that issue / work item.
  agendo list pr, prs          List your open pull requests from the active backend,
                                each with its associated running session (pr#, ci,
                                approvals, branch, session, title). --json for full rows.
  agendo list issues           List issues / work items with any associated session
       (aliases: wi,            (id, state, session, title). Vocab follows the backend:
        work-items)             GitHub says "issue", Azure DevOps "work item".
                                --json for full rows (id + sessions[]).
  agendo resume <id>           Headless resume of an idle session in its own tmux
                                window (detached). <id> as for status.
      --attach, -a              Switch/attach to it immediately (default: detached)
  agendo wait [id...]          Poll until the target session(s) settle to a non-busy
                                state, then exit 0; exit non-zero on timeout. With
                                no ids, select with --all / --prefix / --repo.
      --state <ready|busy|…>    Wait for exactly this readiness (default: non-busy)
      --not <state>             Wait until readiness is anything but this
      --timeout <dur>           Give up after this long (default 120s)
      --interval <dur>          Poll cadence (default 2s). Durations: 500ms, 2s, 5m…
      --all                     All running sessions
      --prefix <p>              Sessions whose dir basename starts with p
      --repo <name>             Sessions whose repo root basename is name
  agendo status <id>           Show a session's state, task checklist, recent
                                activity + full final response, and input
                                readiness. <id> is the session id or a tmux
                                name (cl-bg-…, cl-claude-…).
      --full, -F                Don't truncate the prompt / activity details
  agendo send <id> <prompt>    Send a prompt to a running session. Refuses unless
                                its input is idle/ready (not mid-turn, no open
                                question, nothing already typed).
      --force, -f               Send even if the input doesn't look ready
  agendo unblock <id>          Nudge a session at its usage limit to continue:
                                sends <esc>continue<enter>. Refuses unless the
                                pane is still showing the usage-limit notice.
      --force, -f               Unblock even if it doesn't look limited
  agendo --llm                 Print agent-facing instructions for the background-
                                session workflow (what the system prompt points to)
  agendo --help, -h            Show this help

Sessions are listed in the menu and marked running → attach. Background sessions
carry a {bg} badge, manually-started ones {new}.`;

/** CLI glyphs for the three task states (plain ASCII markers stay greppable). */
const STATUS_GLYPH: Record<string, string> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

/** Short kind labels for the `list` columns, matching the menu's {bg}/{new} badges. */
const KIND_LABEL: Record<SessionKind, string> = {
  background: "bg",
  new: "new",
  workitem: "wi",
  pr: "pr",
  resumed: "—",
};

/**
 * Readiness states that mean the session is actively working (not settled) — the
 * default "still busy" set `agendo wait` polls against. Declared here, before the
 * subcommand dispatch runs, so the hoisted `waitSatisfied` never reads it in the
 * temporal dead zone during an early `wait` invocation.
 */
const BUSY_STATES = new Set<Readiness>(["busy", "compacting"]);

/** Compact "last used" age for the list columns (matches the menu's timeAgo). */
function timeAgo(d: Date): string {
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
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
  const full = rest.includes("--full") || rest.includes("-F");
  const token = rest.find((a) => a !== "--full" && a !== "-F");
  await runStatus(token, full);
  process.exit(0);
}

// `launch [flags] <prompt>`: spin up a managed session without the menu. The
// launcher creates an isolated worktree (unless `--no-worktree`) and a
// `cl-bg-…` agent window it can attach to later (Claude by default, or Copilot
// via `--agent copilot`/`--copilot`). Used both by humans and by a running agent
// the user asked to start a background session. Detached by default; `--attach`
// switches/attaches to it immediately.
if (process.argv[2] === "launch") {
  let name: string | undefined;
  let worktree = true;
  let attach = false;
  let agent: AgentSource = "claude";
  const positionals: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--attach" || a === "-a") attach = true;
    else if (a === "--no-worktree") worktree = false;
    else if (a === "--name" || a === "-n") name = rest[++i];
    else if (a === "--copilot") agent = "copilot";
    else if (a === "--claude") agent = "claude";
    else if (a === "--agent") {
      const v = rest[++i];
      if (v !== "claude" && v !== "copilot") {
        console.error(`launch failed: --agent must be "claude" or "copilot", got "${v ?? ""}"`);
        process.exit(1);
      }
      agent = v;
    } else if (a === "--") { positionals.push(...rest.slice(i + 1)); break; }
    else positionals.push(a);
  }
  const prompt = positionals.join(" ").trim();
  const { plan, id, cwd, error } = launchTask(process.cwd(), { prompt, name, worktree, agent });
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
  if (id) {
    recordLaunchedSession(
      {
        id,
        cwd,
        title: prompt || "background session",
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
    console.log(`▸ launched background session ${id}`);
    console.log(`  window:  ${plan.tmuxName}   (in ${cwd})`);
    console.log(`  status:  ${SELF_CMD} status ${id}`);
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
  const parts: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--force" || a === "-f") force = true;
    else if (a === "--") { parts.push(...rest.slice(i + 1)); break; }
    else if (id === undefined) id = a;
    else parts.push(a);
  }
  await runSend(id, parts.join(" ").trim(), force);
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
    for (const a of process.argv.slice(4)) {
      if (a === "--json") json = true;
      else {
        console.error(`list ${sub}: unknown argument "${a}"`);
        process.exit(1);
      }
    }
    if (PR_SUBS.has(sub)) await runListPrs({ json });
    else await runListIssues({ json });
    process.exit(0);
  }
  let json = false;
  let all = false;
  let pr: number | undefined;
  let item: number | undefined;
  // Optional `[dir]` positional scopes the listing to sessions whose cwd is under
  // it, mirroring the TUI's path filter; resolved against the current directory.
  let dirArg: string | undefined;
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--all" || a === "--include-idle") all = true;
    else if (a === "--pr") pr = Number(rest[++i]);
    else if (a === "--issue" || a === "--work-item" || a === "--workitem") item = Number(rest[++i]);
    else if (!a.startsWith("-") && dirArg === undefined) dirArg = a;
    else {
      console.error(`list: unknown argument "${a}"`);
      process.exit(1);
    }
  }
  if ((pr !== undefined && !Number.isFinite(pr)) || (item !== undefined && !Number.isFinite(item))) {
    console.error(`list: --pr/--issue/--work-item need a numeric id`);
    process.exit(1);
  }
  const filterRoot = dirArg ? resolveContext(dirArg, process.cwd()).filterRoot : null;
  await runList({ json, all, pr, item, filterRoot });
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

// `wait [id...]`: block until the selected session(s) reach a desired non-busy
// state (like `gh run watch`), then exit 0; exit non-zero on timeout. Progress
// goes to stderr, the final per-session state to stdout, so it composes in
// scripts. Targets: explicit ids, or --all / --prefix / --repo selectors.
if (process.argv[2] === "wait") {
  let all = false;
  let prefix: string | undefined;
  let repo: string | undefined;
  let state: string | undefined;
  let not: string | undefined;
  let timeoutMs = 120_000;
  let intervalMs = 2_000;
  const ids: string[] = [];
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--all") all = true;
    else if (a === "--prefix") prefix = rest[++i];
    else if (a === "--repo") repo = rest[++i];
    else if (a === "--state") state = rest[++i];
    else if (a === "--not") not = rest[++i];
    else if (a === "--timeout") timeoutMs = requireDuration("--timeout", rest[++i]);
    else if (a === "--interval") intervalMs = requireDuration("--interval", rest[++i]);
    else if (a === "--") { ids.push(...rest.slice(i + 1)); break; }
    else ids.push(a);
  }
  const valid: Readiness[] = ["ready", "busy", "compacting", "queued", "dialog", "unknown"];
  for (const [flag, v] of [["--state", state], ["--not", not]] as const) {
    if (v !== undefined && !valid.includes(v as Readiness)) {
      console.error(`wait: ${flag} must be one of ${valid.join("|")}, got "${v}"`);
      process.exit(1);
    }
  }
  if (state !== undefined && not !== undefined) {
    console.error(`wait: use only one of --state / --not`);
    process.exit(1);
  }
  await runWait({
    ids,
    all,
    prefix,
    repo,
    state: state as Readiness | undefined,
    not: not as Readiness | undefined,
    timeoutMs,
    intervalMs,
  });
  process.exit(0);
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
    [process.argv[0], process.argv[1], ...menuArgs],
    () => restoreTabs(ctx.hostSession),
  );
  process.exit(0);
}

/**
 * Resolve a session by id-or-tmux-name and print its state + recent activity
 * (the same summary the menu surfaces). A just-launched session may not have
 * written its log yet — if so we still report it as running from its live tmux
 * window. `token` may be a full session id, a short id, or a `cl-…-<id>` name.
 */
async function runStatus(token: string | undefined, full = false): Promise<void> {
  if (!token) {
    console.error(`usage: ${SELF_CMD} status <id> [--full]`);
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const index = await SessionIndex.build();
  const s = index.all.find((x) => x.id === token || shortId(x.id) === sid);
  if (!s) {
    const live = liveTargetForShortId(sid);
    if (live) {
      console.log(`● running (${live}) — no activity logged yet; it may still be starting.`);
      process.exit(0);
    }
    console.error(`No session found for "${token}".`);
    process.exit(1);
  }
  const target = liveTargetForShortId(shortId(s.id));
  const running = !!target || liveTargets().has(sessionName(s));
  const act = await loadActivity(s, { full });
  console.log(`${running ? "● running" : "○ idle"}  [${s.source}] ${s.title}`);
  console.log(`  id:     ${s.id}`);
  console.log(`  dir:    ${s.cwd}`);
  if (s.branch) console.log(`  branch: ${s.branch}`);
  console.log(`  last:   ${s.lastUsed.toISOString()}`);
  if (target) {
    const raw = capturePane(target);
    const readiness = paneReadiness(raw);
    console.log(`  ready:  ${readiness}`);
    if (readiness === "limited") {
      const resetAt = parseResetTime(stripAnsi(raw), new Date(), RESET_LOOKBACK_MS);
      console.log(
        `  limit:  usage limit reached${resetAt !== null ? ` — resets at ${new Date(resetAt).toISOString()}` : " — no reset time parsed (cannot auto-resume)"}`,
      );
    }
    const shells = paneShells(raw);
    if (shells > 0) console.log(`  shells: ${shells} background shell${shells > 1 ? "s" : ""} running (e.g. a monitor)`);
  }
  if (act.lastPrompt) console.log(`\n  last prompt: ${act.lastPrompt}`);
  // Task checklist, if the agent kept one. A plain glyph per status keeps it
  // greppable in plain-text CLI output.
  if (act.tasks && act.tasks.length) {
    console.log(`\n  tasks:`);
    for (const t of act.tasks) console.log(`    ${STATUS_GLYPH[t.status]} ${t.label}`);
  }
  if (act.actions.length) {
    console.log(`\n  recent activity:`);
    for (const a of act.actions) console.log(`    ${a.verb}${a.detail ? `  ${a.detail}` : ""}`);
  } else {
    console.log(`\n  (no recent activity)`);
  }
  // The FULL final response, always untruncated — the key orchestrator read.
  if (act.finalResponse) console.log(`\n  final response:\n${indent(act.finalResponse)}`);
}

/** Indent every line of a block by four spaces for the status output. */
function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/**
 * Send a prompt into a running session's input box. Refuses unless the TUI is
 * "ready" (idle, empty input) so we never clobber an open question, a generating
 * turn, or text already queued — pass `force` to override. Resolves the session
 * by id or tmux name.
 */
async function runSend(token: string | undefined, prompt: string, force: boolean): Promise<void> {
  if (!token || !prompt) {
    console.error(`usage: ${SELF_CMD} send <id> "<prompt>" [--force]`);
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const target = liveTargetForShortId(sid);
  if (!target) {
    console.error(`Session ${token} is not running (no live tmux window to send to).`);
    process.exit(1);
  }
  const raw = capturePane(target);
  const readiness = paneReadiness(raw);
  if (readiness !== "ready" && !force) {
    console.error(`Not sending: session looks "${readiness}", not ready. Re-check with \`${SELF_CMD} status ${token}\`, or pass --force.`);
    console.error(`\n  current screen (tail):`);
    for (const l of stripAnsi(raw).split("\n").filter((x) => x.trim()).slice(-12)) console.error(`    ${l}`);
    process.exit(2);
  }
  sendToPane(target, prompt);
  console.log(`▸ sent to ${target}${readiness !== "ready" ? ` (forced; was "${readiness}")` : ""}`);
}

/**
 * Send the resume keystrokes (`<esc>continue<enter>`) to a session sitting at
 * its usage limit. Refuses unless the pane still reads "limited" (so a session
 * that already recovered isn't clobbered), overridable with `--force`.
 */
async function runUnblock(token: string | undefined, force: boolean): Promise<void> {
  if (!token) {
    console.error(`usage: ${SELF_CMD} unblock <id> [--force]`);
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const target = liveTargetForShortId(sid);
  if (!target) {
    console.error(`Session ${token} is not running (no live tmux window to unblock).`);
    process.exit(1);
  }
  const raw = capturePane(target);
  const readiness = paneReadiness(raw);
  if (readiness !== "limited" && !force) {
    console.error(`Not unblocking: session looks "${readiness}", not limited. Pass --force to send anyway.`);
    process.exit(2);
  }
  sendResume(target);
  const resetAt = readiness === "limited" ? parseResetTime(stripAnsi(raw), new Date(), RESET_LOOKBACK_MS) : null;
  console.log(
    `▸ unblocked ${target}${readiness !== "limited" ? ` (forced; was "${readiness}")` : resetAt !== null ? ` (reset was ${new Date(resetAt).toISOString()})` : ""}`,
  );
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
  /** Scope to sessions whose cwd is under this absolute root (TUI path filter). */
  filterRoot: string | null;
}

/** One session as reported by the enriched (`--json` / `--all` / query) list. */
interface ListRow {
  id: string;
  shortId: string;
  source: AgentSource;
  running: boolean;
  /** Input readiness from the live pane, or null when idle (no pane to read). */
  readiness: Readiness | null;
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
  /** Linked PR, resolved through the model's reverse index (null if none/unknown). */
  pr: { id: number; url: string } | null;
  /** Linked work item / issue, resolved through the model's reverse index. */
  workItem: { id: number; url: string } | null;
}

/**
 * Model-load options mirroring what the TUI (App.tsx) resolves: the persisted
 * backend (falling back to whichever CLI is installed) and the persisted
 * identity, if any. Used by the association-resolving `list` modes so their
 * gh/az fetch set matches what the menu would show.
 */
function currentModelOptions(): { provider: ReturnType<typeof resolveInitialProvider>; identity: Identity | null } {
  const st = loadState();
  const provider = resolveInitialProvider(st.provider);
  const identity: Identity | null = st.identityId
    ? { id: st.identityId, displayName: st.identityName ?? "?", uniqueName: st.identityUniqueName ?? "" }
    : null;
  return { provider, identity };
}

/**
 * List sessions. The default (no flags) is unchanged: the live `cl-…` tmux
 * targets, one per line, resolved back to their session and reported with
 * readiness/kind/id/dir/title — fast and needing no backend auth. The `--json`,
 * `--all`/`--include-idle`, and `--pr`/`--issue`/`--work-item` query flags opt
 * into the enriched path, which loads the model so each row carries its branch
 * and linked PR / work item (via `sessionLinks`) and can include idle sessions.
 * An optional `filterRoot` scopes every mode to sessions whose cwd is under it.
 */
async function runList(opts: ListOptions): Promise<void> {
  const index = await SessionIndex.build();
  const enriched = opts.json || opts.all || opts.pr !== undefined || opts.item !== undefined;
  if (!enriched) return runPlainList(index, opts.filterRoot);

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
  // Path scoping (the `[dir]` positional): keep only sessions under the root.
  if (opts.filterRoot) sessions = sessions.filter((s) => isUnderRoot(s.cwd, opts.filterRoot!));
  sessions.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());

  const rows: ListRow[] = sessions.map((s) => {
    const canon = sessionName(s);
    const running = live.has(canon);
    const window = liveWindows.get(canon);
    let readiness: Readiness | null = null;
    let shells = 0;
    if (running && window) {
      const raw = capturePane(window);
      readiness = paneReadiness(raw);
      shells = paneShells(raw);
    }
    const l = linkOf(s);
    return {
      id: s.id,
      shortId: shortId(s.id),
      source: s.source,
      running,
      readiness,
      shells,
      kind: running ? liveKinds.get(canon) ?? null : null,
      branch: s.branch ?? null,
      cwd: s.cwd,
      dir: basename(s.cwd) || s.cwd,
      title: s.title.replace(/\s+/g, " ").trim(),
      lastUsed: s.lastUsed.toISOString(),
      pr: l?.pr ?? null,
      workItem: l?.workItem ?? null,
    };
  });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(
      isQuery
        ? "No sessions linked to that item (query covers open PRs / work items in the current identity's scope)."
        : "No sessions.",
    );
    return;
  }
  const itemLabel = model?.provider === "github" ? "issue" : "wi";
  console.log(
    ["", "ready".padEnd(10), "kind".padEnd(3), "id".padEnd(12), "age".padEnd(8), "dir".padEnd(20), "pr".padEnd(6), itemLabel.padEnd(6), "title"].join("  "),
  );
  for (const r of rows) {
    console.log(
      [
        r.running ? "●" : "○",
        (r.readiness ?? "-").padEnd(10),
        (r.kind ? KIND_LABEL[r.kind] : "-").padEnd(3),
        r.shortId.padEnd(12),
        timeAgo(new Date(r.lastUsed)).padEnd(8),
        r.dir.slice(0, 20).padEnd(20),
        (r.pr ? `!${r.pr.id}` : "-").padEnd(6),
        (r.workItem ? `#${r.workItem.id}` : "-").padEnd(6),
        r.title.slice(0, 44) + (r.shells > 0 ? `  ⛁${r.shells}` : ""),
      ].join("  ").trimEnd(),
    );
  }
}

/**
 * The default, unchanged `list`: the managed sessions running right now, one per
 * line. We walk the live `cl-…` tmux targets and resolve each back to its
 * session — id-bearing names (`cl-bg-`/`cl-new-`/`cl-claude-`/`cl-copilot-`) by
 * embedded short id, work-item / PR names by working directory (as in model.ts)
 * — then report readiness, kind, id, location and title. Running-only and
 * model-free by design. An optional `filterRoot` scopes to sessions under it.
 */
function runPlainList(index: SessionIndex, filterRoot: string | null = null): void {
  const seen = new Set<string>();
  const rows: string[] = [];
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
    // Path scoping: skip sessions whose cwd isn't under the requested dir.
    if (filterRoot && !isUnderRoot(s.cwd, filterRoot)) continue;
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const raw = capturePane(name);
    const shells = paneShells(raw);
    rows.push(
      [
        "●",
        paneReadiness(raw).padEnd(10),
        KIND_LABEL[kind].padEnd(3),
        shortId(s.id),
        timeAgo(s.lastUsed).padEnd(8),
        (basename(s.cwd) || s.cwd).slice(0, 24).padEnd(24),
        s.title.replace(/\s+/g, " ").slice(0, 44),
        shells > 0 ? `⛁${shells}` : "",
      ].join("  ").trimEnd(),
    );
  }
  if (rows.length === 0) console.log("No running sessions.");
  else rows.forEach((r) => console.log(r));
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

/**
 * `list pr|prs`: the current identity's OPEN pull requests from the active
 * backend, each with the session working its branch (running one preferred) — an
 * orchestrator's "what PRs are in flight and which can I delegate to / poke". We
 * reuse the model's forward PR lists (linkedPrs + orphanPrs — PRs I created;
 * review PRs are someone else's, so excluded) and its live-tmux set for the
 * association, so there's no new matcher. `--json` emits the full rows (id +
 * branch + status + ci + sessions[]) for scripting.
 */
async function runListPrs(opts: { json: boolean }): Promise<void> {
  let model: LoadedModel;
  try {
    model = await loadModel(currentModelOptions());
  } catch (e) {
    console.error(`list pr: could not load pull requests from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
    return;
  }
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
    url: pr.url,
    sessions: assocSessions(pr.sessions, model.liveTmux),
  }));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
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
async function runListIssues(opts: { json: boolean }): Promise<void> {
  let model: LoadedModel;
  try {
    model = await loadModel(currentModelOptions());
  } catch (e) {
    console.error(`list issues: could not load work items from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
    return;
  }
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
    url: it.url,
    sessions: assocSessions(it.sessions, model.liveTmux),
  }));

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
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
    process.exit(1);
  }
  const { liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const canon = sessionName(s);
  const liveWindow = liveWindows.get(canon);
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

interface WaitOptions {
  ids: string[];
  all: boolean;
  prefix?: string;
  repo?: string;
  /** Desired readiness (exact match). Overrides the default non-busy predicate. */
  state?: Readiness;
  /** Wait until readiness is anything but this. */
  not?: Readiness;
  timeoutMs: number;
  intervalMs: number;
}

/** Whether a pane's readiness satisfies the wait predicate. The default (no
 *  `--state`/`--not`) waits for a *known, settled* non-busy state — "unknown" is
 *  excluded so a blank, not-yet-drawn, or closed pane doesn't count as "done"
 *  and report a false success. */
function waitSatisfied(r: Readiness, o: WaitOptions): boolean {
  if (o.state) return r === o.state;
  if (o.not) return r !== o.not;
  return !BUSY_STATES.has(r) && r !== "unknown";
}

/** Parse a duration like `500ms`, `2s`, `5m`, `1h` (bare number ⇒ seconds); null
 *  if the string is missing or malformed, so the caller can reject it loudly
 *  rather than silently fall back to a default the user didn't ask for. */
function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "s").toLowerCase()) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return null;
  }
}

/** Parse a required duration flag, exiting with a clear error on bad/missing input. */
function requireDuration(flag: string, s: string | undefined): number {
  const ms = parseDuration(s);
  if (ms === null) {
    console.error(`wait: ${flag} needs a duration like 500ms, 2s, 5m, 1h (got "${s ?? ""}")`);
    process.exit(1);
  }
  return ms;
}

/**
 * Poll the selected session(s) until they all satisfy the wait predicate, then
 * exit 0; exit non-zero on timeout. Only running sessions can be waited on (an
 * idle session has no pane to read), so selectors filter to live targets;
 * explicit ids that aren't running are an error. Progress lines go to stderr and
 * the final per-session `<id>\t<state>` to stdout, so it composes in scripts.
 */
async function runWait(o: WaitOptions): Promise<void> {
  const index = await SessionIndex.build();
  let sessions: AgentSession[];
  if (o.ids.length) {
    sessions = [];
    const missing: string[] = [];
    for (const tok of o.ids) {
      const sid = tok.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(tok);
      const s = index.all.find((x) => x.id === tok || shortId(x.id) === sid);
      if (s) sessions.push(s);
      else missing.push(tok);
    }
    if (missing.length) {
      console.error(`wait: no session found for ${missing.join(", ")}`);
      process.exit(1);
    }
  } else if (o.all) {
    sessions = [...index.all];
  } else if (o.prefix !== undefined || o.repo !== undefined) {
    sessions = index.all.filter((s) => {
      if (o.prefix !== undefined && !basename(s.cwd).startsWith(o.prefix)) return false;
      if (o.repo !== undefined && basename(repoRootForCwd(s.cwd)) !== o.repo) return false;
      return true;
    });
  } else {
    console.error(
      `usage: ${SELF_CMD} wait <id...> | --all | --prefix <p> | --repo <name> ` +
        `[--state <s>] [--not <s>] [--timeout <dur>] [--interval <dur>]`,
    );
    process.exit(1);
  }

  // Only running sessions have a pane to poll. Resolve each session's live
  // window via the same reconciliation the menu uses (`refreshLiveTmux`), NOT
  // `liveTargetForShortId`: that only matches id-bearing names, so a session
  // running under a work-item / PR window (`cl-wi-…`/`cl-pr-…`, attributed by
  // cwd) would be wrongly seen as not-running. `liveWindows` also excludes
  // restored-but-unopened placeholders (idle bash), so we never "wait" on those.
  // For explicit ids a non-running target can never settle, so it's an error;
  // selectors just skip idle ones.
  const { liveWindows } = refreshLiveTmux(index.all);
  const targets: { s: AgentSession; target: string }[] = [];
  const notRunning: AgentSession[] = [];
  for (const s of sessions) {
    const target = liveWindows.get(sessionName(s));
    if (target) targets.push({ s, target });
    else notRunning.push(s);
  }
  if (o.ids.length && notRunning.length) {
    console.error(`wait: not running (no live window): ${notRunning.map((s) => shortId(s.id)).join(", ")}`);
    process.exit(1);
  }
  if (targets.length === 0) {
    console.error("wait: no running sessions matched — nothing to wait on.");
    process.exit(1);
  }

  const desc = o.state ? `= ${o.state}` : o.not ? `≠ ${o.not}` : "non-busy";
  console.error(`waiting for ${targets.length} session(s) to be ${desc} (timeout ${Math.round(o.timeoutMs / 1000)}s)…`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // Floor the poll interval so a `--interval 0` can't spin a hot capture loop.
  const interval = Math.max(100, o.intervalMs);
  const deadline = Date.now() + o.timeoutMs;
  while (true) {
    const states = targets.map((t) => ({ ...t, r: paneReadiness(capturePane(t.target)) }));
    const pending = states.filter((x) => !waitSatisfied(x.r, o));
    if (pending.length === 0) {
      for (const x of states) console.log(`${shortId(x.s.id)}\t${x.r}`);
      process.exit(0);
    }
    if (Date.now() >= deadline) {
      console.error(
        `wait: timed out after ${Math.round(o.timeoutMs / 1000)}s; still pending: ` +
          pending.map((x) => `${shortId(x.s.id)}(${x.r})`).join(", "),
      );
      process.exit(1);
    }
    console.error(`  pending: ${pending.map((x) => `${shortId(x.s.id)}=${x.r}`).join(", ")}`);
    // Never sleep past the deadline: bounds the timeout overrun to ~0 even when
    // the interval is large relative to the remaining time.
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  }
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
