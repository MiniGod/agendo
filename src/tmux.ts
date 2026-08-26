// Thin wrapper around the tmux CLI. The launcher owns a naming convention
// (`cl-…`) so it can tell whether a given agent already has a live tmux target
// and navigate to it. A managed agent runs as either a tmux *session* (when the
// launcher was started outside tmux) or a *window* in the current session (when
// started inside tmux) — see launch.ts for which path is chosen.
//
// The `--tmux` CLI flag bootstraps a single canonical session (LAUNCHER_SESSION)
// whose first window runs the menu, so every agent ends up as a tab next to it.
//
// ─────────────────────────────────────────────────────────────────────────────
// This file is now a FACADE over src/tmux/. It holds no logic of its own.
//
// It stays the single import path for the whole tree — 23 modules under src/ and
// three frozen specs under e2e/ import `./tmux.ts` by name — so the split below
// changed no caller. The re-exports are written out one by one rather than as
// `export *` on purpose: several helpers that used to be file-private are now
// exported from their new module so a sibling can reach them, and `export *`
// would quietly promote every one of those into agendo's public surface. This
// list is exactly the 70 names the single-file version exported, and a symbol
// only joins it by being added here deliberately.
//
// Where things went, and why in that order — each module may only import from
// the ones above it, which is what keeps `import/no-cycle` green:
//
//   exec.ts          run a tmux command, read a list back, sleep between keys
//   names.ts         the `cl-…` naming convention; no server contact at all
//   pane.ts          capture a pane's screen / send keystrokes to it
//   readiness.ts     the readiness vocabulary — states, prompt glyphs, verdict
//   inputBox.ts      find and read the claude input box + live status region
//   dialog.ts        open dialogs, and the CLI's own resume prompt
//   chrome.ts        limit notice, task panel, compaction bar, agent/shell counts
//   codex.ts         the codex TUI, which shares no structure with claude's
//   paneReadiness.ts the classifier that composes all of the above
//   server.ts        read the live server: sessions, windows, managed targets
//   windows.ts       change it: kill, create, bootstrap the launcher session
// ─────────────────────────────────────────────────────────────────────────────

export { tmuxQuiet } from "./tmux/exec.ts";

export {
  LAUNCHER_SESSION,
  ROOT_OPTION,
  PLACEHOLDER_OPTION,
  ID_BEARING_NAME,
  tmuxAvailable,
  insideTmux,
  shortId,
  sessionName,
  kindName,
  managedKind,
  type SessionKind,
  type LiveTarget,
  type ManagedTarget,
} from "./tmux/names.ts";

export {
  capturePane,
  capturePaneState,
  readPaneState,
  stripAnsi,
  sendToPane,
  resumeKeystrokes,
  RESUME_KEY_DELAY_MS,
  sendResume,
  dialogRevealKeystrokes,
  sendDialogReveal,
  type PaneCursor,
  type PaneSnapshot,
} from "./tmux/pane.ts";

export { sessionFinished, type Readiness } from "./tmux/readiness.ts";

export { paneReadiness, paneAcceptsPaste } from "./tmux/paneReadiness.ts";

export {
  paneResumeDialogActive,
  paneResumeMenuSuspect,
  resumeDialogOption,
  resumeDialogSelection,
  resumeDialogStep,
  answerResumeDialog,
  RESUME_DIALOG_WAIT_MS,
  RESUME_DIALOG_POLL_MS,
  type ResumeDialogOption,
  type ResumeDialogChoice,
} from "./tmux/dialog.ts";

export {
  paneLimitDialogActive,
  paneUsageLimited,
  paneResumeSafe,
  paneCompactionPercent,
  paneBackgroundAgents,
  paneShells,
} from "./tmux/chrome.ts";

export {
  liveTargetForShortId,
  liveSessions,
  liveWindows,
  liveTargets,
  liveManagedPaths,
  exactTarget,
  windowTarget,
  hasSession,
  currentSessionName,
  sessionRoot,
  setSessionRoot,
} from "./tmux/server.ts";

export {
  killWindow,
  killSession,
  killManagedTarget,
  launcherWindowPaths,
  isPlaceholderWindow,
  windowLocations,
  windowLocation,
  newDetached,
  markPlaceholder,
  newWindow,
  newWindowIn,
  launcherWindowLive,
  enterLauncherSession,
} from "./tmux/windows.ts";
