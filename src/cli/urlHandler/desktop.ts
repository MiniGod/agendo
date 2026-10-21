// The pure half of `agendo url-handler`: the .desktop entry that registers the
// agendo:// scheme, the Exec line inside it, and the edits to mimeapps.list.
import { basename, delimiter, join } from "path";

/** The entry's file name — also what `xdg-mime default` is told. */
export const DESKTOP_FILE = "agendo-url-handler.desktop";

/** The MIME type a browser looks up for an agendo:// link. */
export const SCHEME_MIME = "x-scheme-handler/agendo";

/**
 * The package spec the default Exec line runs through bunx: the npm RELEASE this
 * install is, pinned. Never a git ref — a link any allowed page can fire would
 * then fetch and run whatever that branch says today — and never the
 * commit-pinned self-command, which can name a /tmp staging dir. An upgrade lands
 * on the next `url-handler install`. Without a readable version, the latest
 * release: still a published, reviewed build.
 */
export function defaultSpec(version: string): string {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version) ? `agendo@${version}` : "agendo";
}

/** `${XDG_DATA_HOME:-~/.local/share}/applications`. */
export function applicationsDir(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_DATA_HOME?.trim() || join(home, ".local", "share"), "applications");
}

/** `${XDG_CONFIG_HOME:-~/.config}/mimeapps.list`, where `xdg-mime default` records its choice. */
export function mimeappsPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME?.trim() || join(home, ".config"), "mimeapps.list");
}

// The Desktop Entry spec's reserved characters: an argument holding any of them
// must be double-quoted in an Exec key.
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/**
 * One argument, quoted for an Exec key: double quotes when it holds a reserved
 * character, with `"`, `` ` ``, `$` and `\` backslash-escaped inside them; `%`
 * doubled, since a lone one starts a field code. Then the value-level escaping
 * every desktop-file string gets, which doubles the backslashes once more.
 */
export function quoteExecArg(arg: string): string {
  const pct = arg.replace(/%/g, "%%");
  const quoted = RESERVED.test(pct) ? `"${pct.replace(/(["`$\\])/g, "\\$1")}"` : pct;
  return quoted.replace(/\\/g, "\\\\");
}

/** The Exec value: the command words, then `url %u` — the browser substitutes the link for `%u` as ONE argument. */
export function execLine(command: string[]): string {
  return [...command.map(quoteExecArg), "url", "%u"].join(" ");
}

/** The full .desktop file. */
export function desktopEntry(command: string[]): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=agendo",
    "Comment=Focus an agendo session from an agendo:// link",
    `Exec=${execLine(command)}`,
    "Terminal=false",
    "NoDisplay=true",
    `MimeType=${SCHEME_MIME};`,
    "",
  ].join("\n");
}

/** The `Exec=` value of a desktop file, or null. */
export function readExec(text: string): string | null {
  const m = /^Exec=(.*)$/m.exec(text);
  return m ? m[1] : null;
}

/**
 * mimeapps.list with OUR default for the scheme removed, and nothing else
 * touched: only a line that maps the agendo scheme to this exact entry goes, so
 * a handler the user chose by hand survives an uninstall.
 */
export function withoutOurDefault(text: string): string {
  const ours = new RegExp(`^${SCHEME_MIME.replace(/[/]/g, "\\/")}=${DESKTOP_FILE.replace(/\./g, "\\.")};?\\s*$`);
  return text.split("\n").filter((l) => !ours.test(l)).join("\n");
}

/** Where a command was found on PATH, and whether that place survives a reboot. */
export interface Resolved {
  path: string;
  /** `path` with its symlinks resolved — the script itself, for a global install's bin link. */
  real: string;
  /** A package runner's staging copy (`/tmp/bunx-…`, `_npx`) — gone the next time its cache is cleared. */
  volatile: boolean;
}

/** `cmd` on `pathEnv`, first hit, or null. `exists` is injected for tests. */
export function findOnPath(cmd: string, pathEnv: string, exists: (p: string) => boolean): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (dir && exists(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

/** Is `realPath` a package runner's temporary copy? */
export function isVolatile(realPath: string): boolean {
  return /(^|\/)(bunx-[^/]*|_npx)\//.test(realPath) || realPath.startsWith("/tmp/");
}

/**
 * The command the Exec line runs, when `--exec` did not name one. A browser
 * starts it with the desktop session's environment — often without the PATH
 * entries a shell profile adds — so every word that names a program is an
 * ABSOLUTE path:
 *
 *  1. a global install of `agendo` (anything on PATH that is not a runner's
 *     temporary copy), run by bun's absolute path. Its bin is a
 *     `#!/usr/bin/env bun` script, and the shebang would look bun up on that
 *     same thin PATH. Without bun found, the bin itself is the best there is;
 *  2. else `bunx agendo@<this version>` (see `defaultSpec`), by bunx's
 *     absolute path.
 *
 * Null when neither is available; the caller then asks for `--exec`.
 */
export function defaultCommand(agendo: Resolved | null, bun: string | null, bunx: string | null, spec: string): string[] | null {
  if (agendo && !agendo.volatile) return bun ? [bun, agendo.real] : [agendo.path];
  if (bunx) return [bunx, spec];
  return null;
}

/**
 * The program an Exec value starts — its first word, with the desktop-file and
 * Exec quoting undone — so `status` can say when it has gone missing. Null for
 * an empty or unterminated value.
 */
export function execProgram(exec: string): string | null {
  const value = exec.replace(/\\\\/g, "\\").trimStart();
  const m = /^"((?:[^"\\]|\\.)*)"|^([^"\s]\S*)/.exec(value);
  if (!m) return null;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2].replace(/%%/g, "%");
}

/** `--exec` split into words; refused when it already carries the URL slot or is empty. */
export function parseExec(raw: string): string[] | null {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.some((w) => w.includes("%"))) return null;
  return words;
}

/** The handler a `xdg-mime query default` answer names, for `status`. */
export function isOurs(queryOutput: string): boolean {
  return basename(queryOutput.trim()) === DESKTOP_FILE;
}
