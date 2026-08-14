#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { spawnSync } from "child_process";
import App from "./ui/App.tsx";
import { basename } from "path";
import {
  tmuxAvailable, enterLauncherSession, shortId, sessionName, liveTargets, liveTargetForShortId,
  liveManagedPaths, managedKind, capturePaneState, sendToPane, sendResume, paneReadiness, paneShells, stripAnsi,
  sessionRoot, currentSessionName, killWindow,
  type SessionKind, type Readiness,
} from "./tmux.ts";
import { parseResetTime, RESET_LOOKBACK_MS } from "./usageLimit.ts";
import { FORWARDABLE_LAUNCH_FLAGS, launchTask, llmGuide, openSession, SELF_CMD, type OpenPlan } from "./launch.ts";
import { SessionIndex, loadActivity } from "./sessions.ts";
import { durationLabel, idleSeconds, isStalled, resolveStalledAfterMs, shortAge } from "./idle.ts";
import { branchSync, type BranchSync } from "./gitrefs.ts";
import { restoreTabs, recordLaunchedSession, resolveWindowSession } from "./restore.ts";
import { resolveContext, isUnderRoot } from "./context.ts";
import { loadModel, refreshLiveTmux, type LoadedModel } from "./model.ts";
import { resolveInitialProvider } from "./provider.ts";
import { loadState } from "./config.ts";
import { printJson } from "./output.ts";
import { parseDuration, runWaitCli } from "./wait.ts";
import type { AgentSession, AgentSource, Identity, PRWithSessions, WorkItem, WorkflowStatus } from "./types.ts";
import { loadWorkflowDetails, workflowStatus } from "./workflows.ts";

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
      --model <name>            Model for the new session, passed to the agent
      --fallback-model <name>   Claude only: model to fall back to when overloaded
                                Any other dashed argument is an error; put prompt
                                text that starts with -- after a bare --.
  agendo list, ls [dir]        List the sessions running right now, one per line
                                (readiness, kind, id, age, dir, title). "age" is
                                how long since the session last did anything; a
                                live, non-busy session idle past the stall
                                threshold is marked ⚠stalled. With a dir, only
                                sessions whose cwd is under it are shown.
      --json                    Emit machine-readable JSON (with branch + linked
                                PR + work-item/issue + idleSeconds/stalled and
                                unpushed-work state per session).
      --stalled-after <dur>     Idle time after which a live, non-busy session is
                                flagged stalled (default 4h; persist your own via
                                "stalledAfterMinutes" in ~/.agendo/config.json).
                                ⚠stalled only means "nothing has happened for
                                that long" — agendo cannot know if work finished.
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
  agendo wait [id...]          Block until the target session(s) settle to a
                                non-busy state, then exit 0; exit non-zero on
                                timeout. Run it in the background and use its exit
                                as a notification instead of re-polling status.
                                With no ids, select with --all / --prefix / --repo.
                                A session whose window closes reads "exited": it
                                satisfies the default wait, and short-circuits a
                                --state it can no longer reach.
      --any                     Wake on the FIRST session to satisfy, not all of
                                them (so one stuck session can't mask the rest)
      --json                    Emit a wake payload on stdout: why it woke, and
                                each session's from → state, changed, satisfied
      --state <ready|busy|…>    Wait for exactly this state (default: non-busy).
                                One of ready, busy, compacting, queued, dialog,
                                limited, unknown, exited.
      --not <state>             Wait until the state is anything but this
      --timeout <dur>           Give up after this long (default 120s)
      --interval <dur>          Poll cadence (default 2s). Durations: 500ms, 2s, 5m…
      --all                     All running sessions
      --prefix <p>              Sessions whose dir basename starts with p
      --repo <name>             Sessions whose repo root basename is name
  agendo status <id>           Show a session's state, idle age, task checklist,
                                workflows (Workflow-tool runs with agent progress),
                                recent activity + full final response, and input
                                readiness. <id> is the session id or a tmux
                                name (cl-bg-…, cl-claude-…).
      --full, -F                Don't truncate the prompt / activity details
      --stalled-after <dur>     Idle time after which a live, non-busy session is
                                reported stalled (as for list)
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

/** CLI glyphs for workflow run states, matching the task-glyph style. */
const WF_GLYPH: Record<WorkflowStatus, string> = {
  running: "[~]",
  completed: "[x]",
  failed: "[!]",
  stopped: "[-]",
  interrupted: "[?]",
};

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
 * Compact "last used" age for the list columns (matches the menu's timeAgo).
 * Built from the same `idleSeconds`/`shortAge` pair the `idle:` line and the
 * `--json` `idleSeconds` field use, so the age column can't disagree with them
 * at a bucket boundary.
 */
function timeAgo(d: Date): string {
  return `${shortAge(idleSeconds(d))} ago`;
}

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
  let token: string | undefined;
  // `--stalled-after` takes a value, so the argv walk can't be a bare `find` any
  // more — the duration must not be mistaken for the session id.
  let stalledAfterMs: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--full" || a === "-F") full = true;
    else if (a === "--stalled-after") stalledAfterMs = requireDuration("status", "--stalled-after", rest[++i]);
    // A dashed argument is never a session id. Rejecting it loudly beats the old
    // behaviour of treating it as the token and failing with a baffling
    // `No session found for "--stalled-after=1h"` (the inline GNU form isn't
    // supported here — `list`'s flags don't take it either).
    else if (a.startsWith("-")) {
      console.error(`status: unknown flag "${a}" (expected: --full/-F, --stalled-after <dur>)`);
      process.exit(1);
    } else if (token === undefined) token = a;
  }
  await runStatus(token, full, stalledAfterMs);
  process.exit(0);
}

