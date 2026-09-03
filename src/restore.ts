// Browser-style tab restore for the canonical launcher session.
//
// We persist which agent tabs (windows) are open in the canonical
// `agendo` tmux session, and on a fresh startup recreate them as *lazy*
// placeholder windows: each tab is present in the tab strip but unloaded — it
// only runs its resume command (`claude --resume <id>` / `copilot --resume=<id>`
// / `codex resume <id>`) when you switch to it and press a key. Same
// idea as a web browser restoring your tabs without loading every page upfront,
// so startup stays cheap (no fleet of resumed agents) until you actually open a
// tab.
//
// A tab also goes BACK to that paused state when the agent exits, and only q/Esc
// closes it (see `placeholderArgv`) — so a tab behaves like a browser tab you can
// reload, and disposing of one is always deliberate.
//
// A snapshot is self-contained: each open `cl-*` window is attributed to the
// session it runs — a resumed window by its canonical name, an id-less
// fresh-launch window by the most-recently-used session in its pane's cwd — and
// we persist *that* session's resume command + title. So restore needs nothing
// but this file.
import { ID_BEARING_NAME, LAUNCHER_SESSION, launcherWindowPaths, sessionName, shortId } from "./tmux.ts";
import { normalizeCwd } from "./context.ts";
import { resumeArgv } from "./launch.ts";
import type { SessionIndex } from "./sessions.ts";
import type { AgentSession } from "./types.ts";
import { loadRestore, saveRestore, type RestoreTab } from "./restore/store.ts";
import { refreshPlaceholder } from "./restore/placeholder.ts";

// Two pieces live in src/restore/: store.ts (where a snapshot lives on disk and
// the legacy locations still read from) and placeholder.ts (the paused tab and
// the tmux window behind it). What is left here is the snapshot itself — which
// live windows become which tabs, and which session each one is attributed to.
//
// This file stays the one import path, so the re-exports below keep the surface
// it had before.
export { loadRestore, type RestoreTab } from "./restore/store.ts";
export { placeholderArgv, restoreTabs } from "./restore/placeholder.ts";


/**
 * The most-recently-used on-disk session whose cwd matches `cwd`, or undefined.
 * Used to attribute an id-less managed target (`cl-wi-…`, `cl-pr-…`, `cl-free-…`)
 * — named after a work item / PR / slug rather than a session id — back to the
 * session most likely running in it. Exported as the single source of truth for
 * this cwd+lastUsed pick (refreshLiveTmux in model.ts shares the same heuristic).
 *
 * Matches on the NORMALIZED cwd (see `normalizeCwd`) so a path-representation
 * difference between tmux's report and the session's recorded cwd can't drop an
 * actually-running session to "not running".
 */
export function bestSessionForCwd(sessions: AgentSession[], cwd: string): AgentSession | undefined {
  const want = normalizeCwd(cwd);
  let best: AgentSession | undefined;
  for (const s of sessions) {
    if (normalizeCwd(s.cwd) === want && (!best || s.lastUsed.getTime() > best.lastUsed.getTime())) best = s;
  }
  return best;
}

/**
 * Managed names that embed a session short id (vs. a work-item / PR id, or an
 * agent that can't be told its id up front). Single source of truth in tmux.ts,
 * alongside the `kindName` that mints these names.
 */
const ID_BEARING = ID_BEARING_NAME;

/**
 * Whether a managed window name embeds a SESSION short id (`cl-claude-…`,
 * `cl-copilot-…`, `cl-bg-…`, `cl-new-…`) rather than a work-item / PR id. Only
 * an id-bearing name identifies its session unambiguously; the rest are
 * attributed by working directory (see `resolveWindowSession`), a heuristic that
 * is fine for reading a pane but not for killing one — hence `agendo close`
 * checks this before it kills an id-less window.
 */
export function idBearingName(name: string): boolean {
  return ID_BEARING.test(name);
}

/**
 * Resolve which on-disk session a live launcher window is running.
 *
 * Id-bearing names (`cl-claude-`/`cl-copilot-`/`cl-codex-`/`cl-bg-`/`cl-new-`)
 * embed the session's short id, so we match that exact session — unambiguous,
 * and right even when two sessions share a cwd. The id-less names (`cl-wi-…`,
 * `cl-pr-…`, `cl-free-…`, and the `cl-bg-codex-…` fresh launches of an agent
 * that assigns its own id) carry no session id, so for those we fall back to the
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
export function captureRestore(index: SessionIndex, hostSession: string = LAUNCHER_SESSION): void {
  const windows = launcherWindowPaths(hostSession);
  // A live tmux session always has ≥1 window, so an empty list means the host
  // session isn't running — skip so a standalone menu never clobbers a saved
  // snapshot. (Also avoids a separate `tmux has-session` spawn per load.)
  if (windows.length === 0) return;
  // Pass the current snapshot so buildTabs can preserve a just-recorded session
  // whose on-disk log doesn't exist yet (see recordLaunchedSession).
  saveRestore(hostSession, buildTabs(windows, index.all, loadRestore(hostSession)));
}

/**
 * Tab-building core of `captureRestore`: map the live `cl-*` launcher windows to
 * the deduped, self-contained `RestoreTab[]` to persist. Extracted so it's
 * testable without live tmux. Note it is not side-effect-free: the `resumeArgv`
 * it calls per window reads the orchestrator marker file (see src/orchestrator.ts)
 * to decide whether that session's resume re-injects the orchestrator prompt.
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

/** The launched session's own record and the resume tab that stands in for it. */
export function launchedTab(info: LaunchedInfo): RestoreTab {
  const s: AgentSession = {
    id: info.id,
    source: info.source ?? "claude",
    cwd: info.cwd,
    title: info.title ?? "",
    lastUsed: new Date(),
    configDir: info.configDir,
  };
  const canonical = sessionName(s);
  return {
    name: canonical,
    cwd: info.cwd,
    title: (info.title ?? "").replace(/\s+/g, " ").trim() || canonical,
    argv: resumeArgv(s),
  };
}

