// Which sessions a PR or work-item NUMBER names — and when it names more than
// one thing.
//
// `list --pr` answers for the model's whole reverse index and leaves the reader
// to look at the rows. `focus` acts on its answer, from a browser, with no cwd to
// scope by. And a number alone is not always an identity: GitHub numbers PRs and
// issues per REPOSITORY, so `#5` can be a PR in two repos at once, each with its
// own session. Picking "the most recent running one" across both would switch
// the human to the wrong repo's agent. So the matches are grouped by the entity
// they came from (its URL), and two different entities with sessions is a
// refusal, not a choice.
//
// A link's `repo=` narrows by the ENTITY's own repo — read off its URL (or a
// PR's repository name) — never by where its sessions' checkouts happen to sit:
// a clone's directory name need not be the remote repo's name, and a link from
// the PR's own page must not miss a session because of it.
//
// Azure DevOps PR URLs can name the repo by its id instead
// (`/_git/<guid>/pullrequest/N`, as notifications and the PR hub link them), so a
// `repo=` also matches a PR whose repository id it is, exactly — never by turning
// the id into a name, which would let a bare name match a same-named repo of
// another owner or project. A GUID no PR in the model answers to narrows nothing:
// ADO numbers PRs per collection, not per repo, and the ambiguity check still
// guards the choice.
import type { LoadedModel } from "../../app/model/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import type { FocusTarget } from "./url.ts";

/** One PR or work item the number matched, keyed by what makes it THAT one. */
export interface LinkedMatch {
  key: string;
  /** The entity's repo: `owner/name` on GitHub, the repo name on Azure DevOps; null when unknown. */
  repo: string | null;
  /** A PR's repository id (the ADO GUID; the `owner/name` slug on GitHub); null for a work item. */
  repoId?: string | null;
  sessions: AgentSession[];
}

type LinkedModel = Pick<LoadedModel, "linkedPrs" | "orphanPrs" | "reviewPrs" | "current" | "other" | "prLinked">;

/** A repo given by its Azure DevOps repository id rather than its name. */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Is `repo` shaped like an Azure DevOps repository id? */
export function isRepoGuid(repo: string): boolean {
  return GUID_RE.test(repo);
}

/** Does any PR in the model sit in the repo whose repository id is `id`? */
export function knowsRepoId(m: Pick<LinkedModel, "linkedPrs" | "orphanPrs" | "reviewPrs">, id: string): boolean {
  const want = id.toLowerCase();
  return [...m.linkedPrs, ...m.orphanPrs, ...m.reviewPrs].some((p) => p.repositoryId.toLowerCase() === want);
}

/**
 * `matches` narrowed to the repo a link or `--repo` named, by name or by
 * repository id (see the header). A GUID the model does not know narrows
 * nothing, so the PR is matched across every repo.
 */
export function narrowToLinkRepo(m: LinkedModel, matches: LinkedMatch[], repo: string): LinkedMatch[] {
  if (isRepoGuid(repo) && !knowsRepoId(m, repo)) return matches;
  return narrowToRepo(matches, repo);
}

/**
 * The matches whose entity is in `repo` — how a link's `repo=` narrows the
 * lookup. Two slugs must match whole; a bare name on either side matches the
 * other's name half, and a PR also matches by its repository id, exactly. An entity whose repo is unknown is kept: nothing says it is in
 * another repo, and the ambiguity check still guards the choice.
 */
export function narrowToRepo(matches: LinkedMatch[], repo: string): LinkedMatch[] {
  const id = repo.toLowerCase();
  return matches.filter((m) => m.repo === null || sameRepo(m.repo, repo) || m.repoId?.toLowerCase() === id);
}

/** Whether entity repo `have` is the `want` a link or `--repo` named, case-insensitively. */
export function sameRepo(have: string, want: string): boolean {
  const h = have.toLowerCase();
  const w = want.toLowerCase();
  if (h.includes("/") && w.includes("/")) return h === w;
  return nameOf(h) === nameOf(w);
}

/** The name half of an `owner/name`; a bare name is its own. */
function nameOf(repo: string): string {
  return repo.slice(repo.lastIndexOf("/") + 1);
}

/**
 * The repo an entity URL names: the name after `_git/` in an Azure DevOps URL,
 * else `owner/name` from a GitHub(-Enterprise) PR or issue URL; null otherwise.
 */
export function repoOfUrl(url: string): string | null {
  const ado = /\/_git\/([^/]+)\//.exec(url);
  if (ado) return ado[1];
  return /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:pull|issues)\/\d+/.exec(url)?.[1] ?? null;
}

/** Every PR / work item in the model with this number, each with its sessions. */
export function linkedMatches(m: LinkedModel, target: Exclude<FocusTarget, { kind: "session" }>): LinkedMatch[] {
  if (target.kind === "pr") {
    return [...m.linkedPrs, ...m.orphanPrs, ...m.reviewPrs]
      .filter((p) => p.id === target.id)
      .map((p) => ({ key: p.url || `repo:${p.repositoryId}`, repo: repoOfUrl(p.url) ?? p.repositoryName ?? null, repoId: p.repositoryId || null, sessions: p.sessions }));
  }
  return [...m.current, ...m.other, ...m.prLinked]
    .filter((it) => it.id === target.id)
    .map((it) => ({ key: it.url || `item:${it.id}`, repo: repoOfUrl(it.url), sessions: it.sessions }));
}

export type LinkedSessions = { sessions: AgentSession[] } | { ambiguous: string[] };

/**
 * The sessions of the ONE entity the number matched, deduped by source:id —
 * or, when entities that differ both have sessions, the keys that collided.
 * The same entity listed twice (a PR both linked and awaiting review) is one.
 */
export function resolveLinked(matches: Pick<LinkedMatch, "key" | "sessions">[]): LinkedSessions {
  const withSessions = matches.filter((m) => m.sessions.length > 0);
  const keys = [...new Set(withSessions.map((m) => m.key))];
  if (keys.length > 1) return { ambiguous: keys };
  const out = new Map<string, AgentSession>();
  for (const m of withSessions) for (const s of m.sessions) out.set(`${s.source}:${s.id}`, s);
  return { sessions: [...out.values()] };
}
