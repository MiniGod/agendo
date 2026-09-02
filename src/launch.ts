// Orchestrates "open this session". Inside tmux, agents run as windows in the
// current session (so picking one opens a new tab next to you); outside tmux,
// each runs as its own detached session we attach to.
//
// ─────────────────────────────────────────────────────────────────────────────
// This file is now a FACADE over src/launch/. It holds no logic of its own.
//
// It stays the single import path for "starting a session" — 13 modules under
// src/ and e2e/detection.spec.ts already name it — so the split below changed no
// caller. The re-exports are written out one by one rather than as `export *`
// for the reason src/tmux.ts gives: several helpers became cross-module only to
// serve the split (`freshPanePlan`, `launchManaged`, `ManagedOptions`), and
// `export *` would quietly promote them into agendo's public surface.
//
// Where things went, and why in that order — each module may only import from
// the ones above it, which is what keeps `import/no-cycle` green:
//
//   open.ts     decide/create a target and describe the handover to it
//   managed.ts  mint a `cl-…` session: id, name, argv, orchestrator marker
//   task.ts     the repo-shaped launches — work item / PR, and `agendo launch`
//   global.ts   the global orchestrator: no repo, no worktree, split-pane layout
// ─────────────────────────────────────────────────────────────────────────────

export { SELF_CMD, SELF_CMD_ENV, withSelfCmdEnv, notRunningHint } from "./selfCmd.ts";
export { llmGuide } from "./launchPrompt.ts";
export { resumeArgv, preassignsSessionId, FORWARDABLE_LAUNCH_FLAGS } from "./launchArgv.ts";

export { openTarget, openSession, runInline, type OpenPlan } from "./launch/open.ts";

export { launchNewSession } from "./launch/managed.ts";

export {
  freshName,
  prFreshName,
  launchFresh,
  launchTask,
  type LaunchOptions,
  type LaunchResult,
} from "./launch/task.ts";

export {
  launchGlobalOrchestrator,
  type GlobalLayout,
  type GlobalLaunchOptions,
  type GlobalLaunchResult,
} from "./launch/global.ts";
