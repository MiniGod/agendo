// Writing config.json from the Settings page.
//
// config.json is hand-edited JSON that may carry keys agendo never reads (a
// user's own notes, a key from an older or newer version), so a save is a merge,
// never a rewrite from the Config shape: the file in effect is read as a plain
// object, the edited keys are set on it, and every other key goes back out
// verbatim and in its place.
//
// The file in effect may still be a legacy `~/.clops/` or `~/.claude-launcher/`
// one (see `configPathInEffect`). Saves always go to the new `~/.agendo/`, so the
// first one writes the legacy content plus the edit there, and every later read
// finds the new file first. The legacy file is left as it was.
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, resolve } from "path";
import { messageOf } from "../shared/errors.ts";
import { CONFIG_PATH, configPathInEffect, type Config } from "./config.ts";

/** Keys to set; a key given as `undefined` is removed from the file instead. */
export type ConfigPatch = { [K in keyof Config]?: Config[K] | undefined };

/**
 * The JSON object stored at `path`, or `{}` when there is no file. Throws when
 * the file exists but isn't a JSON object: saving over it would replace the
 * user's hand-edited content with only what the Settings page knows, which is
 * worse than refusing and saying why. The advice is to fix it, never to remove
 * it: with the file gone, the next save would write the edited key alone, and
 * the org, project and team the page still shows would be lost.
 */
export function readConfigObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  // Read outside the parse: a file that can't be read throws as itself (EACCES, EISDIR), path included.
  const text = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path} isn't valid JSON (${messageOf(e)}) — fix it by hand; nothing saves until then`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} doesn't hold a JSON object — fix it by hand; nothing saves until then`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Why the file at `path` can't be read as a config, or null when it can (an
 * absent file reads, as `{}`). `loadConfig` reads such a file as the defaults,
 * which at startup is all there is; a re-read under a running launcher would
 * blank a working org, project and team instead, so it asks here first.
 */
export function configReadError(path: string): string | null {
  try {
    readConfigObject(path);
    return null;
  } catch (e) {
    return messageOf(e);
  }
}

/** `raw` with `patch` applied. Keys the patch doesn't name keep their value and their place. */
export function mergeConfig(raw: Record<string, unknown>, patch: ConfigPatch): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out;
}

/** Whether `path` is itself a symlink, resolving or not. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The file a write to `path` lands in: the end of its symlinks, so a link stays
 * a link. A dangling one (a dotfiles target not checked out yet) is followed by
 * hand, since realpath refuses it; a loop is given up on after Linux's own 40
 * hops, and the write replaces the link.
 */
function writeTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  let target = path;
  for (let hops = 0; isSymlink(target); hops++) {
    if (hops === 40) return path;
    target = resolve(dirname(target), readlinkSync(target));
  }
  return target;
}

/** Write `text` to a new file at `path`, flushed to disk before this returns. */
function writeFlushed(path: string, text: string, mode: number): void {
  const fd = openSync(path, "w", mode);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flush `dir`'s entries to disk, so a rename into it outlives a power cut. Best effort. */
function flushDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every filesystem lets a directory be opened and synced; the rename has happened either way.
  }
}

/**
 * Replace `path` with `text` atomically: a temp file beside it, flushed to disk,
 * then rename(2), and the directory flushed after it — so a crash, a full disk or
 * a power cut can't leave a truncated or empty config behind. A symlinked
 * config (a dotfiles checkout) is written through, so it stays a link, and an
 * existing file keeps its permissions; a new one takes `modeOf`'s, when that
 * exists (the legacy config a first save migrates).
 */
export function writeFileAtomic(path: string, text: string, modeOf: string = path): void {
  const target = writeTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  const like = existsSync(target) ? target : modeOf;
  const kept = existsSync(like) ? statSync(like).mode & 0o777 : null;
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFlushed(tmp, text, kept ?? 0o644);
    // The create mode is masked by the umask; an existing file's is restored exactly.
    if (kept !== null) chmodSync(tmp, kept);
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  flushDir(dirname(target));
}

/**
 * Apply `patch` to the config in effect and write the result to the new path.
 * Returns the path written. Throws (with a message fit to show) when the file
 * in effect can't be merged into, or the write fails.
 */
export function saveConfig(
  patch: ConfigPatch,
  paths: { from: string; to: string } = { from: configPathInEffect(), to: CONFIG_PATH },
): string {
  const merged = mergeConfig(readConfigObject(paths.from), patch);
  writeFileAtomic(paths.to, `${JSON.stringify(merged, null, 2)}\n`, paths.from);
  return paths.to;
}
