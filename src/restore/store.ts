// Where a restore snapshot lives on disk, and the read/write of it.
//
// Kept separate from the rest because it is the only part with a compatibility
// surface: the per-session files, the three legacy single-file locations that
// still have to be readable, and the validation that keeps a hand-edited or
// truncated snapshot from crashing startup.
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { OLD_STATE_DIR, PREV_STATE_DIR, STATE_DIR } from "../config.ts";
import { parseJsonFileOr } from "../errors.ts";
import { LAUNCHER_SESSION } from "../tmux.ts";
import { tmuxSafeName } from "../context.ts";

/**
 * Restore snapshots are kept PER HOST SESSION so parallel path-scoped launchers
 * don't clobber each other's tabs. Each host session's snapshot lives in its own
 * file under `~/.agendo/restore/<session>.json` (separate files avoid concurrent
 * launchers racing on a shared map). For the default `agendo` session, reads fall
 * back to the historical single-file snapshots (`~/.agendo/restore.json`, then
 * the prior `~/.clops/restore.json`, then `~/.claude-launcher/restore.json`) so an
 * existing install keeps working across the format change. Writes always go to
 * the new per-session location.
 */
const RESTORE_DIR = join(STATE_DIR, "restore");
const LEGACY_RESTORE_PATHS = [
  join(STATE_DIR, "restore.json"), // ~/.agendo/restore.json (pre-per-session)
  join(PREV_STATE_DIR, "restore.json"), // ~/.clops/restore.json (the prior name)
  join(OLD_STATE_DIR, "restore.json"), // ~/.claude-launcher/restore.json (original)
];

/** The per-session snapshot file (always the write target for a session). */
function restoreFileFor(session: string): string {
  return join(RESTORE_DIR, `${tmuxSafeName(session) || session}.json`);
}

/** Where to READ a session's snapshot from, honoring the legacy fallback. */
function restoreReadPath(session: string): string {
  const perSession = restoreFileFor(session);
  if (existsSync(perSession)) return perSession;
  // Only the default host session inherits the pre-context single-file snapshot.
  if (session === LAUNCHER_SESSION) {
    for (const p of LEGACY_RESTORE_PATHS) if (existsSync(p)) return p;
  }
  return perSession;
}

/** One persisted tab: a managed window name + how to (lazily) resume it. */
export interface RestoreTab {
  /**
   * tmux window name to recreate: always the *canonical* resume name for the
   * attributed session (`cl-<source>-<id>`, see `sessionName`), NOT the original
   * window's name. A fresh-launch window is named `cl-wi-…`/`cl-pr-…`/`cl-free-…`
   * after a work item / PR / slug; persisting that verbatim would let a restored
   * placeholder squat the fresh-launch namespace, so a later `freshName(id)`
   * would `switch-client` to the stale placeholder instead of launching a new
   * agent. The canonical name lives in the resume namespace and can't collide.
   */
  name: string;
  /** Working directory to launch the resume in. */
  cwd: string;
  /** Display title shown on the placeholder. */
  title: string;
  /**
   * argv to run when the tab is opened (a resume command). Re-run verbatim each
   * time the tab is woken, including after the agent exits — a resume addresses
   * its session by id and carries no prompt, so it's idempotent.
   */
  argv: string[];
}

export function loadRestore(session: string = LAUNCHER_SESSION): RestoreTab[] {
  const path = restoreReadPath(session);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  // A snapshot is a pure cache of which tabs were open — losing it costs you the
  // restored tab strip, nothing more. So a corrupt file is reported (by path,
  // via parseJsonFileOr's warning) and ignored rather than failing startup.
  const data = parseJsonFileOr<any>(text, path, null);
  const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
  // Keep only well-formed entries — a hand-edited or stale file shouldn't crash startup.
  return tabs.filter(
    (t: any): t is RestoreTab =>
      t && typeof t.name === "string" && typeof t.cwd === "string" && Array.isArray(t.argv) && t.argv.length > 0,
  );
}

export function saveRestore(session: string, tabs: RestoreTab[]): void {
  try {
    if (!existsSync(RESTORE_DIR)) mkdirSync(RESTORE_DIR, { recursive: true });
    writeFileSync(restoreFileFor(session), JSON.stringify({ tabs }, null, 2));
  } catch {
    // Persisting the tab snapshot is best-effort; ignore write failures.
  }
}
