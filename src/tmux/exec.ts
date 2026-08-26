// The three ways every other module in this directory reaches a tmux server:
// run a control command, read a list back, and pause between two keystrokes.
// Split out so `pane.ts` and `windows.ts` can both send without either having to
// import the other.
import { spawnSync } from "child_process";

/** Synchronous sleep that works under both bun and node (the sender is sync). */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function tmuxLines(args: string[]): string[] {
  const r = spawnSync("tmux", args, { encoding: "utf-8" });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * Run a tmux control command silently. Safe to call while Ink owns the terminal
 * (we don't inherit stdio), so the menu can open windows without unmounting.
 */
export function tmuxQuiet(args: string[]): void {
  spawnSync("tmux", args, { stdio: "ignore" });
}
