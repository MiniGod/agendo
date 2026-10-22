// `agendo url-handler install|uninstall|status` — register agendo as the
// desktop's handler for agendo:// links, so a button on a PR page can focus the
// session working on it (see src/cli/focus/).
//
// Install writes ONE file, `$XDG_DATA_HOME/applications/agendo-url-handler.desktop`,
// refreshes that dir's desktop database (mimeinfo.cache) and asks `xdg-mime`
// to make it the scheme's default. Uninstall removes that file, refreshes the
// database again, and drops the one mimeapps.list line pointing at it. Nothing
// else is touched beyond what `update-desktop-database` rewrites in that dir.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { spawnSync } from "child_process";
import { readVersion } from "../version.ts";
import {
  DESKTOP_FILE, MIMEINFO_CACHE, SCHEME_MIME, applicationsDir, cacheListsUs, defaultCommand, defaultSpec, desktopEntry, execWords, findOnPath, isOurs, isVolatile,
  mimeappsPath, parseExec, readExec, withoutOurDefault, type Resolved,
} from "./desktop.ts";
import { DESKTOP_SESSION_PATH, bunBinary, execTarget, launchPath, launchProblem, withPath } from "./launchPath.ts";
import { refreshCommand, refreshDesktopDatabase } from "./desktopDb.ts";

const USAGE = "usage: url-handler install [--exec <command>] | uninstall | status";

