// The PATH an agendo:// link runs under. A browser starts the handler with the
// desktop session's environment — under systemd --user, a PATH without
// ~/.bun/bin — and every way of running agendo ends in `bun` looked up on PATH:
// a `#!/usr/bin/env bun` bin, a wrapper script calling `bun x …`. So install
// bakes a PATH into the Exec line itself, `env PATH=<bun's dir>:… <command>`,
// and `status` reads it back to say when the entry would not find bun.
import { basename, delimiter, dirname } from "path";
import { findOnPath, isVolatile } from "./desktop.ts";

/** Starts the command with the PATH set. By absolute path: the Exec line cannot rely on PATH to find it. */
export const ENV = "/usr/bin/env";

/** Appended to a baked PATH so the system dirs are there even when the installing shell's PATH lacked them. */
export const FALLBACK_PATH = "/usr/local/bin:/usr/bin:/bin";

/** systemd's default PATH: what a desktop session started by `systemd --user` has, unless something adds to it. */
export const DESKTOP_SESSION_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The bun running agendo — `execPath` when that is bun itself — else bun on PATH, else null. */
export function bunBinary(execPath: string, onPath: (cmd: string) => string | null): string | null {
  return /^bun(\.exe)?$/.test(basename(execPath)) ? execPath : onPath("bun");
}

/**
 * The PATH to bake: bun's dir first, then the installing shell's PATH, then
 * FALLBACK_PATH — each dir once, in that order, so a reinstall writes the same
 * line. Relative and empty entries go (a link would resolve them against
 * whatever dir the browser started it in), and so do a package runner's
 * temporary dirs, which are gone once its cache is cleared, and every
 * `node_modules/.bin`: `bun x` and `bun run` prepend one per parent of the
 * dir they were started in, so keeping them would make the line depend on
 * where install ran and let that project's dependencies shadow `tmux` or `git`.
 */
export function launchPath(bun: string | null, installingPath: string): string {
  const dirs = [bun ? dirname(bun) : "", ...installingPath.split(delimiter), ...FALLBACK_PATH.split(delimiter)]
    .map((d) => d.replace(/(.)\/+$/, "$1"))
    .filter((d) => d.startsWith("/") && !isVolatile(`${d}/`) && !/(^|\/)node_modules(\/|$)/.test(d));
  return [...new Set(dirs)].join(delimiter);
}

/** `command` run through env with PATH set: the words the Exec line starts with. */
export function withPath(command: string[], path: string): string[] {
  return [ENV, `PATH=${path}`, ...command];
}

/** The program an Exec line's words start, past an `env NAME=value …` prefix, and the PATH that prefix sets. */
export interface ExecTarget {
  program: string;
  /** The `PATH=` an env prefix sets, or null when the line inherits the desktop session's. */
  path: string | null;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Read the env prefix off Exec words (see `execWords`). Null when there is no program after it. */
export function execTarget(words: string[]): ExecTarget | null {
  if (words.length === 0 || basename(words[0]) !== "env") return words.length ? { program: words[0], path: null } : null;
  const rest = words.slice(1);
  const n = rest.findIndex((w) => !ASSIGNMENT.test(w));
  if (n === -1) return null;
  const set = rest.slice(0, n).filter((w) => w.startsWith("PATH=")).pop();
  return { program: rest[n], path: set === undefined ? null : set.slice("PATH=".length) };
}

/**
 * Does a program's text look bun up on PATH? A bare `bun`/`bunx` word does — a
 * `#!/usr/bin/env bun` shebang, a wrapper's `bun x …`. So does bun named by its
 * path when it runs a package (`/abs/bun x …`, `/abs/bun run …`, `/abs/bunx …`):
 * the package's bin starts through its own `#!/usr/bin/env bun` shebang, unless
 * `--bun` makes bun run it itself. Only bun-by-path running a file
 * (`/abs/bun /x/index.tsx`) asks PATH for nothing.
 */
export function mentionsBun(text: string): boolean {
  return /(^|[\s"'`;|&(])bunx?(?=$|[\s"'`;|&)])/m.test(text)
    || /\/(bun[ \t]+(x|run)|bunx)[ \t]+(?!--bun\b)/.test(text);
}

/**
 * Why the program would not start from a link, or null when it would: it is not
 * on PATH, or it runs bun and bun is not on PATH. bun itself needs no lookup;
 * bunx does — it runs agendo's bin, whose `#!/usr/bin/env bun` shebang asks PATH.
 * `path` is the PATH the line runs under; `head` reads the start of a file, or
 * null when it cannot.
 */
export function launchProblem(target: ExecTarget, path: string, exists: (p: string) => boolean, head: (p: string) => string | null): string | null {
  const where = target.path === null ? `the desktop session's PATH (${path})` : `its PATH (${path})`;
  const program = target.program.startsWith("/") ? target.program : findOnPath(target.program, path, exists);
  if (program === null) return `${target.program} is not on ${where}`;
  if (/^bun(\.exe)?$/.test(basename(program)) || findOnPath("bun", path, exists) !== null) return null;
  const runsBun = /^bunx(\.exe)?$/.test(basename(program)) || mentionsBun(head(program) ?? "");
  return runsBun ? `${program} runs bun, which is not on ${where}` : null;
}

