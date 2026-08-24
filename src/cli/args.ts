import { parseDuration } from "../wait.ts";
import { knownHost } from "../remote.ts";
import { scopeFlagValue } from "../scope.ts";

/**
 * Parse the `<id> [--flag]` argument shape shared by the single-session
 * subcommands (`close`/`kill`/`stop`, `resume`, `unblock`).
 *
 * Strict on purpose, and the reason is a bug that has now been fixed three
 * times in this codebase: a dashed token nobody recognises must never be
 * silently repurposed. `launch` used to fold `--modle opus` into the prompt
 * text; `close` used to accept `--yolo` as a session id. `resume` and
 * `unblock` were the two that were missed, and they failed the quieter way —
 * with an id already parsed, a typo'd `--forse` or `--atach` hit neither branch
 * of their old loop and was dropped on the floor, so the command ran in the
 * mode the user had just asked it not to use and said nothing.
 *
 * A second positional is rejected for the same reason: `resume a b` means the
 * caller is confused about which argument is the id, and guessing is worse than
 * refusing.
 */
export function parseSessionArgs(
  verb: string,
  argv: string[],
  flag: { long: string; short: string },
): { id: string | undefined; flag: boolean } {
  let on = false;
  let id: string | undefined;
  for (const a of argv) {
    if (a === flag.long || a === flag.short) on = true;
    else if (a.startsWith("-")) {
      console.error(`${verb}: unknown flag "${a}" (only ${flag.long}/${flag.short})`);
      process.exit(1);
    } else if (id === undefined) id = a;
    else {
      console.error(`${verb}: unexpected argument "${a}" — ${verb} takes exactly one session id`);
      process.exit(1);
    }
  }
  return { id, flag: on };
}

/**
 * The `--remote` flag, shared by the TUI and `agendo ls`.
 *
 * Local-only is the default and stays the default: without this flag agendo
 * spawns no beam, reads no config of anyone else's, and behaves exactly as it
 * always has. Remote machines are opt-in per invocation.
 *
 * Two spellings, and the split is deliberate:
 *
 *   --remote          every machine beam has registered
 *   --remote=<name>   that machine only; repeatable
 *
 * The value form needs the `=` because the bare form has to stay bare — both
 * commands that take this flag also take an optional `[dir]` positional, so a
 * space-separated `--remote /some/path` could not be told from "all machines,
 * scoped to that path" without guessing which the user meant. Guessing there
 * would silently scope a listing to something other than what the command line
 * reads as.
 *
 * `--remote vm` is therefore an error rather than a silent misread — but only
 * when the next token names a machine beam actually knows, so an ordinary path
 * argument is never second-guessed.
 *
 * Returns null when the flag is absent (local only), or the selected machines —
 * an empty array meaning "all registered".
 */
export function parseRemoteFlag(
  verb: string,
  arg: string,
  next: string | undefined,
  selected: string[] | null,
  isKnownHost: (name: string) => boolean,
): string[] {
  const acc = selected ?? [];
  const eq = arg.indexOf("=");
  if (eq !== -1) {
    const name = arg.slice(eq + 1);
    if (!name) {
      console.error(`${verb}: --remote= needs a machine name (or use a bare --remote for all of them)`);
      process.exit(1);
    }
    // Checked here rather than left to fail per-machine later: a typo'd name
    // would otherwise surface as beam's "unknown remote" on a warning line
    // under a listing that otherwise looks fine, which reads as "that machine
    // is down" rather than "you spelled it wrong".
    if (!isKnownHost(name)) {
      console.error(`${verb}: unknown machine "${name}" — beam has not registered it (see: beam remote ls)`);
      process.exit(1);
    }
    return [...acc, name];
  }
  if (next !== undefined && !next.startsWith("-") && isKnownHost(next)) {
    console.error(
      `${verb}: --remote takes its machine with an "=" — write \`--remote=${next}\`. ` +
        `A bare \`--remote\` means every machine beam has registered.`,
    );
    process.exit(1);
  }
  return acc;
}

/**
 * Parse a required duration flag, exiting with a clear error on bad/missing
 * input. Lives here because it validates argv for THIS module's flags
 * (`--stalled-after` on `status` and `list`); `wait` parses its own argv inside
 * wait.ts. The duration grammar itself is not duplicated — `parseDuration` is
 * imported from wait.ts, so `2s`/`5m`/`1h` mean the same thing everywhere.
 */
export function requireDuration(cmd: string, flag: string, s: string | undefined): number {
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
export function requireValue(cmd: string, flag: string, v: string | undefined): string {
  const value = scopeFlagValue(cmd, flag, v);
  if (value === null) process.exit(1);
  return value;
}

/** `list`'s path scope was named twice — as `[dir]`, as `--path`, or as both. */
export function duplicatePathScope(): never {
  console.error(`list: the path scope was given twice — [dir] and --path <dir> name the same slot`);
  process.exit(1);
}

/** The launcher's own argv: `[dir]`, `-s <name>`, `--remote[=<machine>]`. */
export function parseMenuArgs(argv: string[]): { pathArg?: string; session?: string; remote: string[] | null } {
  let pathArg: string | undefined;
  let session: string | undefined;
  // null = this machine only, which is what every invocation without --remote
  // passes and what agendo has always done.
  let remote: string[] | null = null;
  const rest = argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "-s" || a === "--session") session = rest[++i];
    else if (a === "--remote" || a.startsWith("--remote=")) remote = parseRemoteFlag("agendo", a, rest[i + 1], remote, knownHost);
    else if (!a.startsWith("-") && pathArg === undefined) pathArg = a;
  }
  return { pathArg, session, remote };
}
