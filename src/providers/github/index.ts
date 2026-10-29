// GitHub access layer. Mirrors the surface of ado.ts but talks to GitHub
// through the `gh` CLI (so it reuses the user's existing `gh auth login` — no
// token handling here). Active when the GitHub backend is selected in the UI.
//
// GitHub has no "team current iteration", so the two item buckets are by
// authorship instead: issues you created vs. other open issues in repos you own
// (see fetchWorkItems). Scope is the set of repos discovered from your local
// agent sessions (see repos.ts), each resolved to an `owner/repo` slug via its
// `origin` remote; repos whose origin isn't a github.com remote are skipped.
// Issue↔PR links come from closing references, "#N" mentions, or the issue id
// embedded in the PR branch (see linkedIssues).
//
// The data itself is one account-wide GraphQL search (search.ts) narrowed to
// that scope here, and shared, cached and rate-limit aware (throttle.ts): every
// load in the process reuses it for minutes, not just the one that fetched it.
import { spawn, spawnSync } from "child_process";
import { rollupCI } from "./ci.ts";
import { canonicalSlugs } from "./canonical.ts";
import { gh, partialData } from "./gh.ts";
import { reportWarning } from "../../shared/errors.ts";
import { type AccountData, type GraphqlRun, type RawItem, graphqlArgs, searchAccount } from "./search.ts";
import { Throttle } from "./throttle.ts";
import type { RepoInfo } from "../../repositories/index.ts";
import type { EntityUrls, FetchContext } from "../index.ts";
import type {
  Identity,
  PullRequest,
  ReviewPR,
  TeamMember,
  WorkItem,
} from "../../shared/types.ts";

// ── The account's searches, shared and throttled ──────────────────────────────
// GitHub refuses a query that costs more than what is left, so a budget that is
// merely LOW counts as spent; well above any one load's cost, well below a
// budget a secondary limit would leave.
const LOW_BUDGET = 100;

/** GitHub's GraphQL reset time (epoch ms) when its primary budget is (nearly) spent; null otherwise. `gh api rate_limit` is free. */
async function graphqlResetAt(): Promise<number | null> {
  const graphql = (await gh(["api", "rate_limit"]))?.resources?.graphql;
  return graphql && graphql.remaining < LOW_BUDGET ? graphql.reset * 1000 : null;
}

/** A GraphQL runner that keeps whatever data came back alongside errors (see partialData). */
const graphqlRunner = (onErrors: (first: string) => void): GraphqlRun => async (query, vars) => {
  try {
    return (await gh(graphqlArgs(query, vars)))?.data;
  } catch (e) {
    return partialData(e, onErrors);
  }
};

const searchRun = graphqlRunner((first) =>
  reportWarning(`GitHub left part of its answer out (${first}); showing the rest`, { always: true }));

/** Keyed by login: one search per account serves every repo scope (see throttle.ts). */
const account = new Throttle<AccountData>({ fetch: (login) => searchAccount(searchRun, login), resetAt: graphqlResetAt });

// A repo GitHub won't show is answered with an error beside the others, which
// is expected here, not news: it simply keeps its origin's name.
const reposRun = graphqlRunner(() => {});

/** Keyed by the scope's slugs: their current names (see canonical.ts). Never fails, so never hammers. */
const canonical = new Throttle<Map<string, string>>({
  fetch: (key) => canonicalSlugs(reposRun, key ? key.split(" ") : []),
  resetAt: graphqlResetAt,
});

/** Make the next load ask GitHub again rather than reuse the last answer. The menu calls it on every reload it makes. */
export function invalidate(): void {
  account.invalidate();
}

// ── Repo scope: local repo roots → owner/repo slugs ───────────────────────────
export interface RepoRef {
  owner: string;
  repo: string;
  /** Local checkout root the slug was derived from. */
  root: string;
}

const refCache = new Map<string, RepoRef | null>();

