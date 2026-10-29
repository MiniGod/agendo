// Everything agendo shows from GitHub, in one GraphQL request.
//
// It used to be four `gh issue list` / `gh pr list` calls per repo, for every
// repo any local session had touched — 84 calls and ~114 rate-limit points for
// 21 repos, on every load. These four searches span all of GitHub instead, cost
// a handful of points together, and are narrowed to the repos in scope by the
// caller:
//
//   involves         open PRs involving you — yours, and the ones linked to issues
//   reviewRequested  open PRs asking for your review (not covered by `involves:`)
//   authored         open issues you filed, anywhere
//   owned            open issues in repos you own
//
// `authored` ∪ `owned` is exactly what the per-repo calls fetched: every issue
// in a repo you own, and only your own in a repo you don't.
//
// Each node is normalised to the shape `gh pr list --json …` printed, so the
// mapping downstream (mapPR, rollupCI, latestVotes) reads it unchanged.
import { reportWarning } from "../../shared/errors.ts";

/** A search's alias in the query, and its variable. */
export const SEARCHES = ["involves", "reviewRequested", "authored", "owned"] as const;
export type SearchName = (typeof SEARCHES)[number];

const PR_SEARCHES: ReadonlySet<SearchName> = new Set(["involves", "reviewRequested"]);

/**
 * The search string behind each alias. Newest activity first: GitHub stops at
 * 1000 results, and past that the ones dropped should be the stalest rather
 * than an arbitrary best-match cut.
 */
export function searchQueries(login: string): Record<SearchName, string> {
  return {
    involves: `is:pr is:open involves:${login} sort:updated-desc`,
    reviewRequested: `is:pr is:open review-requested:${login} sort:updated-desc`,
    authored: `is:issue is:open author:${login} sort:updated-desc`,
    owned: `is:issue is:open user:${login} sort:updated-desc`,
  };
}

// GitHub's search API stops at 1000 results. A PR carries its reviews and
// checks, so it is asked for in pages of 50 to keep one request light; an
// issue is a handful of scalars.
const RESULT_CAP = 1000;
const PR_PAGE = 50;
const ISSUE_PAGE = 100;

// GitHub refuses a fragment that is declared but not used, so each query
// carries only the fragments it spreads.
const PR_FRAGMENTS = `
fragment PrPage on SearchResultItemConnection {
  pageInfo { hasNextPage endCursor }
  nodes { __typename ...Pr }
}
fragment Pr on PullRequest {
  number title url body headRefName isDraft reviewDecision mergeStateStatus createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  reviews(last: 50) { nodes { state author { login } } }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { contexts(first: 100) {
      nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } }
    } } } }
  }
  closingIssuesReferences(first: 25) { nodes { number } }
}`;
const ISSUE_FRAGMENTS = `
fragment IssuePage on SearchResultItemConnection {
  pageInfo { hasNextPage endCursor }
  nodes { __typename ...Iss }
}
fragment Iss on Issue {
  number title state url
  author { login }
  repository { nameWithOwner }
}`;

const isPrSearch = (s: SearchName) => PR_SEARCHES.has(s);

/** One search's selection: PR pages carry the PR fields, issue pages only the issue ones. */
const selection = (s: SearchName, args: string) =>
  `search(${args}, type: ISSUE, first: ${isPrSearch(s) ? PR_PAGE : ISSUE_PAGE}) { ...${isPrSearch(s) ? "PrPage" : "IssuePage"} }`;

export const SEARCH_QUERY = `query AgendoGithubSearch(${SEARCHES.map((s) => `$${s}: String!`).join(", ")}) {
${SEARCHES.map((s) => `  ${s}: ${selection(s, `query: $${s}`)}`).join("\n")}
}${PR_FRAGMENTS}${ISSUE_FRAGMENTS}`;

/** The follow-up page of a PR search, and of an issue search. */
export const PAGE_QUERIES = {
  pr: `query AgendoGithubPrPage($q: String!, $after: String!) {
  page: ${selection("involves", "query: $q, after: $after")}
}${PR_FRAGMENTS}`,
  issue: `query AgendoGithubIssuePage($q: String!, $after: String!) {
  page: ${selection("authored", "query: $q, after: $after")}
}${ISSUE_FRAGMENTS}`,
};

