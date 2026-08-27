// The shapes the view model is made of: what a session links back to, what one
// full load produces, what one load is asked for, and the cheap local-only
// subset of it.
//
// They live below both the live-tmux layer and the repo-scope filters so those
// can take a LoadedModel apart without importing the module that assembles one.
import type { SessionIndex } from "../sessions.ts";
import type { RepoInfo } from "../repos.ts";
import type { LiveTarget, SessionKind } from "../tmux.ts";
import type {
  Identity, LinkedPR, PRWithSessions, ProviderName,
  RepoSessions, ReviewPRWithSessions, TeamMember, WorkItem,
} from "../types.ts";

/**
 * What a local session links back to: the PR whose branch it matches and/or the
 * work item that PR (or its branch/worktree id) resolves to. Used by the
 * Sessions view to show a backlink and open it in the browser. Structurally
 * matches the UI's OpenTargets so it can be passed straight through.
 */
export interface SessionLink {
  pr?: { id: number; url: string };
  workItem?: { id: number; url: string };
}

export interface LoadedModel {
  /** Which backend produced this model — drives provider-specific terminology. */
  provider: ProviderName;
  // The two item-view buckets. ADO: current sprint / everything else assigned.
  // GitHub: issues you created / other open issues in your repos.
  current: WorkItem[];
  other: WorkItem[];
  /** PRs linked to one of my work items (PR view, upper section). */
  linkedPrs: LinkedPR[];
  /** Active PRs where I (or one of my teams) am a requested reviewer. */
  reviewPrs: ReviewPRWithSessions[];
  /** Active PRs I created that aren't linked to any of my work items. */
  orphanPrs: PRWithSessions[];
  /**
   * Work items resolved via the PR→workitems direction for orphan PRs I
   * created. The WI wasn't assigned to me / matched my filters, but my PR
   * links to it — surfaced so the work context is visible. Includes the PR(s)
   * that surfaced each item merged into the item's prs list.
   */
  prLinked: WorkItem[];
  currentIterationName: string | null;
  /** tmux session names that are currently live. */
  liveTmux: Set<string>;
  /** How each currently-running session was launched, by canonical name (for UI badges). */
  liveKinds: Map<string, SessionKind>;
  /** The live tmux window each running session occupies, by canonical name (for pane reads). */
  liveWindows: Map<string, LiveTarget>;
  /**
   * Canonical names of sessions that have a live but dormant restore placeholder
   * window (idle bash awaiting a keypress, not yet running). Not in `liveTmux`;
   * lets the Sessions view badge them as restored-but-unopened.
   */
  livePlaceholders: Set<string>;
  /** Repos ranked by session count, for the fresh-session repo picker. Includes
   *  the repos found under the launcher's path context, so a freshly-cloned repo
   *  that never hosted a session is still offered. */
  repos: RepoInfo[];
  /**
   * Match set for repo-scoped filtering of the work-item / PR views: every
   * identifier (slug, repo name, directory basename) of the repos found under
   * the launcher's path context, or `null` when there is no path context (or no
   * repo inside it) — in which case filtering is inert. See prInRepoScope.
   */
  repoScope: Set<string> | null;
  /** All local sessions grouped by their worktree's main repo (Sessions view). */
  sessionGroups: RepoSessions[];
  /**
   * Reverse index: which PR / work item each local session links to, keyed by
   * `${source}:${id}`. Lets the Sessions view surface the backlink (display +
   * open-in-browser) even though a session is only matched onto PRs/WIs.
   */
  sessionLinks: Map<string, SessionLink>;
  /** The authenticated az user (the "(you)" marker / default identity). */
  me: Identity;
  /** The identity whose work items & PRs are shown (Work items + PRs views). */
  identity: Identity;
  /** Roster for the identity switcher (configured team's members). */
  teamMembers: TeamMember[];
}

export interface LoadModelOptions {
  /** Which backend to load from (Azure DevOps or GitHub). */
  provider: ProviderName;
  /** Whose work items / PRs to show; null ⇒ the authenticated user. */
  identity: Identity | null;
  /**
   * The launcher's tmux host session, whose open tabs are snapshotted for
   * browser-style restore. Defaults to the canonical `agendo` session; a
   * path-scoped launcher passes its own host session so restore stays isolated.
   */
  hostSession?: string;
  /**
   * The git repos found under the launcher's path context (repos.ts'
   * `discoverGitReposUnder`). They widen the fetch scope — backends that query
   * per repo (GitHub) must see a repo inside the target even if no session ever
   * ran there — and produce `LoadedModel.repoScope`, the display filter. Absent
   * / empty ⇒ no path context, so nothing is scoped.
   */
  scopeRepos?: RepoInfo[];
}

/**
 * The CHEAP, network-free half of a model load: scan on-disk sessions, discover
 * their repos, reconcile live tmux, and group sessions by repo. Deliberately does
 * NO provider.* calls, so it's light enough to poll on a short timer — the App
 * runs it every couple seconds to discover sessions started since the last full
 * `loadModel` (so their windows enter `liveWindows` and the readiness/auto-resume
 * poll can act on them) without paying for the slow backend fetches. `loadModel`
 * reuses it so the local half has a single source of truth.
 */
export interface LocalSessions {
  index: SessionIndex;
  repos: RepoInfo[];
  sessionGroups: RepoSessions[];
  live: Set<string>;
  liveKinds: Map<string, SessionKind>;
  liveWindows: Map<string, LiveTarget>;
  livePlaceholders: Set<string>;
}
