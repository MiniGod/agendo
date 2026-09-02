// The one-shot subcommands, in the order argv is tested against them.
//
// Every branch below ends in process.exit, so this returns ONLY when the
// invocation is the interactive menu — which is exactly what index.tsx does
// with it. Keeping the chain in one place keeps that contract checkable.

import { RESUME_DIALOG_WAIT_MS, tmuxAvailable } from "../tmux.ts";
import { llmGuide } from "../launch.ts";
import { resolveContext } from "../context.ts";
import { makeSessionScope, scopeFlagValue } from "../scope.ts";
import { parseDuration, runWaitCli } from "../wait.ts";
import type { BranchSyncReader } from "../types.ts";
import { HELP } from "./help.ts";
import { parseSessionArgs } from "./args.ts";
import { runStatus } from "./status.ts";
import { runList } from "./list.ts";
import { runLaunch } from "./launchCmd.ts";
import { runOpen } from "./open.ts";
import { runSend } from "./send.ts";
import { runResume } from "./resume.ts";
import { runClose } from "./close.ts";
import { runUnblock } from "./unblock.ts";
import { runListPrs } from "./listPrs.ts";
import { runListIssues } from "./listIssues.ts";
import { runListRepos } from "./listRepos.ts";

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

// `status <id>`: print a session's state + the same recent-activity summary the
// menu shows, so an agent that launched a background session can poll it.
async function statusCommand(readBranchSync: BranchSyncReader): Promise<void> {
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
    readBranchSync,
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
async function openCommand(): Promise<void> {
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

// `send <id> <prompt>`: type a prompt into a running session's input and submit
// it — but only if the TUI looks idle/ready, so we never clobber an open
// question, a mid-turn generation, or text already queued in the box.
async function sendCommand(): Promise<void> {
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

// `list repos`: a THIRD kind of listing — one row per repository, saying which
// ones have an orchestrator and which are unmanaged. It takes the session list's
// own scope selectors rather than the resource lists' `[dir]` context, because it
// is a view of the same sessions grouped differently, not a backend query.
async function listReposCommand(sub: string): Promise<void> {
  let json = false;
  let dirArg: string | undefined;
  let repoArg: string | undefined;
  const rest = process.argv.slice(4);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--json") json = true;
    else if (a === "--path") {
      if (dirArg !== undefined) duplicatePathScope();
      dirArg = requireValue("list repos", a, rest[++i]);
    } else if (a === "--repo") repoArg = requireValue("list repos", a, rest[++i]);
    else if (!a.startsWith("-")) {
      if (dirArg !== undefined) duplicatePathScope();
      dirArg = a;
    } else {
      console.error(`list ${sub}: unknown argument "${a}"`);
      process.exit(1);
    }
  }
  await runListRepos({ json, scope: makeSessionScope({ path: dirArg, repo: repoArg }, process.cwd()) });
}

// `list` (alias `ls`): print the managed sessions that are running right now —
// one per line, with input readiness and how each was started — so an agent (or
// human) can discover the background sessions it can `status`/`send` to. The
// default stays live-only and model-free (fast, no backend auth needed); the
// flags below opt into richer, association-resolving output for orchestrators.
async function listCommand(readBranchSync: BranchSyncReader): Promise<void> {
  // Subcommand routing: `list pr|prs` and `list issues|wi|work-items|…` are
  // resource lists (open PRs / issues-work-items and their associated sessions),
  // distinct from the default session list. Only the exact keywords route here;
  // any other non-dash positional falls through to the session list's `[dir]`
  // path filter, and the dashed `--pr`/`--issue` stay session-list query flags.
  const sub = process.argv[3];
  const PR_SUBS = new Set(["pr", "prs"]);
  const ISSUE_SUBS = new Set(["issue", "issues", "wi", "work-item", "work-items", "workitem", "workitems"]);
  const REPO_SUBS = new Set(["repo", "repos"]);
  if (sub !== undefined && REPO_SUBS.has(sub)) {
    await listReposCommand(sub);
    process.exit(0);
  }
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
    readBranchSync,
    json, all, pr, item,
    scope: makeSessionScope({ path: dirArg, repo: repoArg }, process.cwd()),
    stalledAfterMs,
  });
  process.exit(0);
}

export async function runSubcommand(readBranchSync: BranchSyncReader): Promise<void> {
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

  if (process.argv[2] === "status") await statusCommand(readBranchSync);

  if (process.argv[2] === "open") await openCommand();
  // `launch` is long enough to be its own module; see ./launchCmd.ts.
  if (process.argv[2] === "launch") await runLaunch();

  if (process.argv[2] === "send") await sendCommand();

  if (process.argv[2] === "list" || process.argv[2] === "ls") await listCommand(readBranchSync);

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
}
