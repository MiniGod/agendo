#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { spawnSync } from "child_process";
import App from "./ui/App.tsx";
import { basename } from "path";
import {
  tmuxAvailable, enterLauncherSession, shortId, sessionName, liveTargets, liveTargetForShortId,
  liveManagedPaths, managedKind, capturePane, sendToPane, paneReadiness, paneShells, stripAnsi,
  sessionRoot, currentSessionName,
  type SessionKind,
} from "./tmux.ts";
import { launchTask, llmGuide, SELF_CMD, type OpenPlan } from "./launch.ts";
import { SessionIndex, loadActivity } from "./sessions.ts";
import { restoreTabs, recordLaunchedSession, resolveWindowSession } from "./restore.ts";
import { resolveContext, isUnderRoot } from "./context.ts";
import type { AgentSession, AgentSource } from "./types.ts";

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
  agendo status <id>           Show a session's state, task checklist, recent
                                activity + full final response, and input
                                readiness. <id> is the session id or a tmux
                                name (cl-bg-…, cl-claude-…).
      --full, -F                Don't truncate the prompt / activity details
  agendo send <id> <prompt>    Send a prompt to a running session. Refuses unless
                                its input is idle/ready (not mid-turn, no open
                                question, nothing already typed).
      --force, -f               Send even if the input doesn't look ready
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
// human) can discover the background sessions it can `status`/`send` to. Only
// live sessions are shown; resuming idle ones is deliberately not exposed.
if (process.argv[2] === "list" || process.argv[2] === "ls") {
  // Optional `[dir]` scopes the listing to sessions whose cwd is under it,
  // mirroring the TUI's path filter. Resolved against the current directory.
  const dirArg = process.argv[3];
  const filterRoot = dirArg && !dirArg.startsWith("-") ? resolveContext(dirArg, process.cwd()).filterRoot : null;
  await runList(filterRoot);
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
    console.log(`  ready:  ${paneReadiness(raw)}`);
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
 * Print the managed sessions that are running right now, one per line. We walk
 * the live `cl-…` tmux targets and resolve each back to its session — id-bearing
 * names (`cl-bg-`/`cl-new-`/`cl-claude-`/`cl-copilot-`) by embedded short id,
 * work-item / PR names by working directory (as in model.ts) — then report
 * readiness, kind, id, location and title. Running-only by design: idle sessions
 * (and resuming them) are intentionally not exposed here.
 */
async function runList(filterRoot: string | null = null): Promise<void> {
  const index = await SessionIndex.build();
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
        (basename(s.cwd) || s.cwd).slice(0, 24).padEnd(24),
        s.title.replace(/\s+/g, " ").slice(0, 44),
        shells > 0 ? `⛁${shells}` : "",
      ].join("  ").trimEnd(),
    );
  }
  if (rows.length === 0) console.log("No running sessions.");
  else rows.forEach((r) => console.log(r));
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
