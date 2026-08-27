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
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";

const FAKE_GH = join(REPO_ROOT, "e2e", "fakebin", "gh");

function runGh(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(FAKE_GH, args, { env, encoding: "utf-8", timeout: 15_000 });
  // Every negative test here asserts a non-zero exit, and `spawnSync` reports a
  // process it could not START as `{ status: null, error }` — which `not.toBe(0)`
  // happily accepts. A lost exec bit, a renamed path or a missing `node` for the
  // shebang would then leave the whole "unrecognised input fails" group green
  // while the fake never ran at all: the same vacuous-pass shape this spec exists
  // to prevent. So prove it executed before believing anything about its exit.
  expect(r.error, `the fake gh did not execute: ${r.error?.message}`).toBeUndefined();
  expect(r.signal, "the fake gh was killed (timeout?) rather than exiting").toBeNull();
  return r;
}

/**
 * Genuinely concurrent runs. `spawnSync` blocks, so N of those are N sequential
 * calls and would prove nothing about a race — the processes have to be in
 * flight at the same time for overlapping counter updates to be possible at all.
 */
function runGhConcurrently(env: Record<string, string>, times: number, args: string[]) {
  return Promise.all(
    Array.from({ length: times }, () =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(FAKE_GH, args, { env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
      }),
    ),
  );
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
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("does not implement");
    expect(r.stderr).toContain("repo clone ada/appweb");
  });

  test("a graphql call with no query argument fails", async ({ mock }) => {
    const r = runGh(mock.env, "api", "graphql");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no query field");
  });

  test("an anonymous query fails with the instruction to name the operation", async ({ mock }) => {
    const r = graphql(mock.env, "{ viewer { login } }");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("operation name");
    // The message has to say what to do, not just that something is wrong.
    expect(r.stderr).toContain("query AgendoSomething");
  });

  test("a query whose operation has no fixture fails and lists what is registered", async ({ mock }) => {
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: {} } } });
    const r = graphql(mock.env, `query AgendoEpics { viewer { login } }`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("AgendoEpics");
    expect(r.stderr).toContain("Known operations: AgendoProject");
  });

  test("with no graphql key at all, the failure says so rather than listing nothing", async ({ mock }) => {
    await mock.setGhState({ authed: true });
    const r = graphql(mock.env, PROJECT_QUERY);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no `graphql` key");
  });

  test("a comment mentioning another operation does not hijack the routing", async ({ mock }) => {
    // The name is taken from the first `query <name>` in the text, so a comment
    // above the declaration is competing with it. Routing to the commented name
    // would look like a missing fixture, and nothing in that failure would point
    // at the comment as the cause.
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: { ok: true } } } });
    const r = graphql(mock.env, `# query AgendoOld was replaced\n${PROJECT_QUERY}`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ data: { ok: true } });
  });

  test("an unmodelled flag fails, because ignoring it would change what stdout means", async ({ mock }) => {
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: { ok: true } } } });
    // These two are the dangerous ones. Real `gh api --paginate` emits one JSON
    // object PER PAGE, concatenated — `JSON.parse` in src/github.ts would throw
    // on that — and `--jq` emits a transformed value instead of the body. A fake
    // that ignored them would answer with a body shape production never sees:
    // the original silent-success bug, moved down one level.
    for (const bad of [["--paginate"], ["--jq", ".data.title"], ["--bogus"]]) {
      const r = runGh(mock.env, "api", "graphql", "-f", `query=${PROJECT_QUERY}`, ...bad);
      expect(r.status, `expected \`${bad[0]}\` to be rejected`).toBe(1);
      // The rejection message ENDS with the fixed words "--paginate" and "--jq"
      // (it explains why those two matter), so a bare toContain(bad[0]) would
      // pass for those two cases no matter which flag the fake actually named —
      // including if the interpolation were broken entirely. Assert the
      // interpolated form, which only the named flag can satisfy.
      expect(r.stderr).toContain(`unrecognised flag \`${bad[0]}\``);
    }
  });

  test("a flag with no value fails instead of swallowing the next token", async ({ mock }) => {
    const r = runGh(mock.env, "api", "graphql", "-f");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("missing its value");
  });

  test("a field argument that is not key=value is rejected, as the real CLI rejects it", async ({ mock }) => {
    // Silently dropping it would make a typo'd variable invisible.
    const r = runGh(mock.env, "api", "graphql", "-f", "bogus");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid key: "bogus"');
  });

  test("an anonymous query is still rejected when a string literal contains `query <name>`", async ({ mock }) => {
    // `search(query: "…")` is ordinary GitHub GraphQL. Scanning the raw text for
    // `query <name>` finds the one inside the string and routes to it, accepting
    // an anonymous document as if it had been named — and serving another
    // operation's fixture for it.
    await mock.setGhState({ authed: true, graphql: { Bar: { data: { wrong: true } } } });
    const r = graphql(mock.env, `{ search(type: ISSUE, query: "repo:a query Bar") { x } }`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("operation name");
  });

  test("a `#` inside a string literal does not eat the operation name", async ({ mock }) => {
    // Comment-stripping has to be string-aware: `#` is routine inside GitHub
    // search terms ("is:pr #123", 'label:"#p1"'), and a naive strip-to-end-of-line
    // takes any operation name that follows on the same line with it.
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: { ok: true } } } });
    const r = graphql(mock.env, `fragment F on Y { a(q: "is:pr #123") } query AgendoProject { b }`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ data: { ok: true } });
  });

  test("a query read from a file is refused rather than silently mishandled", async ({ mock }) => {
    const r = runGh(mock.env, "api", "graphql", "-f", "query=@/tmp/some-query.graphql");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not read a query from a file");
  });

  test("a stray positional fails instead of being dropped on the floor", async ({ mock }) => {
    // `gh issue list ada/appweb` is a plausible typo for `--repo ada/appweb`, and
    // a parser that only looks at flags answers it with the empty fixture — the
    // silent-empty result this file exists to remove, hiding in a missing flag
    // name rather than in a missing branch.
    await mock.setGhState({ authed: true, issues: { "ada/appweb": [{ number: 301 }] } });
    const r = runGh(mock.env, "issue", "list", "ada/appweb", "--state", "open");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unexpected argument(s) `ada/appweb`");
  });

  test("a missing or empty --repo fails rather than reporting an empty repo", async ({ mock }) => {
    // "this repo has no issues" and "you never said which repo" are different
    // answers, and only one of them is `[]`. src/github.ts always passes --repo,
    // so a call that does not is a caller bug and has to read as one.
    await mock.setGhState({ authed: true, issues: { "ada/appweb": [{ number: 301 }] } });
    for (const args of [
      ["issue", "list", "--state", "open"],
      ["issue", "list", "--repo=", "--state", "open"],
      ["pr", "list", "--search", "state:open author:ada"],
    ]) {
      const r = runGh(mock.env, ...args);
      expect(r.status, `expected \`gh ${args.join(" ")}\` to be rejected`).toBe(1);
      expect(r.stderr).toContain("needs a non-empty --repo");
    }
  });

  test("a multi-operation document is refused rather than routed to the first name", async ({ mock }) => {
    // Legal GraphQL: the server picks by operationName. Assuming the first
    // declaration would serve one fixture while the real API ran a different
    // operation — a divergence no assertion in the test could see.
    await mock.setGhState({ authed: true, graphql: { Decoy: { data: { wrong: true } }, AgendoProject: { data: { ok: true } } } });
    const r = graphql(mock.env, `query Decoy { a } ${PROJECT_QUERY}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("declares 2 operations (Decoy, AgendoProject)");
  });

  test("an operationName the document does not declare is refused", async ({ mock }) => {
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: { ok: true } } } });
    const r = graphql(mock.env, PROJECT_QUERY, "-f", "operationName=AgendoEpics");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not declared by this document");
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

  test("the attached `--flag=value` form works everywhere the separated form does", async ({ mock }) => {
    // Real gh accepts both. Supporting only `--name value` is how `--repo=slug`
    // used to yield an empty fixture SILENTLY — the failure mode this file exists
    // to remove, hiding in the argument parser rather than in the dispatch.
    await mock.setGhState({
      authed: true,
      graphql: { AgendoProject: { data: { ok: true } } },
      issues: { "ada/appweb": [{ number: 301 }] },
    });

    const gql = runGh(mock.env, "api", "graphql", `--field=query=${PROJECT_QUERY}`);
    expect(gql.status).toBe(0);
    expect(JSON.parse(gql.stdout)).toEqual({ data: { ok: true } });
    // The log must keep the form that was actually used; rebuilding it as a bare
    // `query=<name>` would record an argument that was never passed.
    const logged = (await mock.callLog()).find((l) => l.includes("graphql"));
    expect(logged).toContain("--field=query=AgendoProject");

    const issues = runGh(mock.env, "issue", "list", "--repo=ada/appweb", "--state=open");
    expect(issues.status).toBe(0);
    expect(JSON.parse(issues.stdout)).toEqual([{ number: 301 }]);
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
    expect(third.status).toBe(1);
    expect(third.stderr).toContain("only 2 response(s) are registered");
  });

  test("re-seeding mid-test restarts a sequence rather than resuming the old call count", async ({ mock }) => {
    // The counter outlives the process (every `gh` call is a fresh one), so it
    // lives in a sidecar file — which means it also outlives a re-seed unless
    // setGhState clears it. Without that, a test that drives two different
    // paginated fetches would overrun the second sequence on its first call,
    // and the failure would point at the fixture rather than at the harness.
    const q = `query AgendoProjectPage { viewer { login } }`;
    await mock.setGhState({ authed: true, graphql: { AgendoProjectPage: [{ data: { seed: "a1" } }, { data: { seed: "a2" } }] } });
    expect(JSON.parse(graphql(mock.env, q).stdout)).toEqual({ data: { seed: "a1" } });
    expect(JSON.parse(graphql(mock.env, q).stdout)).toEqual({ data: { seed: "a2" } });

    await mock.setGhState({ authed: true, graphql: { AgendoProjectPage: [{ data: { seed: "b1" } }] } });
    const afterReseed = graphql(mock.env, q);
    expect(afterReseed.status).toBe(0); // would be an overrun failure if the counter survived
    expect(JSON.parse(afterReseed.stdout)).toEqual({ data: { seed: "b1" } });
  });

  test("concurrent calls to one sequence get distinct pages, not the same one twice", async ({ mock }) => {
    // src/github.ts fans its fetches out with `Promise.all`, so the same operation
    // really can be in flight more than once. The counter therefore cannot be
    // increment-then-read-back — not a read-modify-write on a shared JSON file
    // (both processes read N, both serve page N), and not an atomic append
    // followed by a `stat` either: the append is atomic but the size read is a
    // SECOND syscall, so A.append/B.append/A.stat/B.stat still hands both the
    // same index. Only a primitive that claims AND reports at once will do.
    //
    // Repeated, because a race is a probability and one round is not a verdict:
    // the increment-then-read implementation this replaced loses a ticket in
    // roughly a third of 16-way rounds, so a single round would report it as
    // FLAKY — which Playwright retries away — rather than as broken. Eight
    // rounds in one attempt turns "sometimes wrong" into "reliably red".
    const pages = Array.from({ length: 16 }, (_, i) => ({ data: { page: i } }));
    const q = `query AgendoProjectPage { viewer { login } }`;

    for (let round = 0; round < 8; round++) {
      await mock.setGhState({ authed: true, graphql: { AgendoProjectPage: pages } }); // also resets the counter
      const runs = await runGhConcurrently(mock.env, pages.length, ["api", "graphql", "-f", `query=${q}`]);
      for (const r of runs) expect(r.code, `round ${round}: ${r.stderr}`).toBe(0);
      const served = runs.map((r) => JSON.parse(r.stdout).data.page);
      // Order is genuinely undefined under concurrency; distinctness is the contract.
      expect([...served].sort((a, b) => a - b), `round ${round}`).toEqual(pages.map((_, i) => i));
    }
  });

  test("operationName picks the operation when the document declares several", async ({ mock }) => {
    await mock.setGhState({ authed: true, graphql: { Decoy: { data: { wrong: true } }, AgendoProject: { data: { ok: true } } } });
    const r = graphql(mock.env, `query Decoy { a } ${PROJECT_QUERY}`, "-f", "operationName=AgendoProject");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ data: { ok: true } });
  });

  test("a large payload arrives whole, not cut off at the pipe buffer", async ({ mock }) => {
    // `process.stdout.write` is ASYNCHRONOUS when stdout is a pipe — which is
    // what every spawned `gh` gets — and `process.exit()` does not drain it. The
    // fake used to lose everything past ~8 KB, silently, and only for bodies big
    // enough to matter: `JSON.parse` in src/github.ts throws on the fragment,
    // `ghSafe` swallows the throw, and the app sees `[]`. That is precisely the
    // silent-empty failure this file exists to remove, reintroduced as a function
    // of size. Every other fixture here is under 100 bytes, so nothing else in
    // this spec can see it.
    //
    // 200 KB is well past the 64 KiB Linux pipe buffer, and a GraphQL page of 100
    // project items is the realistic case that crosses it.
    const items = Array.from({ length: 400 }, (_, i) => ({ id: `PVTI_${String(i).padStart(6, "0")}`, title: "x".repeat(400) }));
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: { items } } } });

    const r = graphql(mock.env, PROJECT_QUERY);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(150_000);
    // Parse rather than compare lengths only: a truncated body is invalid JSON,
    // which is exactly how the app would have discovered this.
    expect(JSON.parse(r.stdout).data.items).toHaveLength(400);
  });

  test("an errors payload is served the way the real CLI serves one", async ({ mock }) => {
    // The shape GitHub actually returns for a token without `read:project` —
    // the case this fake exists to make testable without such a token.
    // `data` AND `errors` together — GitHub's actual shape for a partial failure,
    // and the one a fake is most likely to get wrong by dropping `data`. Real gh
    // still exits 1 here (verified live), so a caller cannot treat "some data
    // arrived" as success.
    const scopeError = {
      data: { user: null },
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
    expect(r.status).toBe(1);
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

  test("only the query element is collapsed, not every argument that looks like one", async ({ mock }) => {
    // Rewriting by pattern ("starts with query=") instead of by the index the
    // query was actually read from lets the log assert a value that was never
    // passed. Last-wins means AgendoProject is the one that ran.
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: {} } } });
    const r = runGh(
      mock.env, "api", "graphql",
      "-f", `query=query Decoy { a }`,
      "-f", `query=${PROJECT_QUERY}`,
    );
    expect(r.status).toBe(0);

    const line = (await mock.callLog()).find((l) => l.includes("graphql"));
    // The first (overridden) field keeps its literal text; only the one actually
    // used is replaced by its operation name.
    expect(line).toContain("query=query Decoy { a }");
    expect(line).toContain("query=AgendoProject");
  });

  test("a REJECTED call is still logged, so a failing test can see what was tried", async ({ mock }) => {
    await mock.setGhState({ authed: true });
    const r = runGh(mock.env, "repo", "clone", "ada/appweb");
    expect(r.status).toBe(1);

    const calls = await mock.callLog();
    expect(calls.some((l) => l.startsWith("gh ") && l.includes("clone"))).toBe(true);
  });

  test("a call rejected while PARSING its flags is logged too", async ({ mock }) => {
    // The unknown-subcommand path logs before it parses, so it was never at risk.
    // Everything raised from inside the parser — an unmodelled flag, a flag with
    // no value, a malformed -f pair — happens before any branch has logged, and
    // those are the rejections a test is most likely to be debugging. "Which call
    // did the app actually make?" has to be answerable for a call that failed.
    await mock.setGhState({ authed: true, graphql: { AgendoProject: { data: {} } } });
    for (const bad of [["--paginate"], ["-f"], ["-f", "bogus"]]) {
      const r = runGh(mock.env, "api", "graphql", ...bad);
      expect(r.status, `expected \`${bad.join(" ")}\` to be rejected`).toBe(1);
    }
    const calls = await mock.callLog();
    expect(calls.filter((l) => l.includes("graphql"))).toHaveLength(3);
    expect(calls.some((l) => l.includes("--paginate"))).toBe(true);
  });
});

test.describe("fake gh: the paths the backend already relies on still work", () => {
  // Regression guard on making the fallthrough strict. src/github.ts makes six
  // distinct `gh` calls; the four shapes below are what the fake can distinguish.
  // The one it CANNOT is noted where it bites: `issue list --author <login>`
  // (github.ts:359, the not-owned-repo path) is accepted but ignored for fixture
  // selection, so the owned/not-owned issue split cannot be expressed by a
  // fixture at all — a gap this PR does not close. (`issue list --search` is not
  // in that category: the fake refuses it outright, because production never
  // sends one and a whitelisted-but-unread flag is how a fixture gets ignored.) If strictness had caught one of them the
  // whole GitHub suite would go red, so they are pinned here where the cause is
  // obvious rather than only in the specs that happen to exercise them.
  test("auth status reflects the authed flag in both directions", async ({ mock }) => {
    await mock.setGhState({ authed: true, user: { login: "ada", name: "Ada Lovelace" } });
    expect(runGh(mock.env, "auth", "status").status).toBe(0);

    await mock.setGhState({ authed: false });
    expect(runGh(mock.env, "auth", "status").status).toBe(1);
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
