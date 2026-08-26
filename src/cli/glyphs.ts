// The CLI's own glyph and label tables.
//
// Shared by `status` and `list` rather than owned by either, so the two can
// never disagree about what a state looks like on a terminal.


import type { SessionKind } from "../tmux.ts";
import type { WorkflowStatus } from "../types.ts";

/** CLI glyphs for the three task states (plain ASCII markers stay greppable). */
export const STATUS_GLYPH: Record<string, string> = {
  completed: "[x]",
  in_progress: "[~]",
  pending: "[ ]",
};

/** CLI glyphs for workflow run states, matching the task-glyph style. */
export const WF_GLYPH: Record<WorkflowStatus, string> = {
  running: "[~]",
  completed: "[x]",
  failed: "[!]",
  stopped: "[-]",
  interrupted: "[?]",
};

/**
 * Trailing marker for a stalled session, in the same slot as the ⛁ (background
 * shells) and ◆ (running workflows) markers. Deliberately a marker rather than a
 * new column or a changed `ready` value: readiness is load-bearing for `send` /
 * `wait` / auto-resume and must keep reading exactly as before. The `age` column
 * already carries the idle time this qualifies.
 */
export const STALLED_MARK = "⚠stalled";

/** Short kind labels for the `list` columns, matching the menu's {bg}/{new} badges. */
export const KIND_LABEL: Record<SessionKind, string> = {
  background: "bg",
  new: "new",
  workitem: "wi",
  pr: "pr",
  resumed: "—",
};
