// The one-shot subcommands, in the order argv is tested against them.
//
// Every branch below ends in process.exit, so this returns ONLY when the
// invocation is the interactive menu — which is exactly what index.tsx does
// with it. Keeping the chain in one place keeps that contract checkable.

import { RESUME_DIALOG_WAIT_MS, tmuxAvailable } from "../tmux.ts";
import { llmGuide } from "../launch.ts";
import { resolveContext } from "../context.ts";
import { makeSessionScope } from "../scope.ts";
import { parseDuration, runWaitCli } from "../wait.ts";
import type { BranchSyncReader } from "../types.ts";
import { HELP } from "./help.ts";
import { parseSessionArgs, requireDuration, requireValue } from "./args.ts";
import { listRoute, parseRepoListArgs, parseResourceListArgs, parseSessionListArgs } from "./listArgs.ts";
import { parseOpenArgs } from "./openArgs.ts";
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
  const o = parseOpenArgs(process.argv.slice(3));
  await runOpen(o.token, o.want, o.printOnly, makeSessionScope({ path: o.pathArg, repo: o.repoArg }, process.cwd()));
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
async function listReposCommand(sub: string, argv: string[]): Promise<void> {
  const a = parseRepoListArgs(sub, argv);
  await runListRepos({ json: a.json, scope: makeSessionScope({ path: a.dirArg, repo: a.repoArg }, process.cwd()) });
}

// `list pr|prs` and `list issues|wi|work-items|…`: the resource lists (open PRs /
// issues-work-items and their associated sessions), distinct from the default
// session list.
async function listResourcesCommand(kind: "prs" | "issues", sub: string, argv: string[]): Promise<void> {
  const a = parseResourceListArgs(sub, argv);
  const root = a.dirArg ? resolveContext(a.dirArg, process.cwd()).filterRoot : null;
  const opts = { json: a.json, filterRoot: root, repoFilter: a.repoFilter ?? !!root };
  if (kind === "prs") await runListPrs(opts);
  else await runListIssues(opts);
}

// The default session list, scoped like `status` is and queried by PR / work item.
async function listSessionsCommand(readBranchSync: BranchSyncReader, argv: string[]): Promise<void> {
  const a = parseSessionListArgs(argv);
  await runList({
    readBranchSync,
    json: a.json, all: a.all, pr: a.pr, item: a.item,
    scope: makeSessionScope({ path: a.dirArg, repo: a.repoArg }, process.cwd()),
    stalledAfterMs: a.stalledAfterMs,
  });
}

// `list` (alias `ls`): print the managed sessions that are running right now —
// one per line, with input readiness and how each was started — so an agent (or
// human) can discover the background sessions it can `status`/`send` to. The
// default stays live-only and model-free (fast, no backend auth needed); the
// flags opt into richer, association-resolving output for orchestrators. The
// keyword after `list` picks one of the three listings (see `listRoute`); each
// parses its own argv tail in listArgs.ts.
async function listCommand(readBranchSync: BranchSyncReader): Promise<void> {
  const route = listRoute(process.argv[3]);
  const tail = process.argv.slice(4);
  if (route.kind === "sessions") await listSessionsCommand(readBranchSync, process.argv.slice(3));
  else if (route.kind === "repos") await listReposCommand(route.sub, tail);
  else await listResourcesCommand(route.kind, route.sub, tail);
  process.exit(0);
}

/** `--help`/`-h` anywhere on the line, or `help` as the verb. */
function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h") || argv[2] === "help";
}

/**
 * `--llm`: the detailed background-session workflow, kept out of the injected
 * system prompt so it's only loaded when an agent actually needs it.
 */
function wantsLlmGuide(argv: string[]): boolean {
  return argv.includes("--llm") || argv[2] === "llm";
}

/** The verbs that take no session id; each reads the rest of argv itself. */
const PLAIN_VERBS: Record<string, (readBranchSync: BranchSyncReader) => Promise<void>> = {
  status: statusCommand,
  open: () => openCommand(),
  // `launch` is long enough to be its own module; see ./launchCmd.ts.
  launch: () => runLaunch(),
  send: () => sendCommand(),
  list: listCommand,
  ls: listCommand,
};

/** A verb that acts on one session: `<verb> <id> [flag]`, then exit 0. */
interface SessionVerb {
  long: string;
  short: string;
  run: (id: string | undefined, flag: boolean, verb: string) => Promise<void>;
}

// `close <id>` (aliases `kill`, `stop`): end a running session by killing the
// tmux window it lives in, and nothing else. The aliases exist because an agent
// that guesses the wrong verb and gets "no such command" falls back to raw
// `tmux kill-window` — the exact hand-rolled tmux this subcommand exists to
// remove. Everything the session produced (worktree, branch, commits) stays on
// disk, so `resume` can bring it back.
const CLOSE: SessionVerb = { long: "--force", short: "-f", run: (id, force, verb) => runClose(id, force, verb) };

const SESSION_VERBS: Record<string, SessionVerb> = {
  // `resume <id>`: headless resume of an idle (or already-running) session. By
  // default we create/attach its tmux window *detached* — the orchestrator gets
  // the session back running without stealing the terminal — and print how to
  // reach it. `--attach` hands the terminal over the way `launch --attach` does.
  resume: { long: "--attach", short: "-a", run: (id, attach) => runResume(id, attach) },
  close: CLOSE,
  kill: CLOSE,
  stop: CLOSE,
  // `unblock <id>`: nudge a session sitting at its usage limit to continue — sends
  // <esc>continue<enter>. Distinct from `resume` (which relaunches an idle session
  // in a fresh window); this pokes a live, limited pane. Refuses unless the pane is
  // still showing the usage-limit notice, so a recovered session isn't clobbered.
  unblock: { long: "--force", short: "-f", run: (id, force) => runUnblock(id, force) },
};

/** Every verb below drives tmux; without it there is nothing to do. No suite runs without tmux, so this is the one branch here no test reaches. */
function requireTmux(): void {
  if (tmuxAvailable()) return;
  console.error("tmux is required but was not found on PATH.");
  process.exit(1);
}

/** The table's entry for a verb, and nothing for a verb it does not list (or an inherited name like `constructor`). */
function verbEntry<T>(table: Record<string, T>, verb: string): T | undefined {
  return Object.hasOwn(table, verb) ? table[verb] : undefined;
}

async function runSessionVerb(verb: string, spec: SessionVerb): Promise<never> {
  const { id, flag } = parseSessionArgs(verb, process.argv.slice(3), { long: spec.long, short: spec.short });
  await spec.run(id, flag, verb);
  process.exit(0);
}

export async function runSubcommand(readBranchSync: BranchSyncReader): Promise<void> {
  if (wantsHelp(process.argv)) {
    console.log(HELP);
    process.exit(0);
  }
  if (wantsLlmGuide(process.argv)) {
    console.log(llmGuide());
    process.exit(0);
  }
  requireTmux();

  const verb = process.argv[2] ?? "";
  const plain = verbEntry(PLAIN_VERBS, verb);
  if (plain) await plain(readBranchSync);
  const session = verbEntry(SESSION_VERBS, verb);
  if (session) await runSessionVerb(verb, session);

  // `wait [id...]`: block until the selected session(s) reach a desired state (like
  // `gh run watch`), then exit 0; exit non-zero on timeout. It's the notification
  // primitive for an orchestrator watching background sessions — run it in the
  // background and let its EXIT be the wake-up, instead of re-polling `status` on a
  // guessed cadence. See wait.ts for the poll contract and its cost.
  if (verb === "wait") {
    process.exit(await runWaitCli(process.argv.slice(3)));
  }
}
