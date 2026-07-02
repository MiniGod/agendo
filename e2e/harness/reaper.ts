// Process-wide safety net so abnormal test-runner termination can't leave
// orphans behind. The normal path still tears everything down explicitly (see
// mockEnv.cleanup / WebTerminal.close); this catches the cases those miss —
// a killed Playwright worker, a Ctrl-C, a CI/Bash timeout (SIGTERM) — by killing
// every tracked PTY and removing every tracked temp dir before the process dies.
//
// Background: a leaked launcher PTY whose master has closed busy-spins at 100%
// CPU forever (its raw-mode stdin sits in POLLHUP), so reaping on exit matters.
import { rmSync } from "node:fs";

type Killable = { kill: (signal?: string) => void };

const ptys = new Set<Killable>();
const dirs = new Set<string>();
let installed = false;

function cleanupAll(): void {
  for (const p of ptys) {
    try {
      p.kill("SIGKILL"); // SIGKILL: a spinning child may not heed anything gentler
    } catch {
      /* already gone */
    }
  }
  ptys.clear();
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
  }
  dirs.clear();
}

function install(): void {
  if (installed) return;
  installed = true;
  // Runs on normal exit and on explicit process.exit() — cleans temp dirs even
  // when no signal is involved.
  process.on("exit", cleanupAll);
  // Signals don't fire "exit", so handle them explicitly, then terminate.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      cleanupAll();
      process.exit(130);
    });
  }
}

export function trackPty(p: Killable): void {
  install();
  ptys.add(p);
}
export function untrackPty(p: Killable): void {
  ptys.delete(p);
}
export function trackDir(dir: string): void {
  install();
  dirs.add(dir);
}
export function untrackDir(dir: string): void {
  dirs.delete(dir);
}
