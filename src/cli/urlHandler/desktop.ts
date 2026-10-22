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
  /** A package runner's staging copy (`/tmp/bunx-…`, `_npx`), judged with symlinks resolved — gone the next time its cache is cleared. */
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
 * ABSOLUTE path, and install runs it under a PATH that has bun (launchPath.ts):
 *
 *  1. a global install of `agendo` (anything on PATH that is not a runner's
 *     temporary copy), the bin itself. Whatever it is — a `#!/usr/bin/env bun`
 *     script, a wrapper running `bun x …` — it finds bun on that baked PATH;
 *  2. else `bunx agendo@<this version>` (see `defaultSpec`), by bunx's
 *     absolute path.
 *
 * Null when neither is available; the caller then asks for `--exec`.
 */
export function defaultCommand(agendo: Resolved | null, bunx: string | null, spec: string): string[] | null {
  if (agendo && !agendo.volatile) return [agendo.path];
  if (bunx) return [bunx, spec];
  return null;
}

// The desktop-file string escapes, undone before the Exec value is split.
const VALUE_ESCAPES: Record<string, string> = { s: " ", n: "\n", t: "\t", r: "\r", "\\": "\\" };

// One Exec word: a double-quoted string, or a run with no quote or space in it.
const EXEC_WORD = /^\s*(?:"((?:[^"\\]|\\.)*)"|([^"\s]+))(?=\s|$)/;

/**
 * An Exec value split into its words, with the desktop-file and Exec quoting
 * undone and `%%` back to `%` — the inverse of `execLine` — so `status` can
 * read what the entry runs. Null for an unterminated or malformed value.
 */
export function execWords(exec: string): string[] | null {
  let rest = exec.replace(/\\(.)/g, (m, c: string) => VALUE_ESCAPES[c] ?? m);
  const words: string[] = [];
  while (rest.trim()) {
    const m = EXEC_WORD.exec(rest);
    if (!m) return null;
    words.push((m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]).replace(/%%/g, "%"));
    rest = rest.slice(m[0].length);
  }
  return words;
}

/** The program an Exec value starts — its first word — or null for an empty or malformed value. */
export function execProgram(exec: string): string | null {
  return execWords(exec)?.[0] ?? null;
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

/** The desktop database's file in an applications dir, written by `update-desktop-database`. */
export const MIMEINFO_CACHE = "mimeinfo.cache";

/**
 * Does a mimeinfo.cache list our entry among the scheme's handlers? This is
 * what `gio` calls "registered", as opposed to "default" (mimeapps.list) — and
 * what xdg-desktop-portal, which Flatpak and Snap browsers open links through,
 * needs before it will offer the entry at all.
 */
export function cacheListsUs(cacheText: string): boolean {
  const line = cacheText.split("\n").find((l) => l.startsWith(`${SCHEME_MIME}=`));
  return line !== undefined && line.slice(SCHEME_MIME.length + 1).split(";").includes(DESKTOP_FILE);
}

/** One word quoted for a POSIX shell, so a printed fix command pastes as-is. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;
}
