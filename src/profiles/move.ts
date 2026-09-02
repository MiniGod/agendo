// Moving one Claude session's on-disk files from the profile it landed in to
// another. A move, never a copy: two transcripts with the same session id would
// diverge, and SessionIndex.build() dedupes by `source:id`, so the second copy
// would silently vanish from the UI anyway.
//
// Returns `{ error }` rather than throwing — the TUI surfaces it as a yellow
// notice and stays alive. The work is three phases over a fixed move set:
// decide (guards, alias checks, the clobber check), place (rename, or copy
// across filesystems, rolling back on any failure), then drop the sources a
// copy left behind.
import { cp, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir } from "fs/promises";
import { basename, dirname, join } from "path";
import type { AgentSession } from "../types.ts";
import type { ClaudeProfile } from "./types.ts";

/** Outcome of a profile move. Never throws; failures come back as `error`. */
export interface MoveResult {
  /** Set when nothing was moved and the session is untouched. */
  error?: string;
  /** Source and target are the same store — there was nothing to do. */
  noop?: boolean;
  /** The transcript's new absolute path, on success. */
  logPath?: string;
  /** What was relocated, profile-relative, for the notice. */
  moved?: string[];
  /**
   * A problem that came up AFTER the data was safely at the destination (a
   * source copy that couldn't be deleted). The move succeeded; this is a
   * leftover worth telling the user about.
   */
  warning?: string;
}

/** One file/dir to relocate, with the label used in notices. */
interface MoveEntry {
  from: string;
  to: string;
  label: string;
  /** A sibling `agent-*.jsonl` this session owns, rather than one of the four
   *  fixed id-keyed places. Its destination isn't in `destinations()`, so the
   *  clobber check has to be told about it explicitly. */
  sidechain?: boolean;
}

/** An entry phase 1 has put in place, and how — a copy still has its source. */
interface Placed {
  entry: MoveEntry;
  copied: boolean;
}

/**
 * Test-only: force the cross-device (copy-then-delete) path even when
 * `rename(2)` would have worked. Two profiles on different filesystems can't be
 * created portably in the test environment, so this stands in for the EXDEV a
 * `~/.claude` on another mount raises. Never set from production code.
 */
let forceCrossDevice = false;
export function __setForceCrossDevice(on: boolean): void {
  forceCrossDevice = on;
}

/**
 * Relocate a Claude session's on-disk files into `target`.
 *
 * The moving unit, all keyed by the session id (so every piece is unambiguously
 * this session's — nothing shared is touched):
 *   • `projects/<enc-cwd>/<id>.jsonl` — the transcript
 *   • `projects/<enc-cwd>/<id>/`      — the sidecar dir (tool-results, subagents
 *     incl. `subagents/workflows/<runId>/`, `workflows/scripts/`)
 *   • `session-env/<id>/`, `tasks/<id>/` — per-session state beside the store
 * `<enc-cwd>/` is reused verbatim from the source path (never re-derived from
 * the cwd — the encoding is claude's, not ours) and created in the target.
 *
 * Top-level `agent-*.jsonl` sidechain transcripts (siblings of the transcript,
 * skipped by the indexer) are moved ONLY on positive content evidence — see
 * ownedAgentTranscripts. Untouched: `<profile>/.claude.json`
 * (`projects[<cwd>].lastSessionId` / history) — claude owns that file, rewriting
 * it under a possibly-running CLI is not worth the risk, and the only cost is
 * that the moved session is no longer the target profile's "last session" for
 * that directory. An `<enc-cwd>/` left empty in the source profile is likewise
 * left alone: it holds no sessions, so nothing lists it, and removing a directory
 * another session may be about to write into buys nothing.
 *
 * The caller must have established that the session is NOT running — a live
 * `claude` keeps writing to these files, and on the cross-device path (below)
 * those writes would land in a copy that is about to be deleted.
 */