/**
 * Parse a git `origin` URL into a github.com `owner/repo`, or null when it isn't
 * a GitHub remote. The github.com host (or GitHub's `ssh.github.com` SSH-over-
 * HTTPS host) must sit right after the scheme `//`, an SSH `user@`, or the string
 * start, so a look-alike host is rejected: `mygithub.com` (no anchor before
 * `github.com`) and `github.com.evil.org` (github.com not delimited by a port,
 * `:`, or `/`) both yield null. Port-aware, so `ssh://git@ssh.github.com:443/
 * owner/repo` yields owner=`owner` (not `443`), and case-insensitive so
 * `GitHub.com` parses. Handles the SSH (`git@github.com:owner/repo(.git)`),
 * HTTPS (`https://github.com/owner/repo(.git)`), and `ssh://` forms.
 *
 * Parsing stops at the repo segment, so anything trailing it is ignored: a
 * remote never has a trailing path, but a *web* URL pasted by a user does
 * (`…/owner/repo/tree/main/src`, `…/owner/repo/pull/12`), and clone.ts feeds
 * those through here to get the same host anchoring rather than a second,
 * looser regex.
 */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = url
    .trim()
    .match(/(?:^|@|\/\/)(?:ssh\.)?github\.com(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Resolve a checkout's `origin` remote to a github.com owner/repo, or null. */
function repoRef(root: string): RepoRef | null {
  if (refCache.has(root)) return refCache.get(root)!;
  let ref: RepoRef | null = null;
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf-8" });
  if (r.status === 0) {
    const parsed = parseGithubRemote(r.stdout);
    if (parsed) ref = { ...parsed, root };
  }
  refCache.set(root, ref);
  return ref;
}

/** Distinct github.com slugs across the discovered repos (deduped, owner/repo). */
function reposToRefs(repos: RepoInfo[]): RepoRef[] {
  const seen = new Set<string>();
  const refs: RepoRef[] = [];
  for (const r of repos) {
    const ref = repoRef(r.root);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

const slugOf = (ref: RepoRef) => `${ref.owner}/${ref.repo}`;

// ── Canonical web URLs ────────────────────────────────────────────────────────
// The one place GitHub entity links are built. Scope is github.com by
// construction: `parseGithubRemote` only ever yields github.com slugs, so a repo
// on another host never reaches these. Pure, so the exact strings can be pinned
// in tests.

/** Percent-encode each segment of an `owner/repo` slug (the separator stays). */
const encodeSlug = (slug: string) => slug.split("/").map(encodeURIComponent).join("/");

/** Web URL of a pull request in `owner/repo`. */
export function githubPullRequestUrl(slug: string, id: number): string {
  return `https://github.com/${encodeSlug(slug)}/pull/${id}`;
}

/** Web URL of an issue in `owner/repo` (GitHub's work-item equivalent). */
export function githubIssueUrl(slug: string, id: number): string {
  return `https://github.com/${encodeSlug(slug)}/issues/${id}`;
}

/** Entity URLs for this backend (see Provider.urls). GitHub numbers issues and
 *  PRs per repo, so both need the owning slug — without one there is no URL to
 *  build, and null is returned rather than a plausible-looking wrong link. */
export const urls: EntityUrls = {
  // `repositoryId` IS the `owner/repo` slug on this backend (see mapPR).
  pullRequest: (ref) => (ref.repositoryId ? githubPullRequestUrl(ref.repositoryId, ref.id) : null),
  // …and a WorkItem's `project` is the slug of the repo the issue lives in.
  workItem: (ref) => (ref.project ? githubIssueUrl(ref.project, ref.id) : null),
};

// ── PR mapping ────────────────────────────────────────────────────────────────
// Each PR arrives with its reviews and status-check rollup (see search.ts), so
// votes and CI need no second round-trip and enrichPrCI is a no-op. Its `body`
// comes along too, so "#N" mentions in the description count as links.

/**
 * Which of `issueNums` a PR is linked to. GitHub's own "closing references" only
 * exist once someone writes `Closes #N`, which is too strict to be the only
 * signal — so we also link on a bare `#N` mention anywhere in the title/body and
 * on the issue id embedded in the PR's branch (the launcher names work branches
 * `worktree-…-<id>`, the same convention sessions are matched by). The result is
 * that a PR shows under its issue while both are open, no closing keyword needed.
 */
function linkedIssues(raw: any, issueNums: Set<number>): Set<number> {
  const out = new Set<number>();
  for (const r of raw.closingIssuesReferences ?? []) {
    if (issueNums.has(r.number)) out.add(r.number);
  }
  const text = `${raw.title ?? ""}\n${raw.body ?? ""}`;
  for (const m of text.matchAll(/#(\d+)/g)) {
    const n = Number(m[1]);
    if (issueNums.has(n)) out.add(n);
  }
  const branch = raw.headRefName ?? "";
  for (const n of issueNums) {
    // Same id-in-branch test sessions use (id delimited by non-digits).
    if (new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(branch)) out.add(n);
  }
  return out;
}

// Aggregate a PR's check rollup into a single gate status. CheckRuns carry
// status+conclusion; legacy StatusContexts carry a single `state`. A merge
// conflict (mergeStateStatus "DIRTY") outranks any individual check.
// Net review votes: the latest non-comment review per author. GitHub doesn't
// expose the branch-protection required count cheaply, so we approximate the
// gate from reviewDecision (any decision ⇒ at least one approval is required).
/** Review states that are not votes. */
const NON_VOTES = new Set(["COMMENTED", "PENDING", "DISMISSED"]);

/** Net review votes: the latest non-comment review per author. Reviews are chronological, so the last meaningful vote wins. */
export function latestVotes(reviews: any[] | undefined): Map<string, string> {
  const latest = new Map<string, string>(); // login → latest meaningful state
  for (const r of reviews ?? []) {
    const login = r.author?.login;
    if (!login || NON_VOTES.has(r.state)) continue;
    latest.set(login, r.state);
  }
  return latest;
}

function countVotes(latest: Map<string, string>): { approvals: number; rejections: number } {
  let approvals = 0, rejections = 0;
  for (const s of latest.values()) {
    if (s === "APPROVED") approvals++;
    else if (s === "CHANGES_REQUESTED") rejections++;
  }
  return { approvals, rejections };
}

/**
 * `requiredCount` here is a LOWER BOUND, not a measurement. GitHub reports
 * `reviewDecision` (non-null ⇔ the base branch requires review) but not how
 * many approvals that takes — the number lives in branch protection /
 * rulesets, behind a second per-branch call agendo deliberately doesn't make.
 * 1 is the smallest gate that can produce a decision, so "0/1" and "1/1" read
 * correctly at the boundary that matters, and it is what the X/Y column shows.
 *
 * What must NOT rest on it is the verdict. Comparing 2 approvals against a
 * floor of 1 would call a two-approval gate satisfied at one; `gateMet`
 * carries GitHub's own answer so nothing has to guess.
 *
 * The `Math.max(1, …)` is load-bearing, not defensive tidying. A decision of
 * APPROVED with `approvals` counted as 0 is a real shape — the approving
 * review can be older than the page of reviews `gh` returned, or dismissed
 * and re-approved outside it — and it would render a GREEN "✓ 0/1": gate met,
 * nobody approved. Flooring the count at 1 is the only thing that makes that
 * cell unreachable. Don't remove it without giving the renderers another way
 * to reconcile the two (src/ui/format/index.ts approvalProgress).
 */
export function reviewGate(reviewDecision: string | undefined, approvals: number): { approvedCount: number; requiredCount: number; gateMet: boolean | undefined } {
  const requiredCount = reviewDecision ? 1 : 0;
  const gateMet = reviewDecision ? reviewDecision === "APPROVED" : undefined;
  const approvedCount = reviewDecision === "APPROVED" ? Math.max(1, approvals) : approvals;
  return { approvedCount, requiredCount, gateMet };
}

/** Exported for the unit suite. */
export function voteSummary(reviews: any[] | undefined, reviewDecision: string | undefined) {
  const { approvals, rejections } = countVotes(latestVotes(reviews));
  return { approvals, rejections, waiting: 0, ...reviewGate(reviewDecision, approvals) };
}

function mapPR(raw: any, ref: RepoRef): PullRequest {
  const slug = slugOf(ref);
  const createdDate = raw.createdAt ? new Date(raw.createdAt).getTime() : 0;
  const updatedDate = raw.updatedAt ? new Date(raw.updatedAt).getTime() : createdDate;
  return {
    id: raw.number,
    title: raw.title ?? "",
    status: "active", // only open PRs are fetched
    branch: raw.headRefName ?? "",
    repositoryId: slug,
    repositoryName: ref.repo,
    isDraft: !!raw.isDraft,
    ci: rollupCI(raw.statusCheckRollup, raw.mergeStateStatus),
    createdDate,
    updatedDate,
    // Built through `urls`, not taken from `raw.url`, so every PR link in the
    // app comes out of the one provider-level entry point (gh returns the
    // identical string for github.com). A slug is always present here.
    url: urls.pullRequest({ id: raw.number, repositoryId: slug }) ?? "",
    ...voteSummary(raw.reviews, raw.reviewDecision),
  };
}

/** Whether `gh` is authenticated (`gh auth status` exits 0 when logged in) —
 *  the auth probe for the Settings page. Never throws; false on any failure. */
export function checkAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

// ── Identities ────────────────────────────────────────────────────────────────
let cachedMe: Identity | null = null;

/** The authenticated `gh` user. login doubles as the id/uniqueName. */
export async function getMe(): Promise<Identity> {
  if (cachedMe) return cachedMe;
  const u = await gh(["api", "user"]);
  cachedMe = {
    id: u.login,
    displayName: u.name || u.login,
    uniqueName: u.login,
  };
  return cachedMe;
}

/**
 * GitHub has no "configured team" roster equivalent, so the identity switcher
 * just offers the authenticated user. (model.ts always includes `me` anyway.)
 */
export async function getTeamMembers(): Promise<TeamMember[]> {
  return [await getMe()];
}

// ── Work items (GitHub issues) ────────────────────────────────────────────────
// GitHub has no sprint, and solo OSS work rarely uses issue assignment, so the
// two item buckets are by authorship instead: issues you opened (inCurrentSprint
// = true → the primary "Created by me" section) vs. other open issues in repos
// you own (the collapsible "In your repos" section). For repos you *don't* own
// we only surface issues you opened, to avoid dumping a foreign tracker.
export async function fetchWorkItems(ctx: FetchContext): Promise<{
  items: Omit<WorkItem, "sessions">[];
  currentIterationPath: string | null;
}> {
  const login = ctx.identity.id;
  const [{ issues, involves }, scoped] = await Promise.all([account.get(login), inScope(ctx)]);
  const prsByRepo = scoped(involves);

  const items: Omit<WorkItem, "sessions">[] = [];
  for (const [ref, repoIssues] of scoped(issues)) {
    const slug = slugOf(ref);
    // Map issue number → PRs linked to it (closing ref, #N mention, or branch).
    const issueNums = new Set<number>(repoIssues.map((i) => i.number));
    const prsByIssue = new Map<number, PullRequest[]>();
    for (const raw of prsByRepo.get(ref) ?? []) {
      const pr = mapPR(raw, ref);
      for (const n of linkedIssues(raw, issueNums)) prsByIssue.set(n, [...(prsByIssue.get(n) ?? []), pr]);
    }
    for (const iss of repoIssues) {
      items.push({
        id: iss.number,
        type: "Issue",
        title: iss.title ?? "",
        state: iss.state ?? "OPEN",
        boardColumn: undefined,
        iterationPath: "",
        project: slug,
        // Authorship drives the two buckets (see header comment).
        inCurrentSprint: isMe(login, iss.author?.login),
        prs: prsByIssue.get(iss.number) ?? [],
        url: urls.workItem({ id: iss.number, project: slug }) ?? "",
      });
    }
  }

  // GitHub has no iteration path; the primary section header stays unlabeled.
  return { items, currentIterationPath: null };
}

const isMe = (login: string, l: string | undefined) => !!l && l.toLowerCase() === login.toLowerCase();

/**
 * The account-wide search results narrowed to the repos in scope, grouped by
 * the scope's own RepoRef — so slugs keep the casing of the local `origin`, as
 * they did when each repo was queried by name. A result is matched on the
 * repo's CURRENT name, which a renamed or transferred repo's origin may not
 * carry (see canonical.ts).
 */
async function inScope(ctx: FetchContext): Promise<(items: RawItem[]) => Map<RepoRef, RawItem[]>> {
  const refs = reposToRefs(ctx.repos);
  const slugs = refs.map(slugOf).sort();
  const current = await canonical.get(slugs.join(" "));
  const bySlug = new Map(refs.map((ref) => {
    const slug = slugOf(ref).toLowerCase();
    return [current.get(slug) ?? slug, ref];
  }));
  return (items) => {
    const out = new Map<RepoRef, RawItem[]>();
    for (const item of items) {
      const ref = bySlug.get(item.slug.toLowerCase());
      if (ref) out.set(ref, [...(out.get(ref) ?? []), item]);
    }
    return out;
  };
}

// ── PRs you created ───────────────────────────────────────────────────────────
export async function fetchActivePRs(ctx: FetchContext): Promise<PullRequest[]> {
  const login = ctx.identity.id;
  const [{ involves }, scoped] = await Promise.all([account.get(login), inScope(ctx)]);
  return [...scoped(involves)].flatMap(([ref, raw]) =>
    raw.filter((p) => isMe(login, p.author?.login)).map((p) => mapPR(p, ref)));
}

// ── PRs awaiting your review ──────────────────────────────────────────────────
export async function fetchReviewPRs(ctx: FetchContext): Promise<ReviewPR[]> {
  const login = ctx.identity.id;
  const [{ reviewRequested }, scoped] = await Promise.all([account.get(login), inScope(ctx)]);
  return [...scoped(reviewRequested)].flatMap(([ref, raw]) => raw
    // Don't surface your own PRs in your review queue.
    .filter((p) => !isMe(login, p.author?.login))
    .map((p): ReviewPR => ({ ...mapPR(p, ref), reviewReason: "you" })));
}

/**
 * No-op for GitHub: CI status, votes, and last-update time are already filled in
 * at fetch time (from statusCheckRollup / reviews / updatedAt). Kept to satisfy
 * the Provider interface.
 */
export async function enrichPrCI(_prs: PullRequest[]): Promise<void> {}

/**
 * No-op for GitHub. GitHub has no PR→work-item artifact link to resolve issues
 * *from* a PR; issue↔PR links are computed the other way (in fetchWorkItems via
 * closing references / "#N" mentions / branch ids), so orphan PRs simply stay
 * orphans. Kept to satisfy the Provider interface.
 */
export async function fetchWorkItemsForPRs(
  _prs: PullRequest[],
  _opts: { excludeWorkItemIds: Set<number>; currentIterationPath: string | null },
): Promise<{ items: Omit<WorkItem, "sessions">[]; surfacedPrIds: Set<number> }> {
  return { items: [], surfacedPrIds: new Set() };
}
