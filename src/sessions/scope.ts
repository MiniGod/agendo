import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { parseGithubRemote } from "../github.ts";
import { repoRootForCwd } from "../repos.ts";
import { basename } from "path";
import type { AgentSession } from "../types.ts";

// ── Repo scoping for forWorkItem ─────────────────────────────────────────────
// The scope comparison must happen in ONE identity domain. The obvious-looking
// shortcut — compare the wanted repo's bare name against the basename of the
// session's checkout directory — silently mixes two domains: a REMOTE repo name
// and a LOCAL directory name. Those agree only when the clone happens to be
// named after the remote (`owner/web-app` cloned into `~/projects/frontend`, a
// second checkout `~/git/agendo-copy`, or a worktree outside
// `<root>/.claude/worktrees/` that repos.ts resolves to its own dir all break
// it), and even when they do agree the owner is thrown away, so a fork
// (`alice/tool` vs `bob/tool`) still cross-matches. So we resolve BOTH sides to
// `owner/repo` slugs via the `origin` remote whenever we can, and only fall back
// to bare-name comparison when a side has no resolvable GitHub slug.

/** A repo identifier reduced to both comparison forms: the full lowercased
 *  `owner/repo` slug (null when the caller passed a bare name) and the bare
 *  lowercased repo name (always present, used as the fallback domain). */
interface RepoScope {
  slug: string | null;
  bare: string;
}

export function repoScope(repo: string): RepoScope {
  const r = repo.trim().toLowerCase();
  return { slug: r.includes("/") ? r : null, bare: bareRepoName(r) };
}

/** Reduce a repo identifier (an `owner/repo` slug or a bare name) to its bare,
 *  lowercased repo name, for repo-scoped matching. */
function bareRepoName(repo: string): string {
  return (repo.includes("/") ? repo.split("/").pop()! : repo).toLowerCase();
}

// Repo root → lowercased `owner/repo` slug (or null when the root has no
// resolvable github.com origin). Mirrors repoRef()'s cache in github.ts and
// exists for the same reason, only more acutely: forWorkItem runs once per work
// item inside loadModel and walks EVERY indexed session, so without memoization
// a single refresh would re-spawn `git` hundreds of times. A repo root's origin
// doesn't move under us during a process lifetime, so a plain unbounded Map
// keyed by root (not by cwd — worktrees of one repo share a root) is enough.
// NOTE: nothing on the fast paths (SessionIndex.build, loadLocalSessions) may
// reach this. The two entry points are the repo-scoped forWorkItem call and
// `repoScopeFilter` (the CLI's `--repo` selector) — and both only get here when
// the WANTED repo is a full `owner/repo` slug, so the common bare-name case
// still costs no process spawn at all.
const rootSlugCache = new Map<string, string | null>();

function repoSlugForRoot(root: string): string | null {
  const cached = rootSlugCache.get(root);
  if (cached !== undefined) return cached;
  let slug: string | null = null;
  // existsSync first: we routinely index sessions whose cwd is long gone
  // (deleted worktrees, moved checkouts), and `git -C <missing>` would cost a
  // doomed process spawn each. A missing root simply has no slug → fallback.
  if (existsSync(root)) {
    const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
    if (r.status === 0) {
      const parsed = parseGithubRemote(r.stdout);
      if (parsed) slug = `${parsed.owner}/${parsed.repo}`.toLowerCase();
    }
  }
  rootSlugCache.set(root, slug);
  return slug;
}

// One candidate identity (the session's checkout, or the recorded `repository`
// of a Copilot/Codex session) against the wanted scope: full slugs when BOTH sides have one,
// bare names otherwise. Comparing slugs is what rejects same-named forks;
// falling back to bare names is what keeps non-GitHub, remote-less, and
// no-longer-on-disk checkouts matching at all.
function identityMatches(scope: RepoScope, slug: string | null, bare: string): boolean {
  return scope.slug && slug ? slug === scope.slug : bare === scope.bare;
}

/**
 * The reusable form of the match below, for the CLI's `--repo` selector
 * (`agendo list/status/wait --repo <name>`): parse the wanted repo ONCE and hand
 * back a predicate. Sharing it with `forWorkItem` is the point — a `--repo` that
 * disagreed with the work-item↔session join about which sessions live in a repo
 * would be its own bug class.
 *
 * `repo` is a bare name or an `owner/repo` slug; the slug form makes this shell
 * out to `git remote get-url origin` once per repo root (memoized), so prefer
 * the bare name on hot paths.
 */
export function repoScopeFilter(repo: string): (s: AgentSession) => boolean {
  const scope = repoScope(repo);
  return (s) => sessionInScope(s, scope);
}

/** Whether a session belongs to the wanted repo, for the repo-scoped
 *  work-item↔session join. */
export function sessionInScope(s: AgentSession, scope: RepoScope): boolean {
  const root = repoRootForCwd(s.cwd);
  // Only shell out when the wanted repo is a full slug: against a bare wanted
  // name there is no owner to compare, so the resolution could not change the
  // answer and the git call would be pure waste.
  const rootSlug = scope.slug ? repoSlugForRoot(root) : null;
  if (identityMatches(scope, rootSlug, basename(root).toLowerCase())) return true;
  // Copilot and Codex record the remote repo they were launched against, already
  // reduced to the remote domain — no git call needed, and it's the only signal
  // for such a session whose cwd no longer exists.
  if (s.repository) {
    const recorded = s.repository.trim().toLowerCase();
    const slug = recorded.includes("/") ? recorded : null;
    if (identityMatches(scope, slug, bareRepoName(recorded))) return true;
  }
  return false;
}

