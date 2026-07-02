// Browser-style tab restore for the canonical launcher session.
//
// We persist which agent tabs (windows) are open in the canonical
// `agendo` tmux session, and on a fresh startup recreate them as *lazy*
// placeholder windows: each tab is present in the tab strip but unloaded — it
// only runs its resume command (`claude --resume <id>` / `copilot --resume=<id>`)
// when you switch to it and press a key. Same
// idea as a web browser restoring your tabs without loading every page upfront,
// so startup stays cheap (no fleet of resumed agents) until you actually open a
// tab.
//
// A snapshot is self-contained: each open `cl-*` window is attributed to the
// session it runs — a resumed window by its canonical name, an id-less
// fresh-launch window by the most-recently-used session in its pane's cwd — and
// we persist *that* session's resume command + title. So restore needs nothing
// but this file.
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { STATE_DIR, OLD_STATE_DIR } from "./config.ts";
import { LAUNCHER_SESSION, PLACEHOLDER_OPTION, launcherWindowPaths, markPlaceholder, newWindowIn, sessionName, shortId } from "./tmux.ts";
import { resumeArgv } from "./launch.ts";
import type { SessionIndex } from "./sessions.ts";
import type { AgentSession } from "./types.ts";

/**
 * Where restore reads from and writes to. Reads try the new `~/.agendo/` path
 * first and fall back to the historical `~/.claude-launcher/` so an existing
 * snapshot survives the rename; writes always go to the new path.
 */
const NEW_RESTORE_PATH = join(STATE_DIR, "restore.json");
const OLD_RESTORE_PATH = join(OLD_STATE_DIR, "restore.json");
function restorePath(): string {
  if (existsSync(NEW_RESTORE_PATH)) return NEW_RESTORE_PATH;
  if (existsSync(OLD_RESTORE_PATH)) return OLD_RESTORE_PATH;
  return NEW_RESTORE_PATH;
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
  /** argv to exec when the tab is opened (a resume command). */
  argv: string[];
}

export function loadRestore(): RestoreTab[] {
  const path = restorePath();
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    const tabs = Array.isArray(data?.tabs) ? data.tabs : [];
    // Keep only well-formed entries — a hand-edited or stale file shouldn't crash startup.
    return tabs.filter(
      (t: any): t is RestoreTab =>
        t && typeof t.name === "string" && typeof t.cwd === "string" && Array.isArray(t.argv) && t.argv.length > 0,
    );
  } catch {
    return [];
  }
}

function saveRestore(tabs: RestoreTab[]): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(NEW_RESTORE_PATH, JSON.stringify({ tabs }, null, 2));
  } catch {
    // Persisting the tab snapshot is best-effort; ignore write failures.
  }
}

/**
 * The most-recently-used on-disk session whose cwd matches `cwd`, or undefined.
 * Used to attribute an id-less managed target (`cl-wi-…`, `cl-pr-…`, `cl-free-…`)
 * — named after a work item / PR / slug rather than a session id — back to the
 * session most likely running in it. Exported as the single source of truth for
 * this cwd+lastUsed pick (refreshLiveTmux in model.ts shares the same heuristic).
 */
export function bestSessionForCwd(sessions: AgentSession[], cwd: string): AgentSession | undefined {
  let best: AgentSession | undefined;
  for (const s of sessions) {
    if (s.cwd === cwd && (!best || s.lastUsed.getTime() > best.lastUsed.getTime())) best = s;
  }
  return best;
}

/** Managed names that embed a session short id (vs. a work-item / PR id). */
const ID_BEARING = /^cl-(?:claude|copilot|bg|new)-(.+)$/;

/**
 * Resolve which on-disk session a live launcher window is running.
 *
 * Id-bearing names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/`cl-new-`) embed the
 * session's short id, so we match that exact session — unambiguous, and right
 * even when two sessions share a cwd. Only the id-less names (`cl-wi-…`,
 * `cl-pr-…`, `cl-free-…`) carry no session id, so for those we fall back to the
 * cwd+lastUsed heuristic. Mirrors the attribution in model.ts `reconcileLive`.
 */
