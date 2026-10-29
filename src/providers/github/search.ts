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

/** A search's alias in the query, and its variable. */
export const SEARCHES = ["involves", "reviewRequested", "authored", "owned"] as const;
export type SearchName = (typeof SEARCHES)[number];

/** The search string behind each alias. */
export function searchQueries(login: string): Record<SearchName, string> {
  return {
    involves: `is:pr is:open involves:${login}`,
    reviewRequested: `is:pr is:open review-requested:${login}`,
    authored: `is:issue is:open author:${login}`,
    owned: `is:issue is:open user:${login}`,
  };
}

// GitHub's search API stops at 1000 results, i.e. ten pages of 100.
const MAX_PAGES = 10;

const FRAGMENTS = `
fragment Page on SearchResultItemConnection {
  pageInfo { hasNextPage endCursor }
  nodes { __typename ...Pr ...Iss }
}
fragment Pr on PullRequest {
  number title url body headRefName isDraft reviewDecision mergeStateStatus createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  reviews(last: 100) { nodes { state author { login } } }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { contexts(first: 100) {
      nodes { __typename ... on CheckRun { status conclusion } ... on StatusContext { state } }
    } } } }
  }
  closingIssuesReferences(first: 25) { nodes { number } }
}
fragment Iss on Issue {
  number title state url
  author { login }
  repository { nameWithOwner }
}`;

export const SEARCH_QUERY = `query AgendoGithubSearch(${SEARCHES.map((s) => `$${s}: String!`).join(", ")}) {
${SEARCHES.map((s) => `  ${s}: search(query: $${s}, type: ISSUE, first: 100) { ...Page }`).join("\n")}
}${FRAGMENTS}`;

export const PAGE_QUERY = `query AgendoGithubSearchPage($q: String!, $after: String!) {
  page: search(query: $q, type: ISSUE, first: 100, after: $after) { ...Page }
}${FRAGMENTS}`;

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

/** One GraphQL node in the flat shape the rest of the provider reads, or null for a node that is neither. */
export function normalise(node: any): RawItem | null {
  const slug = node?.repository?.nameWithOwner;
  if (!slug) return null;
  if (node.__typename === "Issue") {
    const { repository: _, ...issue } = node;
    return { ...issue, slug };
  }
  if (node.__typename !== "PullRequest") return null;
  const { repository: _, commits, reviews, closingIssuesReferences, ...pr } = node;
  return {
    ...pr,
    slug,
    reviews: reviews?.nodes ?? [],
    statusCheckRollup: commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [],
    closingIssuesReferences: closingIssuesReferences?.nodes ?? [],
  };
}

/** Runs one GraphQL operation with string variables and returns its `data`. */
export type GraphqlRun = (query: string, vars: Record<string, string>) => Promise<any>;

/** Every node of one search: the first page as given, then the rest one request at a time. */
async function drain(run: GraphqlRun, q: string, first: SearchPage | undefined): Promise<any[]> {
  const nodes = [...(first?.nodes ?? [])];
  let page = first;
  for (let n = 1; n < MAX_PAGES && page?.pageInfo?.hasNextPage && page.pageInfo.endCursor; n++) {
    page = (await run(PAGE_QUERY, { q, after: page.pageInfo.endCursor }))?.page as SearchPage | undefined;
    nodes.push(...(page?.nodes ?? []));
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
    SEARCHES.map((s) => drain(run, queries[s], data[s])),
  );
  return { involves: items(involves), reviewRequested: items(reviewRequested), issues: items([...authored, ...owned]) };
}

/** The `gh api graphql` argv for one operation. */
export function graphqlArgs(query: string, vars: Record<string, string>): string[] {
  return ["api", "graphql", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])];
}
