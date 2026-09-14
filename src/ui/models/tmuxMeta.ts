// The tmux identity shown on an expanded session row: which host session,
// window and window name it actually runs as, when known. Split out of rows.ts
// so `sessionMeta` stays a couple of lines and this stays independently
// testable — it's pure, and takes exactly what it needs rather than a whole
// LoadedModel.
import { isPaneTarget, type LiveTarget } from "../../runtime/tmux/index.ts";
import type { LoadedModel } from "../../app/model/index.ts";

/** The slice of live-tmux state `sessionMeta` needs, precomputed once per row
 *  build rather than re-derived per row (see rows.ts's PERFORMANCE note). */
export interface LiveInfo {
  names: Set<string>;
  /** Running windows and paused restore placeholders, merged — the tmux line
   *  shows either, since both are a real tmux window (see reconcileLive). */
  windows: Map<string, LiveTarget>;
  /** Every `session:window_index` a running session's window name was found
   *  at; more than one entry is the duplicate-window-name ambiguity. */
  locations: Map<string, string[]>;
}

export function liveInfoOf(model: LoadedModel): LiveInfo {
  const windows = new Map(model.liveWindows);
  for (const [canon, target] of model.placeholderWindows) if (!windows.has(canon)) windows.set(canon, target);
  return { names: model.liveTmux, windows, locations: model.liveWindowLocations };
}

/**
 * The tmux SESSION NAME, WINDOW NUMBER and WINDOW NAME of a session's live
 * window, as one line — or null when it has none (not running, no placeholder).
 *
 * A pane-hosted session (the global orchestrator, parked beside the menu) has
 * no window of its own: its "window number" would name the host window it
 * shares with something else, so that's dropped rather than shown as this
 * session's. A window name found in more than one host session (this launcher
 * creates that by design — see `windowLocations`) lists every location instead
 * of silently picking one.
 */
export function tmuxLine(live: LiveInfo, canon: string): string | null {
  const target = live.windows.get(canon);
  if (!target) return null;
  if (isPaneTarget(target.target)) {
    return target.session ? `${target.session}  ·  pane (no window of its own)` : "pane (no window of its own)";
  }
  const locs = live.locations.get(canon);
  const here = locs && locs.length > 0 ? locs : [`${target.session ?? "?"}:${target.windowIndex ?? "?"}`];
  return `${here.join(", ")}  "${target.name}"`;
}
