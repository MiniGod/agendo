// Bringing the terminal that shows a tmux client to the front — on X11, and on
// sway through its IPC — and only ever as a nicety.
//
// Switching the client is the actual focus; this step just saves the human from
// alt-tabbing to the terminal it happened in. So every failure here is silent:
// Wayland other than sway (where one client may not raise another's window), no
// DISPLAY, wmctrl and xdotool both missing, a terminal that is not an ancestor of
// the client (attached over ssh, say). None of them may fail the command.
//
// The route: the tmux client's pid → its ancestors (the shell, then the terminal
// emulator) → the first one that owns an X window → activate that window.
//
// Activating is where window managers differ. wmctrl and xdotool both send
// _NET_ACTIVE_WINDOW, which i3 (focus_on_window_activation=smart, its default)
// honours only for a window on a VISIBLE workspace — one on another workspace is
// marked urgent and left there. So when i3's IPC answers, the window is focused
// through it first (`[id=<X window id>] focus` switches workspace too), and the
// EWMH request is the fallback. Sway is Wayland, so there is no X window to
// find: its tree is asked which container belongs to an ancestor pid instead.
import { readFileSync } from "fs";
import { spawnSync } from "child_process";

/** How far up the process tree to look for the terminal: client → shell → terminal, with room to spare. */
const MAX_ANCESTORS = 8;

/** The parent pid out of a `/proc/<pid>/stat` line, or null. `comm` may hold spaces and parens, so read after the LAST `)`. */
export function parsePpid(stat: string): number | null {
  const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const ppid = Number(after[1]);
  return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
}

/** `pid` and its ancestors, nearest first, stopping before init. `readStat` is injected for tests. */
export function ancestry(pid: number, readStat: (pid: number) => string | null): number[] {
  const out: number[] = [];
  let cur: number | null = pid;
  while (cur !== null && cur > 1 && out.length < MAX_ANCESTORS && !out.includes(cur)) {
    out.push(cur);
    const stat = readStat(cur);
    cur = stat === null ? null : parsePpid(stat);
  }
  return out;
}

/** `wmctrl -lp` output → pid → its first window id. Lines are `<wid> <desktop> <pid> <host> <title…>`. */
export function parseWmctrl(text: string): Map<number, string> {
  const out = new Map<number, string>();
  for (const line of text.split("\n")) {
    const [wid, , pid] = line.trim().split(/\s+/);
    if (!/^0x[0-9a-f]+$/i.test(wid ?? "") || !/^\d+$/.test(pid ?? "")) continue;
    if (!out.has(Number(pid))) out.set(Number(pid), wid);
  }
  return out;
}

/** The window of the nearest ancestor that owns one. */
export function nearestWindow(chain: number[], windows: (pid: number) => string | undefined): string | null {
  for (const pid of chain) {
    const wid = windows(pid);
    if (wid) return wid;
  }
  return null;
}

/** Is there an X server we may raise windows on? */
export function canRaise(env: NodeJS.ProcessEnv): boolean {
  return !!env.DISPLAY && !env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== "wayland";
}

/** A helper runner: stdout on success, null on any failure. `env` replaces the inherited one. Injected for tests. */
export type Run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv) => string | null;

/** Is i3 managing this X display? By its socket env, else by asking `i3-msg`. Never probed off X11. */
export function onI3(env: NodeJS.ProcessEnv, run: Run): boolean {
  if (!canRaise(env)) return false;
  return !!env.I3SOCK || !!run("i3-msg", ["--get-socketpath"])?.trim();
}

/** An X window id as wmctrl (`0x…`) or xdotool (decimal) prints it → the decimal i3's `id` criterion takes. */
export function decimalWindowId(wid: string): string | null {
  if (/^0x[0-9a-f]+$/i.test(wid)) return String(parseInt(wid, 16));
  return /^\d+$/.test(wid) ? String(Number(wid)) : null;
}

interface SwayNode {
  id?: unknown;
  pid?: unknown;
  nodes?: unknown;
  floating_nodes?: unknown;
}

