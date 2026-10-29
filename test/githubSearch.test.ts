// The GitHub provider's one account-wide search (src/providers/github/search.ts).
// The e2e fake answers it from per-repo fixtures in a single page, so it never
// paginates, never repeats an item across the two issue searches, and never
// hands back a node that is neither a PR nor an issue.
import { describe, expect, test } from "bun:test";
import {
  PAGE_QUERY, SEARCH_QUERY, type GraphqlRun, graphqlArgs, normalise, searchAccount, searchQueries,
} from "../src/providers/github/search.ts";

const pr = (slug: string, number: number, extra: Record<string, unknown> = {}) => ({
  __typename: "PullRequest", number, title: `PR ${number}`, repository: { nameWithOwner: slug }, ...extra,
});
const issue = (slug: string, number: number) => ({
  __typename: "Issue", number, title: `Issue ${number}`, state: "OPEN", repository: { nameWithOwner: slug },
});
const page = (nodes: unknown[], endCursor: string | null = null) => ({
  pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes,
});

describe("normalise", () => {
  test("a PR comes out in `gh pr list --json`'s shape", () => {
    const node = pr("ada/app", 7, {
      reviews: { nodes: [{ state: "APPROVED", author: { login: "grace" } }] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
      closingIssuesReferences: { nodes: [{ number: 3 }] },
    });
    expect(normalise(node)).toEqual({
      __typename: "PullRequest", number: 7, title: "PR 7", slug: "ada/app",
      reviews: [{ state: "APPROVED", author: { login: "grace" } }],
      statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
      closingIssuesReferences: [{ number: 3 }],
    });
  });

  test("a PR with no commits, checks or reviews has empty lists, not holes", () => {
    const out = normalise(pr("ada/app", 7, { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }))!;
    expect(out.reviews).toEqual([]);
    expect(out.statusCheckRollup).toEqual([]);
    expect(out.closingIssuesReferences).toEqual([]);
  });

  test("an issue keeps its fields and gains its slug", () => {
    expect(normalise(issue("ada/app", 3))).toEqual({ __typename: "Issue", number: 3, title: "Issue 3", state: "OPEN", slug: "ada/app" });
  });

  test("anything else — another type, no repository, nothing — is dropped", () => {
    expect(normalise({ __typename: "Discussion", repository: { nameWithOwner: "ada/app" } })).toBeNull();
    expect(normalise({ __typename: "Issue", number: 1 })).toBeNull();
    expect(normalise(null)).toBeNull();
  });
});

describe("searchAccount", () => {
  test("one request for all four searches when each fits a page", async () => {
    const calls: Array<[string, Record<string, string>]> = [];
    const run: GraphqlRun = async (query, vars) => {
      calls.push([query, vars]);
      return {
        involves: page([pr("ada/app", 1)]),
        reviewRequested: page([pr("bob/lib", 2)]),
        authored: page([issue("bob/lib", 5)]),
        owned: page([issue("ada/app", 6)]),
      };
    };
    const data = await searchAccount(run, "ada");
    expect(calls).toEqual([[SEARCH_QUERY, searchQueries("ada")]]);
    expect(data.involves.map((p) => p.number)).toEqual([1]);
    expect(data.reviewRequested.map((p) => p.number)).toEqual([2]);
    expect(data.issues.map((i) => `${i.slug}#${i.number}`)).toEqual(["bob/lib#5", "ada/app#6"]);
  });

  test("an issue both authored and in an owned repo is listed once", async () => {
    const run: GraphqlRun = async () => ({
      involves: page([]), reviewRequested: page([]),
      authored: page([issue("ada/app", 5)]), owned: page([issue("Ada/App", 5), issue("ada/app", 6)]),
    });
    expect((await searchAccount(run, "ada")).issues.map((i) => i.number)).toEqual([5, 6]);
  });

  test("a search past its first page is followed, cursor by cursor, on its own", async () => {
    const pages: Record<string, unknown> = {
      c1: page([pr("ada/app", 2)], "c2"),
      c2: page([pr("ada/app", 3)]),
    };
    const followed: Array<Record<string, string>> = [];
    const run: GraphqlRun = async (query, vars) => {
      if (query === PAGE_QUERY) {
        followed.push(vars);
        return { page: pages[vars.after!] };
      }
      return { involves: page([pr("ada/app", 1)], "c1"), reviewRequested: page([]), authored: page([]), owned: page([]) };
    };
    const data = await searchAccount(run, "ada");
    expect(data.involves.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(followed).toEqual([{ q: searchQueries("ada").involves, after: "c1" }, { q: searchQueries("ada").involves, after: "c2" }]);
  });

  test("pagination stops at GitHub's thousand-result cap even if told there is more", async () => {
    let followed = 0;
    const run: GraphqlRun = async (query) => {
      if (query === PAGE_QUERY) {
        followed++;
        return { page: page([], "again") };
      }
      return { involves: page([], "again"), reviewRequested: page([]), authored: page([]), owned: page([]) };
    };
    await searchAccount(run, "ada");
    expect(followed).toBe(9);
  });

  test("no data at all is four empty lists", async () => {
    expect(await searchAccount(async () => null, "ada")).toEqual({ involves: [], reviewRequested: [], issues: [] });
  });
});

describe("the queries", () => {
  test("each declares exactly one named operation (the fake gh routes by name)", () => {
    expect([...SEARCH_QUERY.matchAll(/\bquery\s+(\w+)/g)].map((m) => m[1])).toEqual(["AgendoGithubSearch"]);
    expect([...PAGE_QUERY.matchAll(/\bquery\s+(\w+)/g)].map((m) => m[1])).toEqual(["AgendoGithubSearchPage"]);
  });

  test("search strings: PRs involving or awaiting you, issues you filed or that are in your repos", () => {
    expect(searchQueries("ada")).toEqual({
      involves: "is:pr is:open involves:ada",
      reviewRequested: "is:pr is:open review-requested:ada",
      authored: "is:issue is:open author:ada",
      owned: "is:issue is:open user:ada",
    });
  });

  test("graphqlArgs passes the query and every variable as raw -f fields", () => {
    expect(graphqlArgs("query Q { x }", { a: "is:pr x:y", b: "2" })).toEqual([
      "api", "graphql", "-f", "query=query Q { x }", "-f", "a=is:pr x:y", "-f", "b=2",
    ]);
  });
});
