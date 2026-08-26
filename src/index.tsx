#!/usr/bin/env bun
//
// The entrypoint, and the only module in src/ allowed to import src/gitrefs.ts.
//
// Reading a checkout's refs is cheap once and ruinous on the TUI's 2s rescan
// timer, so the reader stays pinned to the one-shot CLI path: `branchSync` is
// imported here and PASSED to the subcommands that render it, rather than
// imported by them. e2e/cli.spec.ts whitelists the importers by filename;
// test/gitrefsReach.test.ts pins the invariant that whitelist stands for.
import { spawnSync } from "child_process";
import { enterLauncherSession, sessionRoot } from "./tmux.ts";
import { withSelfCmdEnv } from "./launch.ts";
import { restoreTabs } from "./restore.ts";
import { branchSync } from "./gitrefs.ts";
import { resolveContext } from "./context.ts";
import { runSubcommand } from "./cli/dispatch.ts";
import { runMenu } from "./cli/menu.tsx";

// Every subcommand exits, so this returns only for the interactive menu.
await runSubcommand(branchSync);

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
  const plan = await runMenu(ctx);
  if (!plan) break;

  // Clear the screen before handing over so tmux starts clean.
  process.stdout.write("\x1b[2J\x1b[H");
  const [cmd, ...args] = plan.handover;
  spawnSync(cmd, args, { stdio: "inherit" });
}

process.exit(0);
