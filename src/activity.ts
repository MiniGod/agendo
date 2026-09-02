// ── On-demand activity (recent action lines) ────────────────────────────────
// The session index in sessions.ts stays cheap (metadata only). When a session
// row is expanded in the UI we parse its full log here to surface the last few
// actions — the same idea as the standalone claude-tasks dashboard, but loaded
// one file at a time so it's only paid for sessions the user actually opens.
//
// One reader per agent lives under src/activity/; this is the dispatch, and
// the import path sessions.ts re-exports from.

import { loadClaudeActivity } from "./activity/claude.ts";
import { loadCodexActivity } from "./activity/codex.ts";
import { loadCopilotActivity } from "./activity/copilot.ts";
import type { AgentSession, SessionActivity } from "./types.ts";

/** Options for on-demand activity loading. `full` skips display truncation. */
export interface LoadActivityOpts {
  /** When true, don't truncate the last prompt or action details (for `agendo status --full`). */
  full?: boolean;
}

/** Parse a session's recent activity on demand (called when its row expands). */
export function loadActivity(s: AgentSession, opts: LoadActivityOpts = {}): Promise<SessionActivity> {
  switch (s.source) {
    case "claude":
      return loadClaudeActivity(s.logPath, opts.full);
    case "copilot":
      return loadCopilotActivity(s.logPath, opts.full);
    case "codex":
      return loadCodexActivity(s.logPath, opts.full);
  }
}
