/**
 * `agendo wait` — block until watched session(s) change state, so a caller can
 * be TOLD rather than poll.
 *
 * This is the notification primitive for an orchestrator running background
 * sessions. The intended shape is: start the wait in the background and let its
 * EXIT be the wake-up. Re-running `status` on a guessed cadence is the failure
 * mode this exists to remove — it either fires too often (wasted turns) or too
 * late (stale answer), and the caller has no way to pick the right interval.
 *
 * Cost: polling for state has to happen somewhere, and it happens here on the
 * cheap path only. The transcript-backed `SessionIndex` is built ONCE, up front,
 * to resolve ids; the loop itself never rebuilds it. Each tick does exactly one
 * `refreshLiveTmux` (the same list-sessions/list-windows/list-panes reads the TUI
 * already makes) plus one pane capture per live target. No transcript is read or
 * parsed by the loop — see the parse-count assertion in e2e/sessions-cache.spec.ts.
 * Latency therefore bottoms out at `--interval`.
 */

// The pieces live in src/wait/: types.ts (states, options, result shapes and the
// satisfaction predicate), args.ts (argv parsing and the CLI entry point) and
// loop.ts (the poll loop, the usage banner and `runWait` itself).
//
// This file stays the one import path — src/index.tsx imports
// parseDuration/runWaitCli from it and e2e/harness/waitPollDriver.ts imports
// runWait — so the re-exports below are the same 10 names it exported before.
export { WAIT_STATES, waitSatisfied } from "./wait/types.ts";
export type { WaitOptions, WaitPayload, WaitResult, WaitState } from "./wait/types.ts";
export { parseDuration, parseWaitArgs, runWaitCli } from "./wait/args.ts";
export { runWait } from "./wait/loop.ts";