export function resolveWindowSession(
  sessions: AgentSession[],
  name: string,
  cwd: string,
): AgentSession | undefined {
  const idMatch = name.match(ID_BEARING);
  if (idMatch) return sessions.find((s) => shortId(s.id) === idMatch[1]);
  return bestSessionForCwd(sessions, cwd);
}

/**
 * Snapshot the agent tabs currently open in the canonical launcher session so a
 * future startup can lazily restore them. Each `cl-*` window (the menu's own
 * "launcher" window is excluded — it doesn't match `cl-`) is attributed to the
 * session it's running — a resumed window by its canonical name, an id-less
 * fresh-launch window by the most-recently-used session in its pane's cwd — and
 * we persist that session's resume command + title so restore is self-contained.
 * A window with no resumable session yet on disk is skipped — there's nothing to
 * `--resume`.
 *
 * No-op when the canonical session isn't running, so a standalone menu never
 * clobbers a snapshot saved by the real launcher session.
 */
export function captureRestore(index: SessionIndex): void {
  const windows = launcherWindowPaths();
  // A live tmux session always has ≥1 window, so an empty list means the
  // canonical session isn't running — skip so a standalone menu never clobbers
  // a saved snapshot. (Also avoids a separate `tmux has-session` spawn per load.)
  if (windows.length === 0) return;
  // Pass the current snapshot so buildTabs can preserve a just-recorded session
  // whose on-disk log doesn't exist yet (see recordLaunchedSession).
  saveRestore(buildTabs(windows, index.all, loadRestore()));
}

/**
 * Pure tab-building core of `captureRestore`: map the live `cl-*` launcher
 * windows to the deduped, self-contained `RestoreTab[]` to persist. Extracted so
 * it's testable without live tmux + a state file.
 *
 * Each window is attributed to the session it's running (a resumed window by its
 * canonical name, an id-less fresh-launch window by the most-recently-used
 * session in its pane's cwd), and we persist the *canonical* resume name
 * (`cl-<source>-<id>`), never the original window name — a fresh-launch name
 * (`cl-wi-…`/`cl-pr-…`/`cl-free-…`) would otherwise let the restored placeholder
 * collide with a later `freshName(id)`. A window with no resumable session yet on
 * disk is skipped — there's nothing to `--resume`.
 *
 * Distinct windows can attribute to the same session — e.g. two id-less windows
 * sharing one cwd both resolve to that cwd's MRU session — so we dedup by the
 * canonical name (keep the first), or restore would create duplicate placeholder
 * windows (tmux allows duplicate names) both resuming the one session while
 * dropping the others.
 *
 * `existing` (the current on-disk snapshot) lets us PRESERVE a tab for a live
 * id-bearing window we can't attribute yet: a background session just started by
 * `agendo launch` (recordLaunchedSession wrote its tab) may not have flushed its
 * on-disk log when the menu's next reload runs, so `resolveWindowSession` finds
 * nothing. Rather than drop it, we keep the saved tab matched by the short id in
 * the window name — so a freshly-spawned session survives until its log appears.
 */
export function buildTabs(
  windows: { name: string; cwd: string }[],
  sessions: AgentSession[],
  existing: RestoreTab[] = [],
): RestoreTab[] {
  // Saved tabs keyed by the short id embedded in their canonical name.
  const savedByShortId = new Map<string, RestoreTab>();
  for (const t of existing) {
    const m = t.name.match(ID_BEARING);
    if (m) savedByShortId.set(m[1], t);
  }
  const byName = new Map<string, RestoreTab>();
  for (const { name, cwd } of windows) {
    if (!name.startsWith("cl-")) continue;
    const best = resolveWindowSession(sessions, name, cwd);
    if (best) {
      const canonical = sessionName(best);
      if (!byName.has(canonical)) {
        byName.set(canonical, { name: canonical, cwd, title: best.title.replace(/\s+/g, " ").trim(), argv: resumeArgv(best) });
      }
      continue;
    }
    // No on-disk session yet — preserve a previously-saved tab for this window's
    // session id (id-bearing names only; cl-wi-/cl-pr- carry no recoverable id).
    const m = name.match(ID_BEARING);
    const prior = m ? savedByShortId.get(m[1]) : undefined;
    if (prior && !byName.has(prior.name)) byName.set(prior.name, prior);
  }
  return [...byName.values()];
}

