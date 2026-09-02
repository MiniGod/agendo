/** One discovered Claude config profile. */
export interface ClaudeProfile {
  /** The config dir AS DISCOVERED, e.g. `~/.claude-work` (not symlink-resolved).
   *  This is what `CLAUDE_CONFIG_DIR` must be set to on resume. */
  configDir: string;
  /** `<configDir>/projects` — the transcript store. */
  projects: string;
  /** Display name: the dir's basename (`.claude`, `.claude-work`, …). */
  name: string;
  /**
   * `realpath(projects)`, or `projects` when it can't be resolved. Two profiles
   * sharing a `realProjects` are the same store under two names — moving between
   * them is a no-op, and listing must not show their sessions twice.
   */
  realProjects: string;
}
