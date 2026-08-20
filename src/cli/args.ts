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
