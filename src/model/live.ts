// Which sessions are live right now, read from tmux, and the reconciliation of
// that reading back onto an already-loaded model.
//
// Every function here is about the CHEAP half of a refresh: one list-sessions /
// list-windows / list-panes read, no backend fetch and no transcript parse.
import {
  liveManagedPaths, liveTargets, managedKind, sessionName,
  type LiveTarget, type ManagedTarget, type SessionKind,
} from "../tmux.ts";
import { resolveWindowSession } from "../restore.ts";
import type { AgentSession } from "../types.ts";

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
 * (`cl-wi-`, `cl-pr-`, `cl-free-`) and new (`cl-bg-`, `cl-new-`). Id-bearing
 * names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/`cl-new-`) embed the session's short
 * id, so we match that exact session; work-item / PR names (`cl-wi-…`/`cl-pr-…`)
 * embed an item id instead, so we attribute them to the most-recently-used
 * session in the same working directory. `allSessions` is the full local session
 * collection (loadModel passes index.all; the App poll passes the same set).
 */
export function refreshLiveTmux(allSessions: AgentSession[]): {
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  livePlaceholders: Set<string>;
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
 * Id-bearing names (`cl-claude-`/`cl-copilot-`/`cl-bg-`/`cl-new-`) embed the
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
 */
export function reconcileLive(
  base: Set<string>,
  managed: ManagedTarget[],
  sessions: AgentSession[],
): { live: Set<string>; liveKinds: Map<string, SessionKind>; liveWindows: Map<string, LiveTarget>; livePlaceholders: Set<string> } {
  const live = base;
  const liveKinds = new Map<string, SessionKind>();
  const liveWindows = new Map<string, LiveTarget>();
  const placeholders = new Set<string>();
  for (const { name, target, cwd, placeholder } of managed) {
    const kind = managedKind(name);
    if (!kind) continue;
    // An idle placeholder must not vouch for "running": record its window name
    // and skip it; pass 2 drops it unless a real window vouches for that name.
    if (placeholder) {
      placeholders.add(name);
      continue;
    }
    // Shared with restore.ts so the two attribution paths can't drift: id-bearing
    // names match by short id, work-item / PR names by cwd+lastUsed.
    const best = resolveWindowSession(sessions, name, cwd);
    if (!best) continue;
    const canon = sessionName(best);
    live.add(canon);
    liveKinds.set(canon, kind);
    liveWindows.set(canon, { name, target });
  }
  // A placeholder's window name IS its canonical name, so a real window vouching
  // for the same session shows up as a `liveKinds` entry under that name. Any
  // placeholder no real window vouched for is a dormant restored tab: drop it
  // from `live` (it's not running) but record it in `livePlaceholders` so the UI
  // can badge the session as restored-but-unopened.
  const livePlaceholders = new Set<string>();
  for (const p of placeholders) {
    if (!liveKinds.has(p)) {
      live.delete(p);
      livePlaceholders.add(p);
    }
  }
  return { live, liveKinds, liveWindows, livePlaceholders };
}