/** `swaymsg -t get_tree` → pid → the first container id it owns, or an empty map on anything unparsable. */
export function swayConsByPid(json: string): Map<number, number> {
  const out = new Map<number, number>();
  const walk = (node: SwayNode | null): void => {
    if (!node || typeof node !== "object") return;
    if (typeof node.pid === "number" && typeof node.id === "number" && !out.has(node.pid)) out.set(node.pid, node.id);
    for (const kids of [node.nodes, node.floating_nodes]) if (Array.isArray(kids)) kids.forEach(walk);
  };
  try {
    const tree: unknown = JSON.parse(json);
    walk(tree as SwayNode | null);
  } catch {
    // not a tree: nothing to focus
  }
  return out;
}

/** The argv that focuses i3 window `wid`, or null when the id is not one. */
export function i3FocusArgs(wid: string): string[] | null {
  const id = decimalWindowId(wid);
  return id === null ? null : [`[id=${id}] focus`];
}

function readStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null;
  }
}

/** Run a helper and hand back its stdout, or null on any failure (missing binary included). */
function quietRun(cmd: string, args: string[], env?: NodeJS.ProcessEnv): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 3_000, env });
  return r.status === 0 ? r.stdout ?? "" : null;
}

/** Activates a window by id through the window manager's own IPC; false when it can't. */
type Focus = (wid: string) => boolean;

/**
 * Focus X window `wid` through i3's IPC. An I3SOCK inherited by a tmux server
 * that outlived its i3 login names a dead socket, and i3-msg prefers it to the
 * live one the X root window advertises — so a refusal is retried without it.
 */
function focusWithI3(wid: string, env: NodeJS.ProcessEnv, run: Run): boolean {
  const args = i3FocusArgs(wid);
  if (args === null) return false;
  if (run("i3-msg", args, env) !== null) return true;
  if (!env.I3SOCK) return false;
  const { I3SOCK: _stale, ...rest } = env;
  return run("i3-msg", args, rest) !== null;
}

/** wmctrl first: one call lists every window with its pid. */
function raiseWithWmctrl(chain: number[], wmFocus: Focus, run: Run): boolean {
  const listing = run("wmctrl", ["-lp"]);
  if (listing === null) return false;
  const byPid = parseWmctrl(listing);
  const wid = nearestWindow(chain, (pid) => byPid.get(pid));
  return wid !== null && (wmFocus(wid) || run("wmctrl", ["-ia", wid]) !== null);
}

/** xdotool when wmctrl is absent or knows no ancestor: one search per ancestor. */
function raiseWithXdotool(chain: number[], wmFocus: Focus, run: Run): boolean {
  const windowOf = (pid: number) => run("xdotool", ["search", "--pid", String(pid)])?.split("\n")[0]?.trim() || undefined;
  const wid = nearestWindow(chain, windowOf);
  if (wid === null || !/^\d+$/.test(wid)) return false;
  return wmFocus(wid) || run("xdotool", ["windowactivate", wid]) !== null;
}

/** Sway: the container of the nearest ancestor that owns one, focused by `con_id`. */
function raiseWithSway(chain: number[], run: Run): boolean {
  const tree = run("swaymsg", ["-t", "get_tree"]);
  if (tree === null) return false;
  const byPid = swayConsByPid(tree);
  const con = nearestWindow(chain, (pid) => (byPid.has(pid) ? String(byPid.get(pid)) : undefined));
  return con !== null && run("swaymsg", [`[con_id=${con}] focus`]) !== null;
}

/** What `raiseTerminal` reaches outside the process, swapped out in tests. */
export interface RaiseDeps {
  run: Run;
  readStat: (pid: number) => string | null;
}

const REAL: RaiseDeps = { run: quietRun, readStat };

/** Raise the terminal hosting tmux client `clientPid`. Never throws; returns whether a window was activated. */
export function raiseTerminal(clientPid: number, env: NodeJS.ProcessEnv = process.env, deps: RaiseDeps = REAL): boolean {
  try {
    const chain = ancestry(clientPid, deps.readStat);
    // A SWAYSOCK can outlive sway in a tmux server's env — Regolith ships both a
    // sway and an i3 session — so failing there falls through to X11, i3 included.
    if (env.SWAYSOCK && raiseWithSway(chain, deps.run)) return true;
    if (!canRaise(env)) return false;
    const wmFocus: Focus = onI3(env, deps.run) ? (wid) => focusWithI3(wid, env, deps.run) : () => false;
    return raiseWithWmctrl(chain, wmFocus, deps.run) || raiseWithXdotool(chain, wmFocus, deps.run);
  } catch {
    return false;
  }
}
