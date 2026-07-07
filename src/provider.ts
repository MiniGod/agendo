// Backend abstraction: the launcher talks to either Azure DevOps (ado.ts) or
// GitHub (github.ts) through this one interface, chosen at runtime (persisted in
// LauncherState, toggleable from the UI). model.ts depends only on the Provider
// — never on a concrete backend.
import { spawnSync } from "child_process";
import type { RepoInfo } from "./repos.ts";
import type {
  Identity,
  ProviderName,
  PullRequest,
  ReviewPR,
  TeamMember,
  WorkItem,
} from "./types.ts";

import * as ado from "./ado.ts";
import * as github from "./github.ts";

/** Everything a fetch needs: who to act as, filters, and the local repo scope. */
export interface FetchContext {
  /** The identity whose work items / PRs to fetch. */
  identity: Identity;
  /** Repos discovered from local sessions — the scope for backends (GitHub) that
   *  derive their query set from where you actually work. */
  repos: RepoInfo[];
}

export interface Provider {
  /** Whether the backend can authenticate right now (CLI installed + logged in).
   *  Cheap, never-throwing probe for the Settings page's auth-status line. */
  checkAuth(): Promise<boolean>;
  /** The authenticated user — the default identity and the "(you)" marker. */
  getMe(): Promise<Identity>;
  /** Roster for the identity switcher. */
  getTeamMembers(): Promise<TeamMember[]>;
  /** Work items (ADO: current-iteration assigned items; GitHub: open issues). */
  fetchWorkItems(ctx: FetchContext): Promise<{
    items: Omit<WorkItem, "sessions">[];
    currentIterationPath: string | null;
  }>;
  /** Open PRs the identity created. */
  fetchActivePRs(ctx: FetchContext): Promise<PullRequest[]>;
  /** Open PRs awaiting the identity's (or their teams') review. */
  fetchReviewPRs(ctx: FetchContext): Promise<ReviewPR[]>;
  /** Fill in CI/merge-gate status, required-approval denominators, and last
   *  update time for the given PRs. May be a no-op if the backend fills these
   *  at fetch time (GitHub). Mutates in place. */
  enrichPrCI(prs: PullRequest[]): Promise<void>;
  /** Resolve the work items reached *from* the given (orphan) PRs — items the
   *  identity didn't have assigned but whose work their PR links to. Returns the
   *  mapped items (sessions attached by the caller) and the ids of the PRs
   *  actually surfaced under a fetched item. Backends without a PR→item link
   *  (GitHub) return nothing, leaving the PRs as orphans. */
  fetchWorkItemsForPRs(
    prs: PullRequest[],
    opts: { excludeWorkItemIds: Set<number>; currentIterationPath: string | null },
  ): Promise<{ items: Omit<WorkItem, "sessions">[]; surfacedPrIds: Set<number> }>;
}

// ADO's functions predate the FetchContext shape, so adapt them here rather than
// churn ado.ts: pull the field each one actually needs out of the context.
const adoProvider: Provider = {
  checkAuth: ado.checkAuth,
  getMe: ado.getMe,
  getTeamMembers: ado.getTeamMembers,
  fetchWorkItems: (ctx) => ado.fetchWorkItems(ctx.identity.uniqueName),
  fetchActivePRs: (ctx) => ado.fetchActivePRs(ctx.identity.id),
  fetchReviewPRs: (ctx) => ado.fetchReviewPRs(ctx.identity),
  enrichPrCI: ado.enrichPrCI,
  fetchWorkItemsForPRs: ado.fetchWorkItemsForPRs,
};

// github.ts already speaks FetchContext, so its namespace is a Provider as-is.
const githubProvider: Provider = github;

/** The backend for the given name (both are cheap singletons — no caching). */
export function getProvider(name: ProviderName): Provider {
  return name === "github" ? githubProvider : adoProvider;
}

/** Static metadata about each backend: display label + the CLI it authenticates
 *  through. Ordered by preference — with no saved choice, the first *installed*
 *  one is the default, so GitHub wins when both CLIs are present. */
export interface ProviderInfo {
  name: ProviderName;
  /** Human-facing label (title bar, provider picker). */
  label: string;
  /** The CLI the backend shells out to (`az` / `gh`). */
  cli: string;
  /** What to do when the CLI is missing (shown in the picker). */
  authHint: string;
}

export const PROVIDER_INFO: ProviderInfo[] = [
  { name: "github", label: "GitHub", cli: "gh", authHint: "install the GitHub CLI, then: gh auth login" },
  { name: "ado", label: "Azure DevOps", cli: "az", authHint: "install the Azure CLI, then: az login" },
];

/** True if the given CLI is on PATH. Bun.which just probes PATH (no process
 *  spawned); falls back to `which` under a non-Bun runtime. */
function hasCli(cli: string): boolean {
  try {
    if (typeof Bun !== "undefined" && Bun.which) return Bun.which(cli) != null;
  } catch {
    // fall through to the spawn-based probe
  }
  return spawnSync("which", [cli], { stdio: "ignore" }).status === 0;
}

/** Which backends can actually authenticate right now (their CLI is installed).
 *  Detected fresh each call — cheap, and installs can change between runs. */
export function detectProviders(): Set<ProviderName> {
  const avail = new Set<ProviderName>();
  for (const info of PROVIDER_INFO) if (hasCli(info.cli)) avail.add(info.name);
  return avail;
}

/**
 * Detect the provider implied by a path's git `origin` remote, or `null` when
 * there is nothing to force. Returns `"github"` only when the origin host is
 * github.com — handling both SSH (`git@github.com:owner/repo(.git)`) and HTTPS
 * (`https://github.com/owner/repo(.git)`) forms. An Azure DevOps remote
 * (`dev.azure.com` / `*.visualstudio.com`), any other host, a repo with no
 * `origin`, or a non-repo path all yield `null` so the configured default
 * stands. One-directional by design: we only ever *force* GitHub, never ADO.
 */
export function detectRepoProvider(path: string): ProviderName | null {
  const r = spawnSync("git", ["-C", path, "remote", "get-url", "origin"], { encoding: "utf-8" });
  if (r.status !== 0) return null; // no origin remote, or not a git repo at all
  // github.com (or GitHub's ssh.github.com SSH-over-HTTPS host) must sit
  // immediately after the scheme (`//`), an SSH user (`@`), or the string start,
  // and be delimited by an optional port then `:`/`/` — so `evilgithub.com`,
  // `github.com.example.org` don't false-positive, while
  // `ssh://git@ssh.github.com:443/owner/repo` is recognized.
  return /(?:^|@|\/\/)(?:ssh\.)?github\.com(?::\d+)?[:/]/i.test(r.stdout.trim()) ? "github" : null;
}

/** Pick the backend to start on. A `forced` provider (e.g. GitHub detected from
 *  a path context's git remote) overrides the persisted/default choice, but only
 *  when its CLI is installed — so a github repo without `gh` still falls back
 *  rather than stranding the user on an unauthenticatable backend. Otherwise: the
 *  persisted choice if its CLI is still installed, else the first installed one,
 *  else the persisted/first as a last resort (so the UI can still render and
 *  surface the "CLI not installed" hint). */
export function resolveInitialProvider(persisted?: ProviderName, forced?: ProviderName | null): ProviderName {
  const avail = detectProviders();
  if (forced && avail.has(forced)) return forced;
  if (persisted && avail.has(persisted)) return persisted;
  for (const info of PROVIDER_INFO) if (avail.has(info.name)) return info.name;
  return persisted ?? PROVIDER_INFO[0].name;
}