function fail(text: string): never {
  console.error(`url-handler: ${text}`);
  process.exit(1);
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `agendo` on PATH, and whether it is a runner's temporary copy. */
function resolveAgendo(pathEnv: string): Resolved | null {
  const p = findOnPath("agendo", pathEnv, existsSync);
  if (!p) return null;
  return { path: p, volatile: isVolatile(realpathOr(p)) };
}

/** The command words for the Exec line — `--exec`'s, or the detected default — run under a PATH that has bun. */
function execCommand(execArg: string | undefined): string[] {
  const pathEnv = process.env.PATH ?? "";
  const onPath = (cmd: string) => findOnPath(cmd, pathEnv, existsSync);
  const command = execArg !== undefined
    ? parseExec(execArg) ?? fail("--exec needs a command (and may not contain %)")
    : defaultCommand(resolveAgendo(pathEnv), onPath("bunx"), defaultSpec(readVersion()))
      ?? fail("found neither a global agendo install nor bunx on PATH; pass --exec <command>");
  return withPath(command, launchPath(bunBinary(process.execPath, onPath), pathEnv));
}

/** `xdg-mime …`, or null when it could not run or failed. */
function xdgMime(args: string[]): string | null {
  const r = spawnSync("xdg-mime", args, { encoding: "utf-8", timeout: 10_000 });
  return r.status === 0 ? r.stdout ?? "" : null;
}

function install(execArg: string | undefined): void {
  const command = execCommand(execArg);
  const dir = applicationsDir(process.env, homedir());
  const file = join(dir, DESKTOP_FILE);
  const text = desktopEntry(command);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  console.log(`wrote ${file}:\n`);
  console.log(text);
  refresh(dir);
  if (xdgMime(["default", DESKTOP_FILE, SCHEME_MIME]) === null) {
    fail(`could not register it: \`xdg-mime default ${DESKTOP_FILE} ${SCHEME_MIME}\` failed`);
  }
  console.log(`set ${DESKTOP_FILE} as the default handler for ${SCHEME_MIME}`);
}

/** Rebuild `dir`'s desktop database; a warning, never a failure, when that is not possible. */
function refresh(dir: string): void {
  const warning = refreshDesktopDatabase(dir);
  if (warning) console.error(warning);
}

function uninstall(): void {
  const dir = applicationsDir(process.env, homedir());
  const file = join(dir, DESKTOP_FILE);
  const had = existsSync(file);
  rmSync(file, { force: true });
  console.log(had ? `removed ${file}` : `${file} was not installed`);
  // Also when the entry was already gone, if there is a database: it may still list it.
  if (had || existsSync(join(dir, MIMEINFO_CACHE))) refresh(dir);
  const list = mimeappsPath(process.env, homedir());
  if (!existsSync(list)) return;
  const before = readFileSync(list, "utf-8");
  const after = withoutOurDefault(before);
  if (after === before) return;
  writeFileSync(list, after);
  console.log(`removed the ${SCHEME_MIME} default from ${list}`);
}

/** The desktop entry's path, and its Exec line when it is installed. */
function installedEntry(): { file: string; exec: string | null; installed: boolean } {
  const file = join(applicationsDir(process.env, homedir()), DESKTOP_FILE);
  if (!existsSync(file)) return { file, exec: null, installed: false };
  return { file, exec: readExec(readFileSync(file, "utf-8")), installed: true };
}

/** How `status` describes what `xdg-mime` says handles the scheme. */
function handlerLine(handler: string | null): string {
  if (!handler) return "no handler registered";
  return isOurs(handler) ? handler : `${handler} (not agendo's entry)`;
}

/** The desktop entry's part of `status`: where it is, what it runs, and whether that still exists. */
function printEntry(entry: ReturnType<typeof installedEntry>): void {
  console.log(`desktop entry: ${entry.installed ? entry.file : "not installed"}`);
  if (entry.installed) console.log(`  Exec=${entry.exec ?? "(none)"}`);
  warnIfMissing(entry.exec);
}

function status(): void {
  const entry = installedEntry();
  printEntry(entry);
  const handler = currentHandler();
  console.log(`${SCHEME_MIME}: ${handlerLine(handler)}`);
  const registered = entry.installed && isRegistered(dirname(entry.file));
  // 0 only when the entry exists, the desktop database lists it, AND the desktop
  // resolves the scheme to it: default-but-unregistered is the state in which a
  // Flatpak or Snap browser shows an empty "Open With…" dialog.
  process.exitCode = registered && isOurs(handler ?? "") ? 0 : 1;
}

/**
 * Say so when the entry would not start from a link: a program it names is gone
 * (a cleared bunx cache, an uninstalled bun), or it needs bun and the PATH it
 * runs under — its own `env PATH=`, else the desktop session's — has none.
 */
function warnIfMissing(exec: string | null): void {
  const words = exec === null ? null : execWords(exec);
  const target = words ? execTarget(words) : null;
  if (!words || !target) return;
  for (const program of new Set([words[0], target.program])) {
    if (program.startsWith("/") && !existsSync(program)) console.log(`  warning: ${program} does not exist; re-run \`url-handler install\``);
  }
  const problem = launchProblem(target, target.path ?? DESKTOP_SESSION_PATH, existsSync, readHead);
  if (problem) console.log(`  warning: ${problem}; re-run \`url-handler install\``);
}

/** The first 64 KiB of a file — enough for a shebang or a wrapper's `bun x` line — or null. */
function readHead(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(65_536);
      return buf.toString("utf-8", 0, readSync(fd, buf, 0, buf.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Does the desktop database list the entry? Says so when it does not: `xdg-mime`
 * may still report it as the default, but the desktop portal — which Flatpak and
 * Snap browsers open links through — offers only registered handlers.
 */
function isRegistered(dir: string): boolean {
  const cache = join(dir, MIMEINFO_CACHE);
  if (existsSync(cache) && cacheListsUs(readFileSync(cache, "utf-8"))) return true;
  console.log(`  warning: ${cache} does not list ${DESKTOP_FILE} for ${SCHEME_MIME}; run \`${refreshCommand(dir)}\``);
  return false;
}

/** The desktop file `xdg-mime` says handles the scheme now, or null. */
function currentHandler(): string | null {
  return xdgMime(["query", "default", SCHEME_MIME])?.trim() || null;
}

/** The `install` flags: only `--exec <command>`. */
function installArgs(rest: string[]): string | undefined {
  if (rest.length === 0) return undefined;
  if (rest[0] === "--exec" && rest.length === 2) return rest[1];
  if (rest.length === 1 && rest[0].startsWith("--exec=")) return rest[0].slice("--exec=".length);
  return fail(`unexpected arguments: ${rest.join(" ")}\n${USAGE}`);
}

export function urlHandlerCommand(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (sub === "install") return install(installArgs(rest));
  if (rest.length > 0) fail(`unexpected arguments: ${rest.join(" ")}\n${USAGE}`);
  if (sub === "uninstall") return uninstall();
  if (sub === "status") return status();
  fail(USAGE);
}
