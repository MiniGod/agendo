// Keeps the test suites off the developer's real tmux server.
//
// agendo decides where to put a window from the environment: `$TMUX` set means
// "open a window in the server that variable names", and without it tmux falls
// back to the default socket under `$TMUX_TMPDIR` (or /tmp). A suite run from
// inside a tmux pane inherits that pane's `$TMUX`, so any test that reaches a
// real launch path — `openSession`, `openTarget`, a restore — opens a REAL
// window, running the REAL `claude`, in whatever session the developer ran the
// suite from. That is not hypothetical: test/listNav.test.ts did exactly that
// on every `bun test` until it spied `openSession` out.
//
// So every runner (the bun preload in test/preload.ts, playwright.config.ts and
// `bun run crap`) calls `isolateTmux` on the environment its tests inherit, and
// the unit preload additionally puts `writeGuardBin`'s fakes first on PATH so a
// launch path that slips through is recorded and failed, not executed.
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where `$TMUX_TMPDIR` points under test: a path that always exists and is
 * never a directory, so tmux cannot create its socket directory there and every
 * command that resolves a server by name — no `-S`, or `-L <name>` — fails with
 * "couldn't create directory". That is the point. A private temp directory
 * would not do: tmux falls back to /tmp, the developer's live server, the moment
 * `$TMUX_TMPDIR` names something that does not exist, and a temp directory stops
 * existing at cleanup while a straggling child may still be running. This one
 * has no cleanup, and no server can start under it that would then need
 * killing.
 */
export const DEAD_TMUX_TMPDIR = "/dev/null";

/**
 * Point `env` away from every tmux server: drop `$TMUX` and `$TMUX_PANE` (so
 * `insideTmux()` is false and nothing targets the caller's server) and aim
 * `$TMUX_TMPDIR` at `DEAD_TMUX_TMPDIR`. A spec that wants a fake server, as the
 * e2e harness does, sets its own `$TMUX_TMPDIR` for the process it spawns.
 */
export function isolateTmux(env: Record<string, string | undefined>): void {
  delete env.TMUX;
  delete env.TMUX_PANE;
  env.TMUX_TMPDIR = DEAD_TMUX_TMPDIR;
}

/**
 * Make `Bun.spawn`, `Bun.spawnSync` and `Bun.which` default to the environment
 * as it is NOW. Without an explicit `env` (or `PATH`) they use the one the
 * process STARTED with, so the `$TMUX`, `$TMUX_TMPDIR` and PATH a preload sets
 * would never reach them — unlike `node:child_process` and `Bun.$`, which read
 * `process.env` per call. An explicit `env` or `PATH` is left exactly as the
 * caller wrote it.
 */
export function bunWithLiveEnv(): void {
  type Spawn = (cmd: unknown, opts?: { env?: unknown }) => unknown;
  const bun = Bun as unknown as Record<"spawn" | "spawnSync", Spawn>;
  for (const name of ["spawn", "spawnSync"] as const) {
    const original = bun[name];
    bun[name] = (cmd, opts) =>
      Array.isArray(cmd)
        ? original(cmd, { ...opts, env: opts?.env ?? process.env })
        : original({ ...(cmd as object), env: (cmd as { env?: unknown }).env ?? process.env });
  }
  const which = Bun.which;
  Bun.which = (cmd, opts) => which(cmd, { ...opts, PATH: opts?.PATH ?? process.env.PATH });
}

/** The agent CLIs a launch path execs. A test never has a reason to run one. */
export const AGENT_BINARIES = ["claude", "codex", "copilot"] as const;

/** tmux commands that only read. Anything else would change a server. */
const READ_ONLY_TMUX = new Set([
  "-V",
  "has-session",
  "list-clients",
  "list-panes",
  "list-sessions",
  "list-windows",
  "show-options",
  "show-window-options",
]);

/** Reads only when they PRINT: without `-p`, `capture-pane` fills a paste
 *  buffer and `display-message` shows the message on a client. */
const READ_ONLY_WITH_P = new Set(["capture-pane", "display-message"]);

