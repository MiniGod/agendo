// End-to-end coverage of the GitHub backend (cc05391), the biggest feature to
// land since the branch point. The default harness pins the provider to Azure
// DevOps; here we flip it to GitHub, wire the fake `gh` CLI with issue/PR
// fixtures, and drive the real browser-rendered TUI — proving the whole app
// (title bar, tab labels, section headers, PR prefix) re-skins to GitHub vocab
// and actually pulls its data through the `gh` code path.
//
// Repo scope comes from the local sessions' repos (see fixtures): their roots
// resolve, via the fake git's `remote get-url origin`, to `ada/<repo>` slugs —
// all owned by the fake login `ada`, so issues are queried without `--author`.
import { test, expect, KEY } from "./harness/test.ts";

// The authenticated GitHub user the fake `gh api user` returns. Its login is the
// id the backend filters issues/PRs by, and the "(you)" identity.
const ME = { login: "ada", name: "Ada Lovelace" };

// A PR whose branch embeds issue 301's id, so linkedIssues() files it under the
// issue (no "Closes #" keyword needed) — and its badge renders with GitHub's `#`
// PR prefix, the marquee visual difference from ADO's `!`.
const PR_401 = {
  number: 401,
  title: "Rework the header",
  url: "https://github.com/ada/appweb/pull/401",
  headRefName: "worktree-fix-header-301",
  isDraft: false,
  reviewDecision: "APPROVED",
  reviews: [{ author: { login: "grace" }, state: "APPROVED" }],
  statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
  mergeStateStatus: "CLEAN",
  createdAt: "2026-06-20T10:00:00.000Z",
  updatedAt: "2026-06-21T10:00:00.000Z",
  author: { login: ME.login },
  closingIssuesReferences: [],
  body: "",
};

// Seed the fake `gh`: logged in as ada, one open issue she filed in ada/appweb
// (→ the "Created by me" bucket) with a PR linked to it via the branch id.
async function seedGitHub(
  mock: { setProvider: (n: "github") => Promise<void>; setGhState: (s: unknown) => Promise<void> },
  extra: Record<string, unknown> = {},
) {
  await mock.setProvider("github");
  await mock.setGhState({
    ...extra,
    authed: true,
    user: ME,
    issues: {
      "ada/appweb": [
        { number: 301, title: "Header overlaps on mobile", state: "OPEN", url: "https://github.com/ada/appweb/issues/301", labels: [], author: { login: ME.login } },
      ],
    },
    prs: {
      "ada/appweb": {
        "involves:ada": [PR_401], // the issue-linking scan
        "author:ada": [PR_401], // fetchActivePRs
        "review-requested:ada": [], // nothing awaiting review
      },
    },
  });
}

test("boots into the GitHub backend: issues vocab, data from gh, '#' PR prefix", async ({ launch, mock }) => {
  await seedGitHub(mock);
  const wt = await launch();

  // The primary section header is GitHub's "Created by me" (not ADO's "Current
  // sprint"), and the issue pulled from the fake `gh` renders.
  const screen = await wt.waitForText("Created by me", 20000);
  expect(screen).toContain("Header overlaps on mobile"); // issue 301, via gh issue list
  expect(screen).not.toContain("Current sprint"); // no ADO vocab leaked

  // Title bar re-skinned: the GitHub provider label + the "Issues" tab (not
  // "Work items").
  expect(screen).toContain("[GitHub]");
  expect(screen).toContain("1 Issues");
  expect(screen).not.toContain("1 Work items");

  // The linked PR badge uses GitHub's `#` prefix (ADO would render `!401`).
  expect(screen).toContain("#401");
  expect(screen).not.toContain("!401");

  // It genuinely went through the gh code path (not a stub): ONE account-wide
  // search, shared by the load's issue, PR and review fetches — never a call per
  // repo, which is what used to spend the whole GraphQL budget.
  const calls = (await mock.callLog()).filter((l) => l.startsWith("gh "));
  expect(calls.filter((l) => l.includes("query=AgendoGithubSearch"))).toHaveLength(1);
  expect(calls.some((l) => l.includes('"issue","list"') || l.includes('"pr","list"'))).toBe(false);
});