export interface LaunchedInfo {
  id: string;
  cwd: string;
  title?: string;
  configDir?: string;
  source?: AgentSession["source"];
}

/** The launcher session's windows and its restore file, as this needs them. */
export interface RestoreHost {
  windowNames: (hostSession: string) => string[];
  load: (hostSession: string) => RestoreTab[];
  save: (hostSession: string, tabs: RestoreTab[]) => void;
}

const REAL_HOST: RestoreHost = {
  windowNames: (host) => launcherWindowPaths(host).map((w) => w.name),
  load: loadRestore,
  save: saveRestore,
};

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
  info: LaunchedInfo,
  tmuxName: string,
  hostSession: string = LAUNCHER_SESSION,
  host: RestoreHost = REAL_HOST,
): void {
  if (!host.windowNames(hostSession).includes(tmuxName)) return;
  const tab = launchedTab(info);
  // Dedup by canonical name: drop any prior tab for this session, then append.
  const tabs = host.load(hostSession).filter((t) => t.name !== tab.name);
  tabs.push(tab);
  host.save(hostSession, tabs);
}

/**
 * Drop a session's tab from one host session's restore snapshot, so a session
 * the user explicitly closed (`agendo close`) doesn't reappear as a placeholder
 * the next time that launcher starts from scratch. Best-effort and narrowly
 * scoped: only this session's tab is removed, and only from the host session
 * that actually held the window (the caller resolves it from tmux), so a
 * parallel path-scoped launcher's tabs are never touched.
 *
 * `target` is the window the session was closed through, which is NOT always the
 * name its tab was saved under: a tab is always persisted canonically
 * (`cl-<source>-<id>`, see RestoreTab.name) while a background session lives in
 * the launch namespace (`cl-bg-<id>`). Same session, different prefix — so an
 * id-bearing name is matched on the SHORT ID it embeds rather than the literal
 * string, and anything else (a `cl-wi-…`/`cl-pr-…` window) falls back to an
 * exact-name match.
 *
 * Nothing is deleted beyond that one snapshot entry — the session's transcript,
 * worktree and branch are untouched, and `agendo resume <id>` still brings it
 * back. No-op when the session has no saved tab.
 */
export function forgetRestoreTab(target: string, hostSession: string): void {
  const sid = target.match(ID_BEARING)?.[1];
  const tabs = loadRestore(hostSession);
  const kept = tabs.filter((t) => t.name !== target && !(sid !== undefined && t.name.match(ID_BEARING)?.[1] === sid));
  if (kept.length !== tabs.length) saveRestore(hostSession, kept);
}

/**
 * Repoint a persisted restore tab at a session's NEW config dir, after the
 * session was moved between Claude profiles (see profiles.ts).
 *
 * A saved tab's argv bakes `CLAUDE_CONFIG_DIR=<old>` in (see `resumeArgv`), so an
 * untouched snapshot would lazily resume the tab against a profile the session
 * no longer lives in — `claude --resume` would simply report an unknown session,
 * with nothing on screen explaining why. `captureRestore` does rebuild every tab
 * from the freshly-indexed sessions on the next model load, but only when the
 * host session is live; rewriting here means a move is durable even if the
 * launcher is killed before that.
 *
 * The argv is rebuilt through `resumeArgv` rather than string-patched, so it
 * can't drift from what a normal resume would run. No-op when the snapshot has
 * no tab for this session, or when the rebuilt argv is identical.
 *
 * A tab that is ALREADY on screen as a live placeholder window is rebuilt too —
 * see `refreshPlaceholder`. Rewriting only the file would leave the visible tab
 * holding the old command in its pane's bash script; pressing a key in it would
 * run a resume against the profile the session just left and fail with
 * "no conversation found", with nothing on screen explaining why. A placeholder
 * isn't counted as running (`livePlaceholders` is deliberately separate from
 * `liveTmux`), so the move was rightly allowed — this is what keeps the tab honest.
 */
export function retargetRestoreProfile(
  s: Pick<AgentSession, "id" | "source" | "cwd">,
  configDir: string,
  hostSession: string = LAUNCHER_SESSION,
): { tabUpdated: boolean; placeholderRefreshed: boolean } {
  const canonical = sessionName(s);
  const tabs = loadRestore(hostSession);
  let updated: RestoreTab | null = null;
  const next = tabs.map((t) => {
    if (t.name !== canonical) return t;
    const argv = resumeArgv({ id: s.id, source: s.source, cwd: t.cwd, title: t.title, lastUsed: new Date(), configDir });
    if (JSON.stringify(argv) === JSON.stringify(t.argv)) return t;
    updated = { ...t, argv };
    return updated;
  });
  if (!updated) return { tabUpdated: false, placeholderRefreshed: false };
  saveRestore(hostSession, next);
  return { tabUpdated: true, placeholderRefreshed: refreshPlaceholder(hostSession, updated) };
}

