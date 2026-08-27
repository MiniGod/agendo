// Per-transcript parse cache, shared by the Claude and Codex providers — one
// instance each, so a provider's prune can only ever touch its own transcripts.
import type { AgentSession } from "../types.ts";

// Per-transcript parse cache, keyed by absolute .jsonl path. Parsing a
// transcript means reading + JSON-parsing a possibly huge file; with the index
// rebuilt on a short timer that dominated a CPU core across hundreds of MB of
// transcripts. Since a transcript only gains records by being appended to
// (mtime AND size move together on any change), reusing the built AgentSession
// while both match is pure memoization — build() output stays byte-for-byte
// identical for a given on-disk state. The one actively-appending transcript
// (the foreground session's own log) still re-parses every build because its
// mtime/size change each tick; that's one file, not the whole corpus.
// Incremental tail-by-offset reading of that growing file is a possible future
// follow-up, not done here.
//
// Files that turn out NOT to be sessions are cached too, as null: codex writes a
// sub-agent rollout beside every real one, and without a negative entry each
// rebuild would re-read all of them forever.
//
// One instance per provider, so a provider's prune (which deletes every key not
// seen this scan) can only ever touch its own transcripts.
export class TranscriptCache {
  private map = new Map<string, { mtimeMs: number; size: number; session: AgentSession | null }>();

  /**
   * The cached result for this file, if it hasn't changed since we parsed it:
   * the built session, `null` for a file we've already judged not to be one, or
   * `undefined` for a genuine miss the caller must parse.
   */
  hit(path: string, st: { mtimeMs: number; size: number }): AgentSession | null | undefined {
    const c = this.map.get(path);
    return c && c.mtimeMs === st.mtimeMs && c.size === st.size ? c.session : undefined;
  }

  store(path: string, st: { mtimeMs: number; size: number }, session: AgentSession | null): void {
    this.map.set(path, { mtimeMs: st.mtimeMs, size: st.size, session });
  }

  /** Drop entries for transcripts that no longer exist (`seen` = this scan's files). */
  prune(seen: Set<string>): void {
    for (const path of this.map.keys()) if (!seen.has(path)) this.map.delete(path);
  }

  get size(): number {
    return this.map.size;
  }
}
