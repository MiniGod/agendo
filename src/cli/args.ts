import { parseDuration } from "../wait.ts";
import { scopeFlagValue } from "../scope.ts";

/**
 * Parse a required duration flag, exiting with a clear error on bad/missing
 * input. Validates argv for the flags the one-shot subcommands parse
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
 * The exiting form of `scopeFlagValue`, for the subcommands parsed in
 * dispatch.ts and listArgs.ts (`wait` uses the returning form directly — it
 * turns its whole argv tail into an exit code rather than exiting mid-parse).
 * One guard, so a missing `--repo` can't be an error on one subcommand and a
 * silent "no filter" on another.
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

/**
 * A dashed token nobody recognises is refused rather than repurposed — see
 * `parseSessionArgs` for the three times that bug was fixed. `status` phrases
 * its own refusal in dispatch.ts; `open`, `list` and its subcommands share
 * this one.
 */
export function unknownArgument(cmd: string, a: string): never {
  console.error(`${cmd}: unknown argument "${a}"`);
  process.exit(1);
}

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
