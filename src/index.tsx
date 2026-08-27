#!/usr/bin/env bun
import { spawnSync } from "child_process";
import {
  tmuxAvailable, enterLauncherSession, shortId, sessionName, liveTargets, liveTargetForShortId,
  capturePaneState, paneReadiness, paneBackgroundAgents, paneShells, stripAnsi,
  sessionRoot, currentSessionName,
  paneResumeDialogActive,
} from "./tmux.ts";
import { formatResetTime, paneResetAt } from "./usageLimit.ts";
import { FORWARDABLE_LAUNCH_FLAGS, launchTask, llmGuide, SELF_CMD, withSelfCmdEnv } from "./launch.ts";
import { SessionIndex, loadActivity } from "./sessions.ts";
import { findPeer } from "./peer.ts";
import { durationLabel, idleSeconds, isStalled, resolveStalledAfterMs, shortAge } from "./idle.ts";
import { branchSync, type BranchSync } from "./gitrefs.ts";
import { restoreTabs, recordLaunchedSession } from "./restore.ts";
import { resolveContext } from "./context.ts";
import { makeSessionScope, scopeFilter, scopeNote, type SessionScope } from "./scope.ts";
import { refreshLiveTmux } from "./model.ts";
import { resumeDialogChoice } from "./config.ts";
import { linkLine, linkVocab } from "./output.ts";
import { runWaitCli } from "./wait.ts";
import { AGENTS } from "./types.ts";
import type { AgentSource, WorkflowStatus } from "./types.ts";
import { loadWorkflowDetails, workflowStatus } from "./workflows.ts";
import { HELP } from "./cli/help.ts";
import { flushWarnings } from "./cli/warnings.ts";
import { parseMenuArgs, parseSessionArgs, requireDuration, requireValue } from "./cli/args.ts";
import { readyCell, rowCompactionPercent, timeAgo } from "./cli/cells.ts";
import { resolveSessionLink } from "./cli/links.ts";
import { runOpen } from "./cli/open.ts";
import { runSendCli } from "./cli/send.ts";
import { runUnblock } from "./cli/unblock.ts";
import { runResume } from "./cli/resume.ts";
import { runClose } from "./cli/close.ts";
import { runMenu } from "./cli/menu.tsx";
import { runRemoteCli } from "./cli/remote.ts";
import { runListCli } from "./cli/list.ts";

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
  await runSendCli(process.argv.slice(3));
  process.exit(0);
}

// `list` (alias `ls`): print the managed sessions that are running right now —
// one per line, with input readiness and how each was started — so an agent (or
// human) can discover the background sessions it can `status`/`send` to. The
// default stays live-only and model-free (fast, no backend auth needed); the
// flags below opt into richer, association-resolving output for orchestrators.
if (process.argv[2] === "remote") process.exit(runRemoteCli(process.argv.slice(3)));

if (process.argv[2] === "list" || process.argv[2] === "ls") {
  await runListCli(process.argv.slice(3), branchSync);
  process.exit(0);
}

// `resume <id>`: headless resume of an idle (or already-running) session. By
// default we create/attach its tmux window *detached* — the orchestrator gets
// the session back running without stealing the terminal — and print how to
// reach it. `--attach` hands the terminal over the way `launch --attach` does.
if (process.argv[2] === "resume") {
  const { id, flag: attach } = parseSessionArgs("resume", process.argv.slice(3), { long: "--attach", short: "-a" });
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
  const { id, flag: force } = parseSessionArgs(verb, process.argv.slice(3), { long: "--force", short: "-f" });
  await runClose(id, force, verb);
  process.exit(0);
}

