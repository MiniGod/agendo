// Which sessions are live right now, read from tmux, and the reconciliation of
// that reading back onto an already-loaded model.
//
// Every function here is about the CHEAP half of a refresh: one list-sessions /
// list-windows / list-panes read, no backend fetch and no transcript parse.
import {
  liveManagedPaths, liveTargets, managedKind, sessionName,
  type LiveTarget, type ManagedTarget, type SessionKind,
} from "../../runtime/tmux/index.ts";
import { resolveWindowSession } from "../../runtime/restore/index.ts";
import type { AgentSession } from "../../shared/types.ts";

export function isRunning(s: AgentSession, live: Set<string>): boolean {
  return live.has(sessionName(s));
}

/**
 * Recompute live tmux state without any backend/network work (just the tmux CLI
 * reads via liveTargets + liveManagedPaths), so it's cheap enough to poll.
 * Returns the set of live session names plus, for each running session, how it
 * was launched (`liveKinds`, for the UI badge) and which window it occupies
 * (`liveWindows`, for pane reads).
 *
 * Attributes every live managed (`cl-…`) window to the session running in it and
 * registers that session's canonical name as live, across every prefix — old
 * (`cl-wi-`, `cl-pr-`, `cl-free-`) and new (`cl-bg-`, `cl-new-`). A window
 * carrying a `@cl_session_id` tag names its session outright and is matched on
 * that; otherwise id-bearing names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/
 * `cl-new-`) embed the session's short id, so we match that exact session, and
 * work-item / PR names (`cl-wi-…`/`cl-pr-…`) embed an item id instead, so we
 * attribute them to the most-recently-used session in the same working
 * directory. See `resolveWindowSession` for the full precedence. `allSessions` is the full local session
 * collection (loadModel passes index.all; the App poll passes the same set).
 */
export function refreshLiveTmux(allSessions: AgentSession[]): {
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  livePlaceholders: Set<string>;
  placeholderWindows: Map<string, LiveTarget>;
  liveWindowLocations: Map<string, string[]>;
} {
  // `base` is membership only — the names tmux currently lists. The addressable
  // targets ride along on `liveManagedPaths`, which is where reconciliation picks
  // the window it attributes a session to.
  return reconcileLive(new Set(liveTargets().keys()), liveManagedPaths(), allSessions);
}

/**
 * Pure reconciliation core of `refreshLiveTmux`, extracted so it's testable
 * without live tmux. Folds the managed (`cl-…`) targets into `base` (the raw
 * live session/window names) and returns the running set plus, per running
 * session, how it was launched (`liveKinds`, for the UI badge) and which window
 * it occupies (`liveWindows`, for pane reads).
 *
 * A window's own `@cl_session_id` tag wins where it has one. Failing that,
 * id-bearing names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/`cl-new-`) embed the
 * session's short id, so we match that exact session; work-item / PR / legacy
 * names (`cl-wi-…`/`cl-pr-…`/`cl-free-…`) embed an item id instead, so we
 * attribute them to the most-recently-used session in the same working dir.
 *
 * A restored-but-unopened placeholder window also carries the canonical
 * `cl-<source>-<id>` name, so `base` already counted it as running; it's just an
 * idle bash waiting for a keypress, so it must be dropped (its script clears the
 * marker on resume, restoring running status). But a placeholder and a *real*
 * window can carry the same canonical name — e.g. a placeholder `cl-claude-X`
 * alongside a real `cl-wi-…` whose cwd attributes back to session X. So we run
 * two order-independent passes rather than add/delete inline (which would let
 * tmux's pane iteration order decide the winner): pass 1 attributes every real
 * window (recording its kind/window keyed by canonical name); pass 2 drops only
 * the placeholders no real window vouched for (`liveKinds.has(name)`).
 *
 * Also returns, for the UI's tmux-identity display rather than for attribution:
 * `placeholderWindows` — the `LiveTarget` of a pure placeholder (one no real
 * window vouched for), so a paused session can still show where its window
 * lives; and `liveWindowLocations` — every `session:window_index` a RUNNING
 * session's window name was found at, so a name live in more than one host
 * session (the same duplicate `windowLocations` in windows.ts exists to guard
 * against) shows up as more than one entry instead of silently picking one.
 */
export function reconcileLive(
  base: Set<string>,
  managed: ManagedTarget[],
  sessions: AgentSession[],
): {
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  livePlaceholders: Set<string>;
  placeholderWindows: Map<string, LiveTarget>;
  liveWindowLocations: Map<string, string[]>;
} {
  const live = base;
  const liveKinds = new Map<string, SessionKind>();
  const liveWindows = new Map<string, LiveTarget>();
  const liveWindowLocations = new Map<string, string[]>();
  const placeholders = new Set<string>();
  const placeholderTargets = new Map<string, LiveTarget>();
  for (const { name, target, cwd, placeholder, session, windowIndex, tags } of managed) {
    const kind = managedKind(name);
    if (!kind) continue;
    // An idle placeholder must not vouch for "running": record its window name
    // (and its LiveTarget, for a possible pure-placeholder display) and skip
    // it; pass 2 drops it unless a real window vouches for that name.
    if (placeholder) {
      placeholders.add(name);
      placeholderTargets.set(name, { name, target, session, windowIndex });
      continue;
    }
    // Shared with restore.ts so the two attribution paths can't drift: the
    // window's own tag first, then an id-bearing name by short id, then
    // work-item / PR names by cwd+lastUsed.
    const best = resolveWindowSession(sessions, name, cwd, tags);
    if (!best) continue;
    const canon = sessionName(best);
    live.add(canon);
    liveKinds.set(canon, kind);
    liveWindows.set(canon, { name, target, session, windowIndex });
    // Pane-hosted entries carry no windowIndex (see liveManagedPaths) and are
    // never a "duplicate window name" the way two real windows can be. A pane
    // whose window AND session name both happen to equal the managed name (an
    // agent running as its own tmux session, whose window inherited the same
    // name) contributes this same location TWICE — once as the session, once
    // as the window — so de-dupe by exact match rather than report a session
    // as living in two places when it's really the one window addressed two
    // ways.
    if (windowIndex != null && session) {
      const loc = `${session}:${windowIndex}`;
      const locs = liveWindowLocations.get(canon) ?? [];
      if (!locs.includes(loc)) locs.push(loc);
      liveWindowLocations.set(canon, locs);
    }
  }
  // A placeholder's window name IS its canonical name, so a real window vouching
  // for the same session shows up as a `liveKinds` entry under that name. Any
  // placeholder no real window vouched for is a dormant restored tab: drop it
  // from `live` (it's not running) but record it in `livePlaceholders` so the UI
  // can badge the session as restored-but-unopened, and in `placeholderWindows`
  // so it can still show a tmux identity line.
  const livePlaceholders = new Set<string>();
  const placeholderWindows = new Map<string, LiveTarget>();
  for (const p of placeholders) {
    if (!liveKinds.has(p)) {
      live.delete(p);
      livePlaceholders.add(p);
      const t = placeholderTargets.get(p);
      if (t) placeholderWindows.set(p, t);
    }
  }
  return { live, liveKinds, liveWindows, livePlaceholders, placeholderWindows, liveWindowLocations };
}
