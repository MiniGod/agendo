import { takeWarnings } from "../errors.ts";

/**
 * Print (and clear) anything the load reported-and-ignored. The TUI surfaces
 * these as a notice; the CLI has no such chrome, so they go to stderr — leaving
 * stdout clean for `--json`. Without this a corrupt `~/.agendo/state.json` would
 * silently drop the persisted backend and identity, and the command would query
 * the wrong backend with no hint as to why.
 */
export function flushWarnings(prefix: string): void {
  for (const w of takeWarnings()) console.error(`${prefix}: ${w}`);
}