/** tmux's global flags that take a value, so the subcommand is the arg after it. */
const FLAGS_WITH_VALUE = new Set(["-L", "-S", "-f", "-c", "-T"]);

/** Whether `arg` ends the tmux command it belongs to: a lone `;`, or an
 *  argument ending in an unescaped one (`new-window;`), which tmux splits too. */
function endsCommand(arg: string): boolean {
  return arg === ";" || (arg.endsWith(";") && !arg.endsWith("\\;"));
}

/** Every command in a tmux argv, name first then its own arguments, including
 *  those chained after a `;`. */
export function tmuxInvocations(args: string[]): string[][] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-") && args[i] !== "-V") {
    i += FLAGS_WITH_VALUE.has(args[i]!) ? 2 : 1;
  }
  const out: string[][] = [];
  let atCommand = true;
  for (const arg of args.slice(i)) {
    const word = endsCommand(arg) ? arg.slice(0, -1) : arg;
    if (atCommand && arg !== ";") out.push([word]);
    else if (arg !== ";") out.at(-1)!.push(word);
    atCommand = endsCommand(arg);
  }
  return out;
}

/** Every subcommand in a tmux argv, including those chained after a `;`. */
export function tmuxCommands(args: string[]): string[] {
  return tmuxInvocations(args).map(([name]) => name!);
}

function readsOnly([name, ...args]: string[]): boolean {
  if (READ_ONLY_TMUX.has(name!)) return true;
  return READ_ONLY_WITH_P.has(name!) && args.includes("-p");
}

/**
 * Whether one recorded invocation would have reached outside the test: any run
 * of an agent CLI, or a tmux command that would create, kill, send to, display
 * on or reconfigure something. Reads are fine — against the fake they answer
 * "no server running", which is the state a unit test assumes anyway.
 */
export function isEscape(argv: string[]): boolean {
  const [bin, ...args] = argv;
  if (bin !== "tmux") return true;
  const cmds = tmuxInvocations(args);
  return cmds.length === 0 || !cmds.every(readsOnly);
}

export interface GuardBin {
  /** Directory to put first on PATH. */
  dir: string;
  /** One file per invocation of any fake: each argument followed by US
   *  (U+001F), which no argument a test passes contains, where a newline can
   *  (a `-F` format, prompt text). */
  calls: string;
}

const US = String.fromCharCode(0x1f);
/** A record the fake is still writing; renamed into place once it is whole. */
const PARTIAL = ".part";

/**
 * Write fakes for tmux and every agent CLI into `root/bin`. Each one records
 * its argv and exits 1 without a word, so a read sees an empty server and a
 * launch fails without running anything — and without a stray line in the
 * suite's output, since tmux's own stdio is often inherited.
 *
 * Each call gets its own file, written aside and renamed into place, so
 * concurrent fakes can never interleave and a reader never sees half a record
 * — whatever the size of the arguments.
 */
export function writeGuardBin(root: string): GuardBin {
  const dir = join(root, "bin");
  const calls = join(root, "calls");
  mkdirSync(dir, { recursive: true });
  mkdirSync(calls, { recursive: true });
  for (const name of ["tmux", ...AGENT_BINARIES]) {
    const path = join(dir, name);
    writeFileSync(
      path,
      [
        "#!/bin/sh",
        `f=${JSON.stringify(calls)}/$(date +%s%N).$$`,
        `printf '%s\\037' ${name} "$@" > "$f${PARTIAL}" && mv "$f${PARTIAL}" "$f"`,
        "exit 1",
        "",
      ].join("\n"),
    );
    chmodSync(path, 0o755);
  }
  return { dir, calls };
}

/** Every whole invocation recorded since the last read, oldest first, each
 *  consumed as it is read. One still being written waits for the next read. */
export function readCalls(calls: string): string[][] {
  return readdirSync(calls)
    .filter((name) => !name.endsWith(PARTIAL))
    .sort()
    .map((name) => {
      const path = join(calls, name);
      const record = readFileSync(path, "utf-8");
      rmSync(path);
      return record.split(US).slice(0, -1);
    });
}

/** Remove the directory `writeGuardBin` was given. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
