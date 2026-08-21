// The fake `gh` is a test double, so it does not normally get tested itself —
// but this one earns a spec, because its failure mode is invisible. It used to
// answer any subcommand it did not implement with `process.exit(0)` and no
// output, and `gh()` in src/github.ts resolves empty stdout to `null` rather
// than throwing. A call the fake had never heard of therefore looked exactly
// like a successful call that returned nothing, and every test around it stayed
// green while the code under test received no data at all.
//
// Everything below pins the opposite: unrecognised input FAILS, loudly, naming
// what it did not recognise. These assertions are the reason a later GraphQL
// query can be trusted when its test passes — without them, "the suite is green"
// says nothing about whether the fake ever understood the query.
//
// The fake is spawned directly rather than through the launcher: its contract is
// with any caller, and driving the TUI to reach it would test the backend's use
// of it instead of the contract itself.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";

const FAKE_GH = join(REPO_ROOT, "e2e", "fakebin", "gh");

function runGh(env: Record<string, string>, ...args: string[]) {
  return spawnSync(FAKE_GH, args, { env, encoding: "utf-8", timeout: 15_000 });
}

/** `gh api graphql -f query=<q>` plus any extra `-f k=v` variables. */
function graphql(env: Record<string, string>, query: string, ...vars: string[]) {
  return runGh(env, "api", "graphql", "-f", `query=${query}`, ...vars);
}

const PROJECT_QUERY = `query AgendoProject($login: String!) { user(login: $login) { projectV2(number: 1) { title } } }`;

test.describe("fake gh: unrecognised input fails instead of exiting 0", () => {
  test("an unimplemented subcommand exits non-zero and names itself", async ({ mock }) => {
    const r = runGh(mock.env, "repo", "clone", "ada/appweb");
    // The regression this whole file exists for: this used to be status 0 with
    // empty stdout, which is indistinguishable from "succeeded, no results".
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("does not implement");
    expect(r.stderr).toContain("repo clone ada/appweb");
  });

  test("a graphql call with no query argument fails", async ({ mock }) => {
    const r = runGh(mock.env, "api", "graphql");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no -f query=");
  });

  test("an anonymous query fails with the instruction to name the operation", async ({ mock }) => {
    const r = graphql(mock.env, "{ viewer { login } }");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("operation name");
    // The message has to say what to do, not just that something is wrong.
    expect(r.stderr).toContain("query AgendoSomething");
  });

  test("a query whose operation has no fixture fails and lists what is registered", async ({ mock }) => {
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: {} } } });
    const r = graphql(mock.env, `query AgendoEpics { viewer { login } }`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("AgendoEpics");
    expect(r.stderr).toContain("Known operations: AgendoProject");
  });

  test("with no graphql key at all, the failure says so rather than listing nothing", async ({ mock }) => {
    await mock.setGhState({ authed: true });
    const r = graphql(mock.env, PROJECT_QUERY);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no `graphql` key");
  });

  test("a query read from a file is refused rather than silently mishandled", async ({ mock }) => {
    const r = runGh(mock.env, "api", "graphql", "-f", "query=@/tmp/some-query.graphql");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("does not support reading a query from a file");
  });
});

test.describe("fake gh: registered GraphQL operations", () => {
  test("a registered operation returns its payload verbatim", async ({ mock }) => {
    const payload = { data: { user: { projectV2: { title: "Roadmap" } } } };
    await mock.setGhState({ authed: true, graphql: { AgendoProject: payload } });

    const r = graphql(mock.env, PROJECT_QUERY, "-f", "login=ada");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(payload);
  });

  test("an array fixture is a sequence: successive calls walk it, and overrunning fails", async ({ mock }) => {
    await mock.setGhState({
      authed: true,
      graphql: {
        AgendoProjectPage: [
          { data: { page: 1 } },
          { data: { page: 2 } },
        ],
      },
    });
    const q = `query AgendoProjectPage($after: String) { user(login: "ada") { projectV2(number: 1) { title } } }`;

    const first = graphql(mock.env, q);
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({ data: { page: 1 } });

    const second = graphql(mock.env, q);
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual({ data: { page: 2 } });

    // Running off the end must NOT re-serve the last page: a fetch that pages
    // while `hasNextPage` is true would loop forever against a repeating fixture,
    // and a hung test is a far worse signal than a failed one.
    const third = graphql(mock.env, q);
    expect(third.status).not.toBe(0);
    expect(third.stderr).toContain("only 2 response(s) are registered");
  });

  test("an errors payload is served the way the real CLI serves one", async ({ mock }) => {
    // The shape GitHub actually returns for a token without `read:project` —
    // the case this fake exists to make testable without such a token.
    const scopeError = {
      errors: [
        {
          type: "INSUFFICIENT_SCOPES",
          message:
            "Your token has not been granted the required scopes to execute this query. " +
            "The 'projectV2' field requires one of the following scopes: ['read:project'].",
        },
      ],
    };
    await mock.setGhState({ authed: true, graphql: { AgendoProject: scopeError } });

    const r = graphql(mock.env, PROJECT_QUERY);
    expect(r.status).not.toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(scopeError); // body still on stdout
    expect(r.stderr).toContain("gh: ");
    expect(r.stderr).toContain("read:project"); // what src/github.ts's gh() surfaces
  });
});

