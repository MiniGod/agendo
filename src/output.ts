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