test("a rate-limited GitHub says until when, instead of showing empty lists", async ({ launch, mock }) => {
  const reset = Math.floor(Date.now() / 1000) + 40 * 60;
  await seedGitHub(mock, {
    rateLimit: { graphql: { limit: 5000, used: 5000, remaining: 0, reset } },
    graphql: { AgendoGithubSearch: { errors: [{ type: "RATE_LIMIT", code: "graphql_rate_limit", message: "API rate limit already exceeded for user ID 1." }] } },
  });
  const wt = await launch();

  const d = new Date(reset * 1000);
  const until = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  await wt.waitForText(`GitHub rate limited until ${until}`, 20000);
  // Not retried: one search, one free budget read, and nothing after them.
  const calls = (await mock.callLog()).filter((l) => l.startsWith("gh "));
  expect(calls.filter((l) => l.includes("query=AgendoGithubSearch"))).toHaveLength(1);
  expect(calls.filter((l) => l.includes('"rate_limit"'))).toHaveLength(1);
});

test("GitHub identity + settings reflect the authenticated gh user", async ({ launch, mock }) => {
  await seedGitHub(mock);
  const wt = await launch();
  await wt.waitForText("Created by me", 20000);
  await wt.waitForStable();

  // Header identity is the gh user (login `ada` → name "Ada Lovelace"), marked
  // "(you)" since it's the authenticated account.
  const header = await wt.screen();
  expect(header).toContain("Ada Lovelace (you)");

  // Settings shows GitHub as the current backend, and its async auth probe
  // resolves the gh line to authenticated (the fake `gh auth status` exits 0).
  await wt.press(",");
  const settings = await wt.waitForText("Settings");
  expect(settings).toMatch(/Backend\s+GitHub/);
  const auth = await wt.waitForText("gh installed · authenticated", 8000);
  expect(auth).toContain("gh installed · authenticated ✓");
});

// Regression: GitHub issue numbers are only unique per repo, so two repos can
// each have an issue #16. The items view keyed rows (and the expand state) by
// the bare number, so the two rows collided — React printed "Encountered two
// children with the same key, `i16`" above the UI, and expanding one #16
// expanded both. Keys are now scoped by repo (itemKey/prKey in src/app/model/index.ts).
test("issues sharing a number across repos: no duplicate React keys, independent rows", async ({ launch, mock }) => {
  await mock.setProvider("github");
  const issue = (slug: string, title: string) => ({
    number: 16, title, state: "OPEN",
    url: `https://github.com/${slug}/issues/16`,
    labels: [], author: { login: ME.login },
  });
  await mock.setGhState({
    authed: true,
    user: ME,
    issues: {
      "ada/appweb": [issue("ada/appweb", "Appweb bug sixteen")],
      "ada/applib": [issue("ada/applib", "Applib bug sixteen")],
    },
    prs: {},
  });
  const wt = await launch();

  // Both #16s render — they are distinct issues, one row each.
  const screen = await wt.waitForText("Appweb bug sixteen", 20000);
  expect(screen).toContain("Applib bug sixteen");
  await wt.waitForStable();

  // React must not have complained about colliding row keys. screen() can miss
  // the one-shot warning (redraws overwrite it), so scan the raw PTY stream.
  expect(wt.output()).not.toContain("Encountered two children with the same key");

  // Expand state is also scoped: opening the first #16 must not open the other.
  // One expanded empty item shows exactly one "start a fresh session" child row
  // — under the shared-key bug both items expanded, showing two.
  await wt.press(KEY.right, 400);
  const expanded = await wt.waitForText("start a fresh session");
  expect(expanded.match(/start a fresh session/g)).toHaveLength(1);
});
