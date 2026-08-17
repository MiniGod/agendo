// How the CLI writes to stdout: the two printers, and the formatting for the
// entity links they carry. Both printers await the write for the same reason:
// the dispatch calls `process.exit(0)` as soon as its runner returns, and Bun
// drops stdout still buffered at exit.

import type { ProviderName } from "./types.ts";

/**
 * Print a JSON payload and await the write. The CLI subcommand dispatch calls
 * `process.exit(0)` right after its runner returns, and Bun drops stdout still
 * buffered at exit — a `console.log` of a large payload into a pipe truncates
 * at ~64KB (the pipe buffer), silently corrupting `--json` output for the
 * scripts consuming it. Awaiting the write callback guarantees the payload is
 * flushed before the dispatch can exit.
 *
 * Lives in its own module (rather than in the CLI entrypoint) so `wait.ts` can
 * use it without importing the entrypoint — importing that would run the whole
 * argv dispatch as a side effect.
 */
export function printJson(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Print one line and await the write. Used where the printed text IS the
 * deliverable — `agendo open`'s entity URLs, which agents consume over a pipe.
 *
 * Best-effort by design: unlike printJson it never rejects. A write error here
 * means the reader is gone — `agendo open <id> --print | head -1` closes the
 * pipe after the first line — and turning that routine EPIPE into an unhandled
 * rejection would crash a command that a plain `console.log` would have exited
 * cleanly. (printJson keeps rejecting: its payload is a single all-or-nothing
 * document, so a caller that half-wrote one wants to know.)
 */
export function printLine(text: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdout.write(text + "\n", () => resolve());
  });
}

/**
 * One `label: id  url` line, columns padded so the PR and work-item rows line
 * up under each other (and under `status`'s other `key:` lines). Shared by
 * `status --urls` and `agendo open --print` so the two can't drift into
 * formatting a link two different ways.
 */
export function linkLine(label: string, id: string, url: string): string {
  return `  ${`${label}:`.padEnd(7)} ${id.padEnd(7)} ${url}`;
}

/** Provider-specific labels for the CLI's entity-link output. (vocab.ts holds
 *  the TUI's fuller vocabulary; the link lines only need these three.) */
export function linkVocab(provider: ProviderName): { prPrefix: string; abbrev: string; noun: string } {
  return provider === "github"
    ? { prPrefix: "#", abbrev: "issue", noun: "issue" }
    : { prPrefix: "!", abbrev: "wi", noun: "work item" };
}