/**
 * Record a just-launched managed session into the restore snapshot immediately.
 *
 * The `agendo launch` CLI runs as its own process and never goes through the
 * menu's `loadModel`, so `captureRestore` wouldn't see a background session until
 * the menu's next full reload — and a brand-new session has no on-disk log yet to
 * attribute by, only the short id in its `cl-bg-…` window name. We hold the full
 * id here, so we persist a canonical resume tab directly; `buildTabs` then keeps
 * it across reloads (via the same short id) until its log appears.
 *
 * No-op unless the launched window actually landed in the canonical session — an
 * outside-tmux launch is its own detached session, not a tab the launcher restores.
 */
export function recordLaunchedSession(
  info: { id: string; cwd: string; title?: string; configDir?: string; source?: AgentSession["source"] },
  tmuxName: string,
): void {
  if (!launcherWindowPaths().some((w) => w.name === tmuxName)) return;
  const s: AgentSession = {
    id: info.id,
    source: info.source ?? "claude",
    cwd: info.cwd,
    title: info.title ?? "",
    lastUsed: new Date(),
    configDir: info.configDir,
  };
  const canonical = sessionName(s);
  const tab: RestoreTab = {
    name: canonical,
    cwd: info.cwd,
    title: (info.title ?? "").replace(/\s+/g, " ").trim() || canonical,
    argv: resumeArgv(s),
  };
  // Dedup by canonical name: drop any prior tab for this session, then append.
  const tabs = loadRestore().filter((t) => t.name !== canonical);
  tabs.push(tab);
  saveRestore(tabs);
}

/** POSIX single-quote a string so it survives a `bash -c` script verbatim. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * argv for a lazy placeholder window: it prints the session title and waits for
 * a keypress, then `exec`s the resume command in place (so the pane becomes the
 * real agent — and, like any agent window, closes when the agent exits). The
 * pane is a tty, so `read` blocks on real input.
 */
function placeholderArgv(tab: RestoreTab): string[] {
  const cmd = tab.argv.map(shq).join(" ");
  const head = shq(`⏸  ${tab.title}`);
  const hint = shq("Press any key to resume this session…");
  // Once a key is pressed we're resuming for real, so clear the placeholder
  // marker on this window (current window from inside the pane) *before* exec so
  // the live set counts it as running again. See markPlaceholder / refreshLiveTmux.
  const unmark = `tmux set-option -uw ${PLACEHOLDER_OPTION} 2>/dev/null`;
  const script = `clear; printf '%s\\n\\n' ${head}; printf '%s\\n' ${hint}; read -rsn1 _; ${unmark}; clear; exec ${cmd}`;
  return ["bash", "-c", script];
}

/**
 * Recreate the saved agent tabs as lazy placeholder windows in the canonical
 * session — each a real tmux tab that stays unloaded until you open it. Called
 * once, right after the canonical session is freshly created (an existing
 * session already has its live windows, so there's nothing to restore).
 */
export function restoreTabs(): void {
  for (const tab of loadRestore()) {
    // The saved cwd may have been deleted or moved since the snapshot (e.g. a
    // pruned worktree). `tmux new-window -c <gone>` either silently falls back to
    // a different start-directory (resuming in the wrong place) or fails outright
    // with the error swallowed by tmuxQuiet — either way the tab misbehaves with
    // no diagnostic. Skip it and say so. (Runs from the `--tmux` bootstrap in
    // index.tsx, which exits before Ink renders, so stderr is safe here.)
    if (!existsSync(tab.cwd)) {
      console.error(`restore: skipping ${tab.name} — working dir gone: ${tab.cwd}`);
      continue;
    }
    newWindowIn(LAUNCHER_SESSION, tab.name, tab.cwd, placeholderArgv(tab));
    // Mark it as an unloaded placeholder so isRunning doesn't report the idle
    // bash window as a running session (the placeholder script clears this on resume).
    markPlaceholder(`${LAUNCHER_SESSION}:${tab.name}`);
  }
}
