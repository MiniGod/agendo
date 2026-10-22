// Where focus finds a session on screen: its candidates' live state, and the
// window a running one lands on — both read from the pane listing the choice
// was made from (see windowName.ts). The landing is pinned by name, so a window
// that took the name since that listing is landed on as before.
import {
  liveTargetForShortId, sessionName, shortId, windowIdentity, type LivePane,
} from "../../runtime/tmux/index.ts";
import { refreshLiveTmux } from "../../app/model/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import { sessionState } from "../list/rows.ts";
import type { FocusCandidate } from "./choose.ts";

/** The candidates with their live state, as `list` would report it, and where a paused one's tab sits. */
export function withStates(sessions: AgentSession[], all: AgentSession[], panes?: LivePane[]): FocusCandidate[] {
  const { live, livePlaceholders, placeholderWindows } = refreshLiveTmux(all, panes);
  return sessions.map((s) => {
    const canon = sessionName(s);
    return { s, state: sessionState(live.has(canon), canon, livePlaceholders), host: placeholderWindows.get(canon)?.session };
  });
}

/** The tmux target of a running session's window — freshly read, unless the pane listing it was found in is given. */
export function runningTarget(s: AgentSession, all: AgentSession[], panes?: LivePane[]): string | null {
  return refreshLiveTmux(all, panes).liveWindows.get(sessionName(s))?.target ?? liveTargetForShortId(shortId(s.id))?.target ?? null;
}

/** Where the chosen session will be on screen, worked out before anything is resumed. */
export interface Landing {
  /** A running session's window, still there; null when it has to be resumed. */
  running: string | null;
  /** The tmux session that window is in — or a resume will open it in; undefined for a detached session of its own. */
  session: string | undefined;
}

/**
 * A running session's window as a landing: the one `panes` attributes it to —
 * the listing it was chosen from, so the landing cannot move to another window
 * of the session (see windowName.ts) — while tmux still resolves its target.
 * Null otherwise, and the session is resumed instead (see `bringUp`).
 */
export function runningLanding(s: AgentSession, all: AgentSession[], panes: LivePane[]): Landing | null {
  const running = runningTarget(s, all, panes);
  const where = running ? windowIdentity(running) : null;
  return running && where ? { running, session: where.session } : null;
}
