// Bringing the terminal that shows a tmux client to the front — on X11, and only
// ever as a nicety.
//
// Switching the client is the actual focus; this step just saves the human from
// alt-tabbing to the terminal it happened in. So every failure here is silent:
// Wayland (where one client may not raise another's window), no DISPLAY, wmctrl
// and xdotool both missing, a terminal that is not an ancestor of the client
// (attached over ssh, say). None of them may fail the command.
//
// The route: the tmux client's pid → its ancestors (the shell, then the terminal
// emulator) → the first one that owns an X window → activate that window.
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

function readStat(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null;
  }
}

/** Run a helper and hand back its stdout, or null on any failure (missing binary included). */
function quietRun(cmd: string, args: string[]): string | null {
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 3_000 });
  return r.status === 0 ? r.stdout ?? "" : null;
}

/** wmctrl first: one call lists every window with its pid. */
function raiseWithWmctrl(chain: number[]): boolean {
  const listing = quietRun("wmctrl", ["-lp"]);
  if (listing === null) return false;
  const byPid = parseWmctrl(listing);
  const wid = nearestWindow(chain, (pid) => byPid.get(pid));
  return wid !== null && quietRun("wmctrl", ["-ia", wid]) !== null;
}

/** The first X window xdotool finds for `pid`. */
function xdotoolWindowOf(pid: number): string | undefined {
  return quietRun("xdotool", ["search", "--pid", String(pid)])?.split("\n")[0]?.trim() || undefined;
}

/** xdotool when wmctrl is absent or knows no ancestor: one search per ancestor. */
function raiseWithXdotool(chain: number[]): boolean {
  const wid = nearestWindow(chain, xdotoolWindowOf);
  return wid !== null && /^\d+$/.test(wid) && quietRun("xdotool", ["windowactivate", wid]) !== null;
}

/** Raise the terminal hosting tmux client `clientPid`. Never throws; returns whether a window was activated. */
export function raiseTerminal(clientPid: number, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!canRaise(env)) return false;
  try {
    const chain = ancestry(clientPid, readStat);
    return raiseWithWmctrl(chain) || raiseWithXdotool(chain);
  } catch {
    return false;
  }
}