test.describe("fake gh: call logging", () => {
  test("a graphql call is logged by operation name, keeping its other arguments", async ({ mock }) => {
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: {} } } });
    const r = graphql(mock.env, PROJECT_QUERY, "-f", "login=ada");
    expect(r.status).toBe(0);

    const calls = await mock.callLog();
    const line = calls.find((l) => l.includes("graphql"));
    expect(line).toBeTruthy();
    // The multi-kilobyte query text is collapsed to its operation name so the log
    // stays readable, but nothing else about the argv is rewritten.
    expect(line).toContain("query=AgendoProject");
    expect(line).not.toContain("projectV2(number: 1)");
    expect(line).toContain("login=ada");
  });

  test("a REJECTED call is still logged, so a failing test can see what was tried", async ({ mock }) => {
    await mock.setGhState({ authed: true });
    const r = runGh(mock.env, "repo", "clone", "ada/appweb");
    expect(r.status).not.toBe(0);

    const calls = await mock.callLog();
    expect(calls.some((l) => l.startsWith("gh ") && l.includes("clone"))).toBe(true);
  });
});

test.describe("fake gh: the paths the backend already relies on still work", () => {
  // Regression guard on making the fallthrough strict. These four argv shapes are
  // every `gh` call src/github.ts makes; if strictness had caught one of them the
  // whole GitHub suite would go red, so they are pinned here where the cause is
  // obvious rather than only in the specs that happen to exercise them.
  test("auth status reflects the authed flag in both directions", async ({ mock }) => {
    await mock.setGhState({ authed: true, user: { login: "ada", name: "Ada Lovelace" } });
    expect(runGh(mock.env, "auth", "status").status).toBe(0);

    await mock.setGhState({ authed: false });
    expect(runGh(mock.env, "auth", "status").status).not.toBe(0);
  });

  test("api user returns the configured identity", async ({ mock }) => {
    await mock.setGhState({ authed: true, user: { login: "ada", name: "Ada Lovelace" } });
    const r = runGh(mock.env, "api", "user");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ login: "ada", name: "Ada Lovelace" });
  });

  test("issue list is keyed by repo slug, and an unknown repo is empty rather than an error", async ({ mock }) => {
    await mock.setGhState({ authed: true, issues: { "ada/appweb": [{ number: 301 }] } });
    const hit = runGh(mock.env, "issue", "list", "--repo", "ada/appweb", "--state", "open");
    expect(hit.status).toBe(0);
    expect(JSON.parse(hit.stdout)).toEqual([{ number: 301 }]);

    // "this repo has no issues" is a real answer, not a missing fixture — unlike
    // an unimplemented subcommand, it must stay a successful empty result.
    const miss = runGh(mock.env, "issue", "list", "--repo", "ada/other", "--state", "open");
    expect(miss.status).toBe(0);
    expect(JSON.parse(miss.stdout)).toEqual([]);
  });

  test("pr list picks the bucket matching its --search query", async ({ mock }) => {
    await mock.setGhState({
      authed: true,
      prs: { "ada/appweb": { "author:ada": [{ number: 401 }], "review-requested:ada": [] } },
    });
    const mine = runGh(mock.env, "pr", "list", "--repo", "ada/appweb", "--search", "state:open author:ada");
    expect(mine.status).toBe(0);
    expect(JSON.parse(mine.stdout)).toEqual([{ number: 401 }]);

    const reviews = runGh(mock.env, "pr", "list", "--repo", "ada/appweb", "--search", "state:open review-requested:ada");
    expect(reviews.status).toBe(0);
    expect(JSON.parse(reviews.stdout)).toEqual([]);
  });
});
