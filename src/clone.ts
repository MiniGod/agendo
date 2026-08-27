// Cloning a repo the user doesn't have on disk yet, so the new-session picker
// can offer it like any other checkout. Three separable pieces, none of which
// know anything about sessions, worktrees or tmux (the UI wires the result back
// into the ordinary repo flow):
//
//   1. parseRepoUrl — a pasted URL (GitHub or Azure DevOps, web or clone, HTTPS
//      or SSH) → the remote to clone plus a canonical identity key.
//   2. findMatchingCheckout / freeCloneDest — where the clone should land in the
//      target directory, preferring an existing checkout of the same repo over a
//      second copy.
//   3. startClone — run `git clone` asynchronously with live progress, no
//      possibility of an interactive prompt hanging the TUI, and cleanup of the
//      partial directory on failure or cancellation.
//
// See docs/cloning.md for the flow and the decisions behind it.
//
// Each of the three is a module under src/clone/: url.ts, checkout.ts and
// run.ts. This file stays the one import path — the UI, e2e/clone.spec.ts and
// src/ui/format.ts all name it — so the re-exports below are the same 13 names
// it exported before.
export { parseRepoUrl, redactUrl, repoUrlLabel } from "./clone/url.ts";
export type { RepoHost, RepoUrl } from "./clone/url.ts";
export { cloneDirName, enclosingCheckout, findMatchingCheckout, freeCloneDest } from "./clone/checkout.ts";
export { startClone } from "./clone/run.ts";
export type { CloneFailure, CloneOutcome, CloneRun } from "./clone/run.ts";