// `unblock <id>`: nudge a session sitting at its usage limit to continue — sends
// <esc>continue<enter>. Distinct from `resume` (which relaunches an idle session
// in a fresh window); this pokes a live, limited pane. Refuses unless the pane is
// still showing the usage-limit notice, so a recovered session isn't clobbered.
if (process.argv[2] === "unblock") {
  const { id, flag: force } = parseSessionArgs("unblock", process.argv.slice(3), { long: "--force", short: "-f" });
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
const { pathArg, session, remote } = parseMenuArgs(process.argv.slice(2));
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

/**
 * Resolve a session by id-or-tmux-name and print its state + recent activity
 * (the same summary the menu surfaces). A just-launched session may not have
 * written its log yet — if so we still report it as running from its live tmux
 * window. `token` may be a full session id, a short id, or a `cl-…-<id>` name.
 *
 * `withUrls` additionally resolves the session's linked PR / work item from the
 * backend and prints their full URLs (see `resolveSessionLink`).
 */
async function runStatus(
  token: string | undefined,
  full: boolean,
  scope: SessionScope | null,
  withUrls = false,
  stalledAfterMs?: number,
): Promise<void> {
  if (!token) {
    console.error(
      `usage: ${SELF_CMD} status <id> [--full] [--urls] [--path <dir>] [--repo <name>] [--stalled-after <dur>]`,
    );
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const index = await SessionIndex.build();
  const inScope = scopeFilter(scope);
  const s = index.all.find((x) => (x.id === token || shortId(x.id) === sid) && inScope(x));
  if (!s) {
    // The live-window fallback below answers for a session too young to have a
    // transcript — but a bare tmux target carries no cwd we can hold against the
    // scope, so under an explicit scope we decline rather than answer for a
    // session that may well be in another repo.
    const live = scope ? null : liveTargetForShortId(sid);
    if (live) {
      console.log(`● running (${live.name}) — no activity logged yet; it may still be starting.`);
      process.exit(0);
    }
    console.error(`No session found for "${token}"${scopeNote(scope)}.`);
    process.exit(1);
  }
  // Resolve the window through the full reconciliation, NOT liveTargetForShortId
  // alone: a session launched from a work item / PR runs in a `cl-wi-…`/`cl-pr-…`
  // window, which that helper doesn't match. Getting this wrong would report a
  // perfectly attachable session as "running outside agendo".
  const target = refreshLiveTmux(index.all).liveWindows.get(sessionName(s)) ?? liveTargetForShortId(shortId(s.id));
  // A claude running outside agendo has no window here but is very much alive;
  // report it as running (◆) rather than idle, and say why it can't be attached.
  // Only consulted when no window was found — with a window in hand the registry
  // adds nothing, and the scan would be pure cost on the common path.
  //
  // Deliberately NOT gated on `peerSocket`: that switch turns off SPEAKING an
  // undocumented protocol, and this reads a registry file. Gating it would make
  // a live session disappear from `status` — and make `resume` stop refusing to
  // put a second claude on a transcript that already has one — which is the
  // opposite of the caution the switch is for.
  const peer = !target && s.source === "claude" ? await findPeer((id) => id === s.id) : null;
  const external = !!peer;
  const running = !!target || liveTargets().has(sessionName(s)) || external;
  const act = await loadActivity(s, { full });
  // The pane is captured up front (rather than inside the `if (target)` block
  // below) because the stall qualifier needs readiness — a session that is
  // mid-turn is never stalled, however old its transcript looks — and it prints
  // above the readiness line.
  const pane = target ? capturePaneState(target.target) : null;
  const readiness = pane ? paneReadiness(pane.raw, pane.cursor) : null;
  // A pane parked on claude's own resume dialog reads as `ready` but hasn't run
  // yet, so its idle age belongs to the PREVIOUS run — never a stall (idle.ts).
  // Same signal `wait --json` reports as `resumeDialog`, not a second guess.
  // Both read off the ONE capture, in the one branch that already tested for it —
  // a second `pane ? … : …` would cost this function a complexity point for a
  // question it has already asked.
  const { resumeDialog, backgroundAgents } = pane
    ? { resumeDialog: paneResumeDialogActive(pane.raw), backgroundAgents: paneBackgroundAgents(pane.raw) }
    : { resumeDialog: false, backgroundAgents: 0 };
  const idle = idleSeconds(s.lastUsed);
  const thresholdMs = resolveStalledAfterMs(stalledAfterMs);
  // A peer with no window arrives here as running-but-`readiness: null`, which
  // isStalled already declines to judge (a live session we have no pane evidence
  // for). That is the right answer for a different reason than the one it
  // documents: the registry's own `status` is not the settled/busy test `wait`
  // uses, so treating it as one would let a stall verdict rest on a signal the
  // rest of agendo doesn't share.
  const stalled = isStalled({ running, readiness, resumeDialog, backgroundAgents, idleSeconds: idle }, thresholdMs);
  // Both config-derived values are resolved BEFORE the single drain below: the
  // stall threshold here, and the resume choice the dialog line prints further
  // down. A malformed config.json queues its complaint once per read, and
  // `takeWarnings` dedupes only against the not-yet-drained batch — so draining
  // between the two reads would print the identical line twice. One read each,
  // one drain, one message.
  const resumeChoice = resumeDialogChoice();
  // …and the drain has to happen here rather than inside the resume-dialog branch
  // (where it used to live): a corrupt config falls back to the default threshold
  // on EVERY status, and would otherwise print a stall verdict — or withhold one —
  // that the user has no way to explain.
  flushWarnings("status");
  console.log(`${external ? "◆ running" : running ? "● running" : "○ idle"}  [${s.source}] ${s.title}`);
  console.log(`  id:     ${s.id}`);
  console.log(`  dir:    ${s.cwd}`);
  if (s.branch) console.log(`  branch: ${s.branch}`);
  console.log(`  last:   ${s.lastUsed.toISOString()}`);
  if (peer) {
    console.log(`  state:  ${peer.status ?? "running"}${peer.waitingFor ? ` (${peer.waitingFor})` : ""}`);
    // Don't claim "no window" on the registry's authority alone. The peer reports
    // the pane it runs in, and a window agendo failed to ATTRIBUTE (an id-less
    // `cl-wi-…` whose cwd matched a newer sibling session) is not the same thing
    // as no window at all — saying so would send the user looking for a terminal
    // that doesn't exist. Report what the session itself says.
    console.log(
      peer.tmux
        ? `  where:  pid ${peer.pid}, tmux ${peer.tmux} — not attributed to an agendo window; \`${SELF_CMD} send\` reaches it`
        : `  where:  pid ${peer.pid}, no tmux pane — \`${SELF_CMD} send\` reaches it, attach does not`,
    );
  }
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
  // `○ idle` says the tmux window is gone, not that the session is. Say what to do
  // about it here, where the caller is already looking — the `resume:` slot is free
  // in exactly this case (the running form of the line reports the resume DIALOG).
  if (!running) {
    console.log(`  resume: ${SELF_CMD} resume ${shortId(s.id)}   (brings it back; worktree, branch and commits are intact)`);
  }
  // Full, clickable links for whatever this session is working on. Vertical
  // output, so a long URL costs nothing here (unlike the `list` table).
  if (withUrls) {
    const resolved = await resolveSessionLink(s, "status");
    const V = linkVocab(resolved.provider);
    // As in runOpen: a link with no resolvable URL reads as absent, never as a
    // partial link a human might paste.
    const pr = resolved.link?.pr?.url ? resolved.link.pr : undefined;
    const workItem = resolved.link?.workItem?.url ? resolved.link.workItem : undefined;
    if (resolved.error) {
      console.log(`  links:  (unavailable — ${resolved.error})`);
    } else if (!pr && !workItem) {
      console.log(`  links:  (no linked PR or ${V.noun})`);
    } else {
      if (pr) console.log(linkLine("pr", `${V.prPrefix}${pr.id}`, pr.url));
      if (workItem) console.log(linkLine(V.abbrev, `#${workItem.id}`, workItem.url));
    }
  }
  // The pane was captured once, up front (the stall qualifier above needed it),
  // so this reuses that snapshot rather than re-reading the same pane.
  if (pane) {
    const { raw } = pane;
    // Compaction rides on the readiness word itself ("compacting 42%") rather than
    // getting a detail line like `limit:` below, because there is nothing to say
    // beyond the number and `list` prints it the same way — one formatter, one
    // reading, so the two commands can't disagree about how far a pane has got.
    console.log(`  ready:  ${readyCell(readiness, null, rowCompactionPercent(readiness, raw))}`);
    // Reported ready (nothing is waiting on a decision about the work), but the
    // pane is parked on claude's own resume dialog — say so, since `send` will
    // answer it rather than paste into it.
    if (resumeDialog) {
      // The choice may have come from a config agendo had to ignore; that was
      // already reported by the single drain above, which is why there is no
      // second flush here.
      console.log(`  resume: claude's resume dialog is open — \`${SELF_CMD} send\` answers it (${resumeChoice}) before delivering`);
    }
    if (readiness === "limited") {
      const resetAt = paneResetAt(stripAnsi(raw));
      console.log(
        // Both forms: the ISO instant for a machine reading `status` output, and
        // the same local clock `list` and the menu show, so a human doesn't have
        // to convert UTC in their head to match up the two commands.
        `  limit:  usage limit reached${
          resetAt !== null
            ? ` — resets at ${new Date(resetAt).toISOString()} (${formatResetTime(resetAt)})`
            : " — no reset time parsed (cannot auto-resume)"
        }`,
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

// Loop: show menu → (outside tmux only) open a session → return to the menu.
// Outside tmux, picking a session resolves a "handover" plan: `attach` blocks
// until you detach, then the menu redraws. Inside tmux the menu handles opens
// itself (switches to the agent's window) and stays mounted, so it never
// resolves a plan here — the loop just waits for q/esc to quit (plan === null).
while (true) {
  const plan = await runMenu(ctx, remote);
  if (!plan) break;

  // Clear the screen before handing over so tmux starts clean.
  process.stdout.write("\x1b[2J\x1b[H");
  const [cmd, ...args] = plan.handover;
  spawnSync(cmd, args, { stdio: "inherit" });
}

process.exit(0);