export async function moveSessionToProfile(s: AgentSession, target: ClaudeProfile): Promise<MoveResult> {
  const src = movable(s);
  if ("error" in src) return src;
  const srcEnc = dirname(src.logPath); // <src>/projects/<enc-cwd>
  const srcProjects = dirname(srcEnc); // <src>/projects
  const enc = basename(srcEnc);
  const destLog = join(target.projects, enc, `${s.id}.jsonl`);
  if (await sameStore(src.logPath, srcProjects, destLog, target.projects)) return { noop: true, logPath: src.logPath };

  const entries = await moveEntries(s.id, enc, src.configDir, srcProjects, target);
  if (!entries.find((e) => e.from === src.logPath)) return { error: `transcript not found at ${src.logPath}` };
  const taken = await occupied(s.id, enc, target, entries);
  if (taken) return { error: `${target.name} already has ${taken} — refusing to overwrite it` };

  const from = basename(src.configDir);
  const placed = await placeAll(entries, from);
  if ("error" in placed) return placed;
  return { logPath: destLog, moved: entries.map((e) => e.label), warning: await dropSources(placed.done, from) };
}

/** The guards: what this session must be for a move to make sense at all. */
function movable(s: AgentSession): { error: string } | { logPath: string; configDir: string } {
  if (s.source !== "claude") return { error: "only Claude sessions live in a profile" };
  if (!s.logPath || !s.configDir) return { error: "this session has no on-disk transcript to move" };
  // The id becomes a path component below. Real ids are UUIDs; anything else is
  // a corrupt index entry, and joining it blind could escape the profile.
  if (!/^[A-Za-z0-9._-]+$/.test(s.id) || s.id === "." || s.id === "..") return { error: `unusable session id: ${s.id}` };
  return { logPath: s.logPath, configDir: s.configDir };
}

/**
 * Resolve BOTH stores before deciding anything. Following a symlink and copying
 * its target into place is exactly the failure mode to avoid: if the two names
 * already reach the same store there is nothing to relocate. Then the
 * finer-grained aliasing: the stores differ, but this session's `<enc-cwd>` dir
 * (or the transcript itself) is symlinked across, so both paths already reach
 * one inode. Still nothing to move.
 */
async function sameStore(logPath: string, srcProjects: string, destLog: string, dstProjects: string): Promise<boolean> {
  const [srcStore, dstStore] = await Promise.all([
    realpath(srcProjects).catch(() => srcProjects),
    realpath(dstProjects).catch(() => dstProjects),
  ]);
  if (srcStore === dstStore) return true;
  const [srcLogReal, destLogReal] = await Promise.all([
    realpath(logPath).catch(() => null),
    realpath(destLog).catch(() => null),
  ]);
  return srcLogReal !== null && srcLogReal === destLogReal;
}

/**
 * Refuse to clobber — checked over the FULL destination set, not just the
 * entries the source happens to have. A session with no sidecar of its own must
 * still refuse a target that already holds `<id>/`, or the transcript would land
 * beside a foreign sidecar and the rebased workflow paths would read that other
 * run's files. The sidechain transcripts this move would carry are checked too:
 * their destinations aren't in the fixed set, and on the rename path an existing
 * same-named file at the target is REPLACED silently — which rollback cannot
 * undo, since renaming back restores the source but not what was overwritten.
 * (The `cp` path is already protected by `errorOnExist`.) `lstat` (not `stat`)
 * so a DANGLING symlink also counts as occupied: `rename` onto one silently
 * replaces it, and `cp` follows it out of the profile.
 *
 * Returns the label of the first occupied destination, or null.
 */
async function occupied(id: string, enc: string, target: ClaudeProfile, entries: MoveEntry[]): Promise<string | null> {
  for (const c of [...destinations(id, enc, target), ...entries.filter((e) => e.sidechain)]) {
    if (await exists(c.to)) return c.label;
  }
  return null;
}

/**
 * Phase 1: place every entry, destroying nothing. `rename` when we can (atomic,
 * and it keeps the inode a still-open reader is holding); `cp` when the two
 * profiles are on different filesystems and rename raises EXDEV. A copied
 * entry's SOURCE stays put until phase 2, so a failure anywhere in here rolls
 * back to a fully intact session in the source profile.
 */
async function placeAll(entries: MoveEntry[], from: string): Promise<{ done: Placed[] } | { error: string }> {
  const done: Placed[] = [];
  // Topmost directories we had to create, so rollback can take them away again
  // instead of leaving empty scaffolding in a profile the session never reached.
  // `mkdir(recursive)` returns exactly that path (or undefined when it made none),
  // so removing it can only ever remove what this move brought into being.
  const createdDirs: string[] = [];
  for (const e of entries) {
    const failed = await place(e, done, createdDirs);
    if (failed) {
      await rollback(done, createdDirs);
      return { error: `${failed} — session left in ${from}` };
    }
  }
  return { done };
}

