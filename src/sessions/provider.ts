// The shape every agent backend implements, and the Claude profile discovery
// that the Claude one needs.
//
// Its own module purely so `sessions.ts` can import the three providers without
// them having to import `sessions.ts` back for the interface — which would be a
// cycle, and `import/no-cycle` is an error here.
import type { AgentSession, AgentSource } from "../types.ts";
import { dedupeProfiles, discoverProfiles } from "../profiles.ts";

// Claude config dirs to scan. The user may run multiple subscriptions/profiles,
// each with its own ~/.claude* dir (e.g. ~/.claude and ~/.claude-work); we
// remember which config dir each session came from (needed to set
// CLAUDE_CONFIG_DIR on resume). Discovery — and the realpath dedupe that stops a
// store symlinked between two profiles from being walked twice — lives in
// profiles.ts, which also owns moving a session between them.
export function claudeBaseDirs(): Promise<{ projects: string; configDir: string }[]> {
  return discoverProfiles().then(dedupeProfiles);
}

export interface SessionProvider {
  source: AgentSource;
  index(): Promise<AgentSession[]>;
}
