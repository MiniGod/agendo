// `update-desktop-database` — rebuilding the applications dir's mimeinfo.cache
// after the .desktop entry is written or removed. `xdg-mime default` alone
// sets the scheme's DEFAULT; the cache is what makes the entry REGISTERED for
// it, and xdg-desktop-portal (Flatpak and Snap browsers) offers only registered
// handlers: without it, a link opens an empty "Open With…" dialog.
import { spawnSync } from "child_process";
import { shellQuote } from "./desktop.ts";

export const UPDATE_DESKTOP_DATABASE = "update-desktop-database";

/** The command that refreshes `dir`'s desktop database, ready to paste. */
export function refreshCommand(dir: string): string {
  return `${UPDATE_DESKTOP_DATABASE} ${shellQuote(dir)}`;
}

/**
 * Refresh `dir`'s desktop database, best effort: null when it ran, else a
 * warning naming the command to run by hand. A missing binary (desktop-file-utils
 * not installed) is not a failure — a browser that reads mimeapps.list itself
 * still works.
 */
export function refreshDesktopDatabase(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const r = spawnSync(UPDATE_DESKTOP_DATABASE, [dir], { env, encoding: "utf-8", timeout: 10_000 });
  if (r.status === 0) return null;
  return `warning: ${failure(r.error, r.stderr)}; run \`${refreshCommand(dir)}\` so the desktop portal (Flatpak/Snap browsers) sees the handler`;
}

/** Why the refresh did not happen: not runnable (likely no desktop-file-utils), or failed with what it said. */
function failure(error: Error | undefined, stderr: string | null): string {
  if (error) return `${UPDATE_DESKTOP_DATABASE} could not run (${error.message}; it comes with desktop-file-utils)`;
  const said = (stderr ?? "").split("\n").find((l) => l.trim());
  return said ? `${UPDATE_DESKTOP_DATABASE} failed: ${said.trim()}` : `${UPDATE_DESKTOP_DATABASE} failed`;
}