/** Place one entry; on success it is pushed onto `done`. Returns the failure to report, or null. */
async function place(e: MoveEntry, done: Placed[], createdDirs: string[]): Promise<string | null> {
  try {
    const made = await mkdir(dirname(e.to), { recursive: true });
    if (made) createdDirs.push(made);
  } catch (err) {
    return `couldn't create ${dirname(e.to)}: ${msg(err)}`;
  }
  const crossDevice = await renameEntry(e);
  if (typeof crossDevice === "string") return crossDevice;
  if (!crossDevice) {
    done.push({ entry: e, copied: false });
    return null;
  }
  const copyFailed = await copyEntry(e);
  if (copyFailed) return copyFailed;
  done.push({ entry: e, copied: true });
  return null;
}

/**
 * `rename`, atomic. False when it worked; true when the target is on another
 * filesystem (EXDEV) and the caller has to copy; otherwise the failure to report.
 *
 * Residual race: POSIX `rename` has no NOREPLACE mode reachable from Node, so
 * anything that appears at `e.to` between the clobber check and this call is
 * replaced silently. The window is sub-millisecond and the only writer that
 * could hit it is a second claude/agendo creating THIS session id in the target
 * profile at that instant. The `cp` path has no such gap (`errorOnExist` +
 * `force: false` re-checks atomically at copy time).
 */
async function renameEntry(e: MoveEntry): Promise<boolean | string> {
  try {
    if (forceCrossDevice) throw Object.assign(new Error("EXDEV (forced)"), { code: "EXDEV" });
    await rename(e.from, e.to);
    return false;
  } catch (err: any) {
    return err?.code === "EXDEV" ? true : `couldn't move ${e.label}: ${msg(err)}`;
  }
}

/**
 * The cross-filesystem copy. `verbatimSymlinks` copies a symlink AS a symlink
 * instead of resolving it, so a user's own symlinks inside the sidecar survive
 * the move unchanged. A failed `cp` can leave a HALF-WRITTEN tree at the
 * destination (it copies entry by entry); nothing pushed it onto `done`, so
 * rollback wouldn't know about it — and leaving it there would make every retry
 * abort on the clobber check, forcing the user to hand-delete debris this tool
 * created. So it is removed here. Returns the failure to report, or null.
 */