/** A PR or an issue, as `gh pr list` / `gh issue list --json` printed it, plus the repo it lives in. */
export type RawItem = Record<string, any> & { slug: string };

export interface AccountData {
  /** Open PRs involving you. */
  involves: RawItem[];
  /** Open PRs awaiting your review. */
  reviewRequested: RawItem[];
  /** Open issues you filed anywhere, plus every open issue in a repo you own; deduped. */
  issues: RawItem[];
}

interface SearchPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: any[];
}

/** A PR node in the flat shape `gh pr list --json` printed. */
function flatPr({ repository: _, commits, reviews, closingIssuesReferences, ...pr }: any, slug: string): RawItem {
  return {
    ...pr,
    slug,
    reviews: reviews?.nodes ?? [],
    statusCheckRollup: commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [],
    closingIssuesReferences: closingIssuesReferences?.nodes ?? [],
  };
}

/** One GraphQL node in the flat shape the rest of the provider reads, or null for a node that is neither a PR nor an issue. */
export function normalise(node: any): RawItem | null {
  const slug = node?.repository?.nameWithOwner;
  if (!slug) return null;
  if (node.__typename === "PullRequest") return flatPr(node, slug);
  if (node.__typename !== "Issue") return null;
  const { repository: _, ...issue } = node;
  return { ...issue, slug };
}

/** Runs one GraphQL operation with string variables and returns its `data`. */
export type GraphqlRun = (query: string, vars: Record<string, string>) => Promise<any>;

/** Every node of one search, up to GitHub's cap: the first page as given, then the rest one request at a time. */
async function drain(run: GraphqlRun, name: SearchName, q: string, first: SearchPage | undefined): Promise<any[]> {
  const nodes = [...(first?.nodes ?? [])];
  const query = isPrSearch(name) ? PAGE_QUERIES.pr : PAGE_QUERIES.issue;
  // Counted in pages, not nodes: a page can come back short (a node GitHub
  // would not show is null), and a short page must not buy an extra request.
  const pages = RESULT_CAP / (isPrSearch(name) ? PR_PAGE : ISSUE_PAGE);
  let page = first;
  let fetched = 1;
  for (; page?.pageInfo?.hasNextPage && page.pageInfo.endCursor && fetched < pages; fetched++) {
    page = (await run(query, { q, after: page.pageInfo.endCursor }))?.page as SearchPage | undefined;
    nodes.push(...(page?.nodes ?? []));
  }
  if (page?.pageInfo?.hasNextPage && fetched >= pages) {
    reportWarning(`GitHub search "${q}" has more than ${RESULT_CAP} results; showing the ${RESULT_CAP} most recently updated`);
  }
  return nodes;
}

/** Items normalised, deduped by repo and number, the first sighting kept. */
function items(nodes: any[]): RawItem[] {
  const seen = new Set<string>();
  const out: RawItem[] = [];
  for (const node of nodes) {
    const item = normalise(node);
    const key = item && `${item.slug.toLowerCase()}#${item.number}`;
    if (!item || seen.has(key!)) continue;
    seen.add(key!);
    out.push(item);
  }
  return out;
}

/** The four searches for `login`: one request, plus one per page past the first hundred results of any of them. */
export async function searchAccount(run: GraphqlRun, login: string): Promise<AccountData> {
  const queries = searchQueries(login);
  const data = (await run(SEARCH_QUERY, queries)) ?? {};
  const [involves, reviewRequested, authored, owned] = await Promise.all(
    SEARCHES.map((s) => drain(run, s, queries[s], data[s])),
  );
  return { involves: items(involves), reviewRequested: items(reviewRequested), issues: items([...authored, ...owned]) };
}

/** The `gh api graphql` argv for one operation. */
export function graphqlArgs(query: string, vars: Record<string, string>): string[] {
  return ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
}
