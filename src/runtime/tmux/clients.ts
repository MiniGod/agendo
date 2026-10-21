// The attached tmux CLIENTS — the terminals a human is looking at — and moving
// one of them onto a window. Used by `agendo focus`, which runs OUTSIDE tmux
// (launched by a browser through the agendo:// URL handler), so there is no
// "current client" to act on and the one to move has to be picked deliberately.
//
// Reads and the one write live together because they only make sense as a
// pair: the client a focus picks is the client it then switches.
import { spawnSync } from "child_process";
import { tmuxLines } from "./exec.ts";

/** One attached client, as `list-clients` reports it. */
export interface TmuxClient {
  /** `#{client_name}` — what `switch-client -c` takes (usually the client's tty). */
  name: string;
  /** `#{client_pid}` — the tmux client process, whose ancestor is the terminal emulator. */
  pid: number;
  /** `#{client_activity}` — epoch seconds of the client's last input. */
  activity: number;
  /** `#{client_session}` — the session the client is showing right now. */
  session: string;
}

const CLIENT_FORMAT = "#{client_activity}\t#{client_name}\t#{client_pid}\t#{client_session}\t#{client_control_mode}";

/**
 * Parse `list-clients -F CLIENT_FORMAT` output. A malformed line is dropped
 * rather than guessed at, and so is a control-mode client (`tmux -CC`): it has no
 * terminal of its own to bring forward, and switching it would move an
 * integration's view instead of the human's.
 */
export function parseClients(lines: string[]): TmuxClient[] {
  return lines.map(parseClientLine).filter((c): c is TmuxClient => c !== null);
}

/** One `CLIENT_FORMAT` line: activity, name, pid, session, and a control-mode flag that must be 0. */
const CLIENT_LINE = /^(\d+)\t([^\t]+)\t(\d+)\t([^\t]*)\t0?$/;

function parseClientLine(line: string): TmuxClient | null {
  const m = CLIENT_LINE.exec(line);
  return m ? { name: m[2], pid: Number(m[3]), activity: Number(m[1]), session: m[4] } : null;
}

/**
 * The most recently active client: the one with the most recent input, i.e. the
 * terminal the human last typed into. Ties keep tmux's own listing order. Null
 * when nothing is attached.
 */
export function pickClient(clients: TmuxClient[]): TmuxClient | null {
  let best: TmuxClient | null = null;
  for (const c of clients) if (!best || c.activity > best.activity) best = c;
  return best;
}

/**
 * The client to move onto a window of tmux session `session`: the most recently
 * active of the clients already showing that session, else — none on it, or no
 * session known — the most recently active client overall. The terminal the
 * human last typed into is usually the one they are BUSY in; a terminal already
 * showing the target's session is the one meant to show it.
 */
export function pickClientFor(clients: TmuxClient[], session: string | undefined): TmuxClient | null {
  return pickClient(clients.filter((c) => c.session === session)) ?? pickClient(clients);
}

/** Every attached client on the server (empty when none, or no server). */
export function listClients(): TmuxClient[] {
  return parseClients(tmuxLines(["list-clients", "-F", CLIENT_FORMAT]));
}

/** Where a target lives, in the stable ids tmux hands out. */
export interface WindowIdentity {
  /** `@N` — the window id; stable for the window's lifetime, unlike its name or index. */
  windowId: string;
  /** The session that holds the window. */
  session: string;
}

/**
 * Resolve any target agendo addresses a session by — `=host:=window`, `=session`
 * or a pane id `%N` — to its window id and host session. Null when tmux cannot
 * resolve it, or answers with something that is not a window id: the id is
 * handed straight back to tmux as a target, so only the `@N` shape is accepted.
 *
 * `display-message -t` takes a target-PANE, and a bare `=session` is not one
 * (see `sessionOptionTarget` in server.ts); `=session:` — that session's current
 * pane, still exact-matched — is, so a session-only target gains the colon.
 */
export function windowIdentity(target: string): WindowIdentity | null {
  const r = spawnSync("tmux", ["display-message", "-p", "-t", asPaneTarget(target), "#{window_id}\t#{session_name}"], {
    encoding: "utf-8",
  });
  return r.status === 0 ? parseWindowIdentity(r.stdout ?? "") : null;
}

/** `=session` → `=session:`; any other target is already a pane target. */
export function asPaneTarget(target: string): string {
  return target.startsWith("=") && !target.includes(":") ? `${target}:` : target;
}

/** `@N\t<session>` → the identity, or null for anything else. */
export function parseWindowIdentity(stdout: string): WindowIdentity | null {
  const m = /^(@\d+)\t(.+)$/.exec(stdout.trim());
  return m ? { windowId: m[1], session: m[2] } : null;
}

/**
 * The window as a target scoped to the session it was found in: `=session:@N`.
 * A bare `@N` lets tmux pick "the best session with that window", which for a
 * window linked into two sessions need not be the one `windowIdentity` named.
 */
export function scopedWindowTarget(where: WindowIdentity): string {
  return `=${where.session}:${where.windowId}`;
}

/**
 * Make the window the current one of its session, and focus `paneId` inside it
 * when the session is parked in a pane. Enough on its own for a terminal about
 * to attach to that session; `focusClientOn` adds the switch.
 */
export function selectWindow(where: WindowIdentity, paneId?: string): void {
  spawnSync("tmux", ["select-window", "-t", scopedWindowTarget(where)], { stdio: "ignore" });
  if (paneId) spawnSync("tmux", ["select-pane", "-t", paneId], { stdio: "ignore" });
}

/**
 * Show the window on `client`: select it (see `selectWindow`), then switch the
 * client there. Returns whether the switch itself succeeded — the select steps
 * are a nicety, the switch is the whole point.
 */
export function focusClientOn(client: string, where: WindowIdentity, paneId?: string): boolean {
  selectWindow(where, paneId);
  return spawnSync("tmux", ["switch-client", "-c", client, "-t", scopedWindowTarget(where)], { stdio: "ignore" }).status === 0;
}