// `launch [flags] <prompt>`: spin up a managed session without the menu. The
// launcher creates an isolated worktree (unless `--no-worktree`) and a
// `cl-bg-…` agent window it can attach to later (Claude by default, or Copilot
// via `--agent copilot`/`--copilot`). Used both by humans and by a running agent
// the user asked to start a background session. Detached by default; `--attach`
// switches/attaches to it immediately. A small allowlist of agent flags
// (`FORWARDABLE_LAUNCH_FLAGS`, e.g. `--model`) is passed through to the new
// agent's argv; any other dashed argument is rejected rather than silently
// swallowed into the prompt, so a typo'd flag can't quietly change the task.
if (process.argv[2] === "launch") {
  let name: string | undefined;
  let worktree = true;
  let attach = false;
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
    else if (flag === "--name" || a === "-n") name = inline ? a.slice(eq + 1) : rest[++i];
    else if (a === "--copilot") agent = "copilot";
    else if (a === "--claude") agent = "claude";
    else if (flag === "--agent") {
      const v = inline ? a.slice(eq + 1) : rest[++i];
      if (v !== "claude" && v !== "copilot") {
        console.error(`launch failed: --agent must be "claude" or "copilot", got "${v ?? ""}"`);
        process.exit(1);
      }
      agent = v;
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
  const prompt = positionals.join(" ").trim();
  const { plan, id, cwd, error } = launchTask(process.cwd(), { prompt, name, worktree, agent, forwardArgv });
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
  let stalledAfterMs: number | undefined;
  // Optional `[dir]` positional scopes the listing to sessions whose cwd is under
  // it, mirroring the TUI's path filter; resolved against the current directory.
  let dirArg: string | undefined;
  const rest = process.argv.slice(3);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--all" || a === "--include-idle") all = true;
    else if (a === "--stalled-after") stalledAfterMs = requireDuration("list", "--stalled-after", rest[++i]);
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
  await runList({ json, all, pr, item, filterRoot, stalledAfterMs });
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
async function runStatus(token: string | undefined, full = false, stalledAfterMs?: number): Promise<void> {
  if (!token) {
    console.error(`usage: ${SELF_CMD} status <id> [--full] [--stalled-after <dur>]`);
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
  // The pane is captured up front (rather than inside the `if (target)` block
  // below) because the stall qualifier needs readiness — a session that is
  // mid-turn is never stalled, however old its transcript looks — and it prints
  // above the readiness line.
  const pane = target ? capturePaneState(target) : null;
  const readiness = pane ? paneReadiness(pane.raw, pane.cursor) : null;
  const idle = idleSeconds(s.lastUsed);
  const thresholdMs = resolveStalledAfterMs(stalledAfterMs);
  const stalled = isStalled({ running, readiness, idleSeconds: idle }, thresholdMs);
  console.log(`${running ? "● running" : "○ idle"}  [${s.source}] ${s.title}`);
  console.log(`  id:     ${s.id}`);
  console.log(`  dir:    ${s.cwd}`);
  if (s.branch) console.log(`  branch: ${s.branch}`);
  console.log(`  last:   ${s.lastUsed.toISOString()}`);
  console.log(`  idle:   ${shortAge(idle)} (${idle}s since its last recorded activity)`);
  if (stalled) {
    console.log(`          ⚠ stalled: live and not busy, but nothing has happened for ${shortAge(idle)}`);
    console.log(`          (threshold ${durationLabel(thresholdMs)}). agendo cannot tell "finished" from "fell over" — read`);
    console.log(`          the final response below to judge.`);
  }
  // Unpushed-work state, read straight from the checkout's .git refs (no `git`
  // process, no fetch — see src/gitrefs.ts). Silent when it can't be determined.
  const sync = branchSync(s.cwd);
  if (sync) console.log(`  work:   ${describeSync(sync)}`);
  if (pane) {
    const { raw } = pane;
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
  // Workflow-tool runs this session launched (refs come from the cached
  // transcript parse; per-run detail is read here, on demand).
  if (s.workflows?.length) {
    console.log(`\n  workflows:`);
    for (const w of s.workflows) {
      const wst = workflowStatus(w, running);
      const d = await loadWorkflowDetails(w);
      const bits = [`${d.agentsDone}/${d.agentsStarted} agents done`];
      if (w.launchedAt) bits.push(`started ${timeAgo(w.launchedAt)}`);
      if (wst === "running" && d.lastActivity) bits.push(`active ${timeAgo(d.lastActivity)}`);
      console.log(`    ${WF_GLYPH[wst]} ${w.name} — ${wst} · ${bits.join(" · ")}`);
      const desc = w.summary ?? d.description;
      if (desc) console.log(`        ${full ? desc : desc.slice(0, 120)}`);
      if (d.phases?.length) {
        console.log(`        phases: ${d.phases.map((p) => (p.model ? `${p.title} (${p.model})` : p.title)).join(" → ")}`);
      }
      if (d.modelCounts) {
        // Alphabetical: the tally is built concurrently, so insertion order is
        // nondeterministic — sort for stable output.
        const models = Object.entries(d.modelCounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([m, n]) => (n > 1 ? `${m} ×${n}` : m))
          .join(", ");
        console.log(`        agents: ${models}`);
      }
      console.log(`        run: ${w.runId}${full && w.transcriptDir ? `\n        transcripts: ${w.transcriptDir}` : ""}`);
    }
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

/**
 * One line describing a checkout's local-vs-tracked state for `status`. It names
 * the LIVE HEAD branch (the `branch:` line above it is the transcript-recorded
 * one, which can be stale), and says where the answer came from — the comparison
 * is deliberately fetch-free, against the tracking ref as this clone last saw it.
 * When the branch has no configured upstream the wording stays hedged rather
 * than asserting the work was never pushed.
 */
function describeSync(sync: BranchSync): string {
  const where = "(from .git refs, no fetch)";
  const head = `HEAD on ${sync.branch}`;
  if (!sync.unpushed) return `${head} — matches ${sync.upstream} ${where}`;
  if (sync.hasRemoteRef) return `${head} — differs from ${sync.upstream}: unpushed or diverged ${where}`;
  return sync.upstreamConfigured
    ? `${head} — nothing at ${sync.upstream} yet: never pushed ${where}`
    : `${head} — no ${sync.upstream} ref and no configured upstream: unpushed, or tracking another remote ${where}`;
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
  const { raw, cursor } = capturePaneState(target);
  const readiness = paneReadiness(raw, cursor);
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
  const { raw, cursor } = capturePaneState(target);
  const readiness = paneReadiness(raw, cursor);
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
  /** Workflow-tool runs the session launched, with their effective status. */
  workflows: { runId: string; name: string; status: WorkflowStatus; summary: string | null }[];
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
  const thresholdMs = resolveStalledAfterMs(opts.stalledAfterMs);
  const enriched = opts.json || opts.all || opts.pr !== undefined || opts.item !== undefined;
  if (!enriched) return runPlainList(index, opts.filterRoot, thresholdMs);

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
      const { raw, cursor } = capturePaneState(window);
      readiness = paneReadiness(raw, cursor);
      shells = paneShells(raw);
    }
    const l = linkOf(s);
    const idle = idleSeconds(s.lastUsed);
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
      idleSeconds: idle,
      stalled: isStalled({ running, readiness, idleSeconds: idle }, thresholdMs),
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
      pr: l?.pr ?? null,
      workItem: l?.workItem ?? null,
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
    const wfRunning = r.workflows.filter((w) => w.status === "running").length;
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
 * session — id-bearing names (`cl-bg-`/`cl-new-`/`cl-claude-`/`cl-copilot-`) by
 * embedded short id, work-item / PR names by working directory (as in model.ts)
 * — then report readiness, kind, id, location and title. Running-only and
 * model-free by design. An optional `filterRoot` scopes to sessions under it, and
 * `thresholdMs` (already resolved by the caller) decides the ⚠stalled marker.
 */
function runPlainList(index: SessionIndex, filterRoot: string | null, thresholdMs: number): void {
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
    const { raw, cursor } = capturePaneState(name);
    const shells = paneShells(raw);
    const readiness = paneReadiness(raw, cursor);
    // Running-workflow marker (◆N): the session is live here by construction.
    const wfRunning = (s.workflows ?? []).filter((w) => workflowStatus(w, true) === "running").length;
    // …and so is the liveness the stall qualifier requires.
    const stalled = isStalled({ running: true, readiness, idleSeconds: idleSeconds(s.lastUsed) }, thresholdMs);
    rows.push(
      [
        "●",
        readiness.padEnd(10),
        KIND_LABEL[kind].padEnd(3),
        shortId(s.id),
        timeAgo(s.lastUsed).padEnd(8),
        (basename(s.cwd) || s.cwd).slice(0, 24).padEnd(24),
        s.title.replace(/\s+/g, " ").slice(0, 44),
        [stalled ? STALLED_MARK : "", shells > 0 ? `⛁${shells}` : "", wfRunning > 0 ? `◆${wfRunning}` : ""]
          .filter(Boolean)
          .join(" "),
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