async function copyEntry(e: MoveEntry): Promise<string | null> {
  try {
    await cp(e.from, e.to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    return null;
  } catch (err) {
    await rm(e.to, { recursive: true, force: true }).catch(() => {});
    return `couldn't copy ${e.label} across filesystems: ${msg(err)}`;
  }
}

/**
 * Phase 2: the session is now readable under the target; drop the sources the
 * copies left behind. A failure here is NOT a failed move — the data is in
 * place — but the leftover would be indexed as a second, diverging copy of the
 * same session id, so it's reported (as the warning) rather than swallowed.
 */
async function dropSources(done: Placed[], from: string): Promise<string | undefined> {
  const leftovers: string[] = [];
  for (const { entry, copied } of done) {
    if (!copied) continue;
    try {
      await rm(entry.from, { recursive: true, force: true });
    } catch {
      leftovers.push(entry.label);
    }
  }
  return leftovers.length ? `couldn't delete ${leftovers.join(", ")} from ${from} — remove it by hand` : undefined;
}

/** The four fixed, id-keyed places a session occupies in a profile. Used both to
 *  build the move set (source side) and to run the clobber check (target side),
 *  so the two can't drift. */
function destinations(id: string, enc: string, target: ClaudeProfile): { to: string; label: string }[] {
  return [
    { to: join(target.projects, enc, `${id}.jsonl`), label: `projects/${enc}/${id}.jsonl` },
    { to: join(target.projects, enc, id), label: `projects/${enc}/${id}/` },
    { to: join(target.configDir, "session-env", id), label: `session-env/${id}/` },
    { to: join(target.configDir, "tasks", id), label: `tasks/${id}/` },
  ];
}

/**
 * The entries to relocate: whichever of the four id-keyed places the source
 * actually has, plus any sibling `agent-*.jsonl` this session owns. Probed with
 * `lstat`, so a symlinked piece is listed (and later moved) as the link it is.
 */
async function moveEntries(
  id: string,
  enc: string,
  srcConfig: string,
  srcProjects: string,
  target: ClaudeProfile,
): Promise<MoveEntry[]> {
  const froms = [
    join(srcProjects, enc, `${id}.jsonl`),
    join(srcProjects, enc, id),
    join(srcConfig, "session-env", id),
    join(srcConfig, "tasks", id),
  ];
  const candidates: MoveEntry[] = destinations(id, enc, target).map((d, i) => ({ from: froms[i], ...d }));
  const present = await Promise.all(candidates.map((c) => exists(c.from)));
  const entries = candidates.filter((_, i) => present[i]);
  for (const name of await ownedAgentTranscripts(join(srcProjects, enc), id)) {
    entries.push({
      from: join(srcProjects, enc, name),
      to: join(target.projects, enc, name),
      label: `projects/${enc}/${name}`,
      sidechain: true,
    });
  }
  return entries;
}

/**
 * How much of a sibling `agent-*.jsonl` we read looking for its owning session.
 * The marker recurs on nearly every record, so it shows up almost immediately;
 * the cap just stops a pathological multi-hundred-MB transcript from being slurped
 * into memory during an interactive move.
 */
const AGENT_SNIFF_BYTES = 1 << 20;

/**
 * Sibling `agent-*.jsonl` files in `<enc-cwd>/` that belong to `id`.
 *
 * These are sub-agent (sidechain) transcripts written NEXT TO the session
 * transcripts rather than inside the session's own sidecar dir; the indexer skips
 * them by filename (their `agent-<hex>` name is a sub-agent id, so they aren't
 * resumable sessions). The filename therefore says nothing about which session
 * spawned them — but the RECORDS do: sampling a real sidechain transcript shows a
 * `"sessionId":"<owning session uuid>"` field repeated throughout (absent only
 * from the very first record). So attribution is by content, on POSITIVE evidence
 * only: a file that names this session moves with it, and anything else — another
 * session's id, no id at all, unreadable — is left exactly where it is.
 *
 * Honest caveat: no such top-level file exists anywhere in the corpus available
 * to develop against (every `agent-*.jsonl` found lives under a session's own
 * `subagents/` dir, which travels wholesale as part of the sidecar). The layout is
 * therefore inferred, which is precisely why the rule refuses to guess: if the
 * inference is wrong the matcher simply finds nothing and behaves as before.
 */
async function ownedAgentTranscripts(encDir: string, id: string): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(encDir)).filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const marker = `"sessionId":"${id}"`;
  const owned = await Promise.all(
    names.map(async (name) => ((await readHead(join(encDir, name), AGENT_SNIFF_BYTES)).includes(marker) ? name : null)),
  );
  return owned.filter((n): n is string => n !== null).sort();
}

/** The first `bytes` of a file as text, or "" if it can't be read. */
async function readHead(path: string, bytes: number): Promise<string> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return "";
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Undo whatever phase 1 already did, newest first, then take away any directory
 *  scaffolding it created. Best-effort by design: this runs on a path that has
 *  already failed, and its job is to leave the source profile whole and the target
 *  as it found it, not to raise a second error over the first. */
async function rollback(done: Placed[], createdDirs: string[]): Promise<void> {
  for (const { entry, copied } of [...done].reverse()) {
    if (copied) await rm(entry.to, { recursive: true, force: true }).catch(() => {});
    else await rename(entry.to, entry.from).catch(() => {});
  }
  // Deepest first, so a nested pair (`<target>/projects/<enc>` under a freshly
  // created `<target>/projects`) doesn't leave the parent behind.
  //
  // Deliberately NON-recursive: every entry this move placed has just been taken
  // back, so these are expected to be empty and `rmdir` is enough. A recursive
  // delete would buy nothing when that holds and destroy real data when it
  // doesn't — phase 1 can span seconds on the cross-device path, and another
  // claude writing a NEW session into the `<enc-cwd>/` dir we happened to create
  // would have its transcript deleted by our rollback. ENOTEMPTY means someone
  // else is using the directory: leave it.
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    await rmdir(dir).catch(() => {});
  }
}

/** Does the path exist as anything at all — including a dangling symlink? */
function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false,
  );
}

function msg(e: unknown): string {
  return String((e as any)?.message ?? e);
}
