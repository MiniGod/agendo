// The shapes the cleanup view is made of. Kept apart from the modules that
// produce them so the pure classification (classify.ts), the sort (sort.ts) and
// the async probes (git.ts, disk.ts) can share them without importing each other.
import type { AgentSession } from "../shared/types.ts";

/** Whether a session has a live window (running), a dormant restore tab (paused), or neither (idle). */
export type RunState = "running" | "paused" | "idle";

/** One row of the cleanup view: a session, or a managed worktree no session points at. */
export interface CleanupRow {
  /** Stable identity: `session:<source>:<id>` or `worktree:<path>`. */
  key: string;
  title: string;
  /** null for a worktree-only row. */
  session: AgentSession | null;
  /** The main checkout the row belongs to. */
  repoRoot: string;
  /** The agendo-managed worktree (`<repoRoot>/.claude/worktrees/<name>`) the row lives in, or null. */
  worktree: string | null;
  /** Where the row lives, for display and for the git probe: the worktree, else the session cwd. */
  path: string;
  /** The branch the session last reported, used when its worktree is already gone. */
  branchHint: string | null;
  updated: Date;
  created: Date;
  run: RunState;
  /**
   * The transcript was written moments ago although no agendo window holds the
   * session: it may be running in a plain terminal, so nothing starts ticked
   * and anything deleted needs the second confirmation.
   */
  active?: boolean;
}

/**
 * The git state of a row's checkout (or, once the worktree is gone, of its
 * branch). `null` in the probe map means there is nothing to judge: no checkout
 * on disk and no branch left either.
 */
export interface GitState {
  /** Whether the row's worktree directory is a live checkout. */
  worktreeExists: boolean;
  /** Whether `path` is the repo's MAIN checkout (never offered for deletion). */
  isMain: boolean;
  /** The checked-out branch, or the surviving branch; null when detached. */
  branch: string | null;
  /** The commit that branch (or the detached HEAD) points at, so a run can tell it moved. */
  head: string | null;
  /** The branch the main checkout has checked out (never offered for deletion). */
  mainBranch: string | null;
  /** `status --porcelain` entries: modified, staged and untracked. */
  dirty: number;
  /** The paths behind `dirty`, so a run can tell a different file took a confirmed one's place. */
  changed: string[];
  /**
   * Ignored files and directories that `git worktree remove` would delete
   * without a word (a `.env`, local settings), regenerable output excluded.
   */
  ignored: string[];
  /**
   * Submodules checked out in the worktree. Their own work is not looked at
   * here, and git removes such a worktree only with --force.
   */
  submodules: number;
  /** Why `git status` could not be read; dirty, changed and ignored then say nothing. */
  statusError?: string;
  /** Commits whose changes are on no remote (0 once the branch is merged). */
  unpushed: number;
  /** Whether the branch's changes are in `base`, by ancestry, tree or patch-id. */
  merged: boolean;
  /** The ref `merged` was judged against (`origin/master`), null when none exists. */
  base: string | null;
}

/** On-disk bytes per part of a row: undefined while measuring, null when the part does not exist. */
export interface RowSizes {
  worktree: number | null | undefined;
  transcript: number | null | undefined;
  tmp: number | null | undefined;
}

/** The four things the dialog can delete. */
export type Box = "worktree" | "branch" | "transcript" | "tmp";
export const BOXES: readonly Box[] = ["worktree", "branch", "transcript", "tmp"];

export type Selection = Record<Box, boolean>;

/** Whether a box can be ticked, and why not when it can't. */
export interface Offer {
  enabled: boolean;
  reason?: string;
}
export type Offers = Record<Box, Offer>;
