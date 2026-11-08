// Two ways the GitHub provider survives an answer that is not all there:
// a renamed or transferred repo, whose origin still carries the old name
// (src/providers/github/canonical.ts), and a GraphQL body that has `errors`
// beside its `data` (src/providers/github/gh.ts `partialData`). The e2e fake
// answers every repo under the name it was asked by and never mixes errors
// into a successful search.
import { describe, expect, test } from "bun:test";
import { canonicalQuery, canonicalSlugs } from "../src/providers/github/canonical.ts";
import { partialData, type GhError } from "../src/providers/github/gh.ts";

describe("canonicalSlugs", () => {
  test("one request names every repo; a moved one maps to where it lives now, lowercased", async () => {
    const calls: Array<Record<string, string>> = [];
    const current = await canonicalSlugs(async (query, vars) => {
      expect(query).toBe(canonicalQuery(2));
      calls.push(vars);
      return { r0: { nameWithOwner: "Ada/AppWeb" }, r1: { nameWithOwner: "grace/new-lib" } };
    }, ["ada/appweb", "Ada/old-lib"]);
    expect(calls).toEqual([{ o0: "ada", n0: "appweb", o1: "Ada", n1: "old-lib" }]);
    expect([...current]).toEqual([["ada/appweb", "ada/appweb"], ["ada/old-lib", "grace/new-lib"]]);
  });

  test("a repo GitHub won't show keeps its own name", async () => {
    expect([...(await canonicalSlugs(async () => ({ r0: null }), ["ada/gone"]))]).toEqual([["ada/gone", "ada/gone"]]);
  });

  test("a failed request rejects, so no cache can keep it as \"no renames\"", async () => {
    const boom = new Error("gh api graphql -> exit 1: HTTP 502");
    await expect(canonicalSlugs(async () => { throw boom; }, ["ada/x"])).rejects.toBe(boom);
  });

  test("no repos, no request", async () => {
    let asked = false;
    expect((await canonicalSlugs(async () => { asked = true; }, [])).size).toBe(0);
    expect(asked).toBe(false);
  });

  test("the query declares one variable pair and one aliased field per repo", () => {
    expect(canonicalQuery(2)).toBe(
      "query AgendoGithubRepos($o0: String!, $n0: String!, $o1: String!, $n1: String!) {\n" +
        "  r0: repository(owner: $o0, name: $n0) { nameWithOwner }\n" +
        "  r1: repository(owner: $o1, name: $n1) { nameWithOwner }\n}",
    );
  });
});

const failed = (message: string, body?: unknown): GhError => Object.assign(new Error(message), { body });

describe("partialData", () => {
  test("data beside errors is kept, and the first error is reported", () => {
    const told: string[] = [];
    const data = partialData(
      failed("gh api graphql -> exit 1: gh: Resource protected by organization SAML enforcement.", {
        data: { involves: { nodes: [null] } },
        errors: [{ message: "Resource protected by organization SAML enforcement." }, { message: "second" }],
      }),
      (first) => told.push(first),
    );
    expect(data).toEqual({ involves: { nodes: [null] } });
    expect(told).toEqual(["Resource protected by organization SAML enforcement."]);
  });

  test("no data, no body, or a rate limit: the failure stands", () => {
    const never = () => { throw new Error("must not be told"); };
    for (const e of [
      failed("exit 1", { errors: [{ message: "bad query" }] }),
      failed("exit 1"),
      failed("exit 1: gh: API rate limit already exceeded for user ID 1.", { data: { involves: null }, errors: [{}] }),
    ]) {
      expect(() => partialData(e, never)).toThrow(e.message);
    }
  });
});
