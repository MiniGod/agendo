// The shape every agent backend implements, and the Claude profile discovery
// that the Claude one needs.
//
// Its own module purely so `sessions.ts` can import the three providers without
// them having to import `sessions.ts` back for the interface — which would be a
// cycle, and `import/no-cycle` is an error here.
import type { AgentSession, AgentSource } from "../shared/types.ts";
import { dedupeProfiles, discoverProfiles } from "./profiles/index.ts";

// Claude config dirs to scan. The user may run multiple subscriptions/profiles,
// each with its own ~/.claude* dir (e.g. ~/.claude and ~/.claude-work); we
// remember which config dir each session came from (needed to set
// CLAUDE_CONFIG_DIR on resume). Discovery — and the realpath dedupe that stops a
// store symlinked between two profiles from being walked twice — lives in
// profiles.ts, which also owns moving a session between them.
export function claudeBaseDirs(): Promise<{ projects: string; configDir: string }[]> {
  return discoverProfiles().then(dedupeProfiles);
}

/**
 * Which Claude transcripts a narrowed index reads, by the project dir it sits in
 * (Claude's encoding of the session's cwd) and the session id its filename
 * carries. Decided BEFORE a transcript is opened, which is the whole point:
 * parsing every transcript is what makes a full index slow.
 */
export type TranscriptFilter = (projectDir: string, sessionId: string) => boolean;

export interface SessionProvider {
  source: AgentSource;
  /** Every session on disk — or, given `only`, the ones it admits (providers cheap enough to scan whole may ignore it). */
  index(only?: TranscriptFilter): Promise<AgentSession[]>;
}
