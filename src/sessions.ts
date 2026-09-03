// Discovers resumable agent sessions on disk and indexes them by branch so the
// UI can answer "what sessions exist for this work item's PR branch?".
//
// Three providers today (Claude Code, Copilot CLI, Codex CLI) behind a small
// interface so more agent types can be added later. Each indexes its own
// on-disk sessions and each resumes natively (Claude via `claude --resume`,
// Copilot via `copilot --resume=<id>`, Codex via `codex resume <id>`); see
// launch.ts:resumeArgv.
//
// Each provider now lives in src/sessions/ alongside the parse cache they share
// and the repo-scoping predicate; what stays here is the INDEX built on top of
// them — the merge, the duplicate resolution and the branch lookup. This file
// remains the one import path (App.tsx, index.tsx, model.ts, wait.ts and three
// e2e specs all name it), so the re-exports below are the same six names it
// exported before.
import { realpath } from "fs/promises";
import type { AgentSession } from "./types.ts";
import { claudeProvider } from "./sessions/claude.ts";
import { copilotProvider } from "./sessions/copilot.ts";
import { codexProvider } from "./sessions/codex.ts";

export { __claudeParseCount, __resetClaudeParseCount, __claudeCacheSize } from "./sessions/claude.ts";
import { repoScope, sessionInScope } from "./sessions/scope.ts";
export { repoScopeFilter } from "./sessions/scope.ts";

const PROVIDERS = [claudeProvider, copilotProvider, codexProvider];

/** An index of all discovered sessions, queryable by branch. */
export class SessionIndex {
  private byBranch = new Map<string, AgentSession[]>();
  readonly all: AgentSession[] = [];

  static async build(): Promise<SessionIndex> {
    const idx = new SessionIndex();
    const lists = await Promise.all(PROVIDERS.map((p) => p.index()));
    // Dedupe by source:id — the same session can be discovered more than once
    // when a user has symlinked pieces of one profile's store into another (a
    // single `<id>.jsonl`, an `<enc-cwd>/` dir; a symlinked `projects/` or
    // `~/.claude` is already collapsed upstream by dedupeProfiles). A duplicate's
    // filename — hence its id — is necessarily the same, so the id key catches
    // every alias. Which copy survives is decided in preferredDuplicate.
    const byId = new Map<string, AgentSession>();
    for (const list of lists) {
      for (const s of list) {
        const key = `${s.source}:${s.id}`;
        const prev = byId.get(key);
        byId.set(key, prev ? await preferredDuplicate(prev, s) : s);
      }
    }
    for (const s of byId.values()) {
      idx.all.push(s);
      if (s.branch) {
        const arr = idx.byBranch.get(s.branch) ?? [];
        arr.push(s);
        idx.byBranch.set(s.branch, arr);
      }
    }
    for (const arr of idx.byBranch.values()) {
      arr.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
    }
    return idx;
  }

  forBranch(branch: string | undefined): AgentSession[] {
    if (!branch) return [];
    return this.byBranch.get(branch) ?? [];
  }

  /**
   * Sessions tied to a work item by its id appearing in the branch name or
   * working directory (e.g. branch `worktree-…-231938`, worktree dir `…-231938`).
   * Used to surface sessions for items that have no PR to match on. The digit
   * boundaries prevent #231938 from matching e.g. 1231938 or 2319380.
   *
   * `repo` (optional) scopes the match to the item's own repository. It's needed
   * for backends whose item ids are small and collide across repos: a GitHub
   * issue #2 would otherwise match a branch/cwd like `app2` or `v2-fixes`, and a
   * repoA #7 would match an unrelated repoB #7. Pass the item's `owner/repo` slug
   * (or bare repo name) to require the session to live in that repo. ADO ids are
   * globally unique, so it passes null and the match stays unscoped (unchanged).
   *
   * Passing a slug makes this resolve each candidate session's checkout to its
   * own `owner/repo` via `git remote get-url origin` (see sessionInScope) —
   * memoized per repo root, but still a process spawn on the first sighting of
   * a root. Keep it off hot polling paths; the unscoped call never shells out.
   */
  forWorkItem(id: number, repo?: string | null): AgentSession[] {
    const re = new RegExp(`(^|[^0-9])${id}([^0-9]|$)`);
    const scope = repo ? repoScope(repo) : null;
    return this.all.filter((s) => {
      if (scope && !sessionInScope(s, scope)) return false;
      return (s.branch && re.test(s.branch)) || re.test(s.cwd);
    });
  }
}

/**
 * Which of two entries for the SAME session id to keep.
 *
 * Prefer the REALPATH OWNER — the one whose transcript path needs no symlink
 * traversal — so a session symlinked from profile B into profile A is attributed
 * to the profile that actually holds the bytes, and `CLAUDE_CONFIG_DIR` on resume
 * points there. When ownership can't decide it (neither owns the path because the
 * profile dir itself is a symlink, or both do because they're genuinely separate
 * files that happen to share an id) fall back to the most-recently-used, which is
 * the pre-existing tie-break.
 *
 * Only reached on an actual collision, so the realpath syscalls cost nothing on
 * the overwhelmingly common no-duplicates path.
 */
export async function preferredDuplicate(a: AgentSession, b: AgentSession): Promise<AgentSession> {
  const [aOwns, bOwns] = await Promise.all([ownsLogPath(a), ownsLogPath(b)]);
  if (aOwns !== bOwns) return aOwns ? a : b;
  return b.lastUsed.getTime() > a.lastUsed.getTime() ? b : a;
}

/** Whether a session's transcript path reaches the file without a symlink hop. */
export async function ownsLogPath(s: AgentSession): Promise<boolean> {
  if (!s.logPath) return false;
  return (await realpath(s.logPath).catch(() => null)) === s.logPath;
}


// The on-demand full-log parse behind an expanded session row lives in
// activity.ts. Re-exported here, and only here, because `src/sessions.ts` is the
// path App.tsx, useActivityWatchers and index.tsx already import `loadActivity`
// from. Import anything else from activity.ts directly: this file re-exporting
// it is the edge that would let a cycle form if activity.ts ever imported back.
export { loadActivity } from "./activity.ts";
