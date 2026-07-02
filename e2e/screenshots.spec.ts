// Snapshot coverage of every view. Each state is asserted with a STYLED-GRID
// snapshot (toMatchSnapshot): the rendered terminal grid as text, with inline
// `⟨color,attr⟩` tags on any non-default run. Read straight from the WASM cell
// buffer, it's deterministic, so it behaves like classic snapshot testing —
// the first run writes a baseline under `screenshots.spec.ts-snapshots/`, later
// runs FAIL on any unintended change to layout, text, OR color. Regenerate
// intentionally with `--update-snapshots`.
//
// This subsumes a pixel screenshot for our purposes (it catches color/attribute
// regressions too) while staying deterministic with readable diffs. A plain PNG
// is still saved to e2e/screenshots/ as a non-asserted artifact for eyeballing.
//
// Volatile text (relative times like "5m ago", inter-action gaps like "+8s",
// and the random temp-home path) is normalized so baselines stay stable.
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import type { WebTerminal } from "./harness/wterm.ts";

const SHOTS = join(import.meta.dirname, "screenshots");

function stable(grid: string, home: string): string {
  return grid
    .split(home).join("<HOME>") // random per-run temp dir → placeholder
    .replace(/\b\d+[smhd] ago\b/g, "<ago>")
    .replace(/\+\d+[smhd]\b/g, "<+d>")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/g, "");
}

// Save a PNG artifact (not asserted) and assert the styled text grid (the test).
async function capture(wt: WebTerminal, home: string, name: string) {
  await wt.screenshot(join(SHOTS, `${name}.png`));
  expect(stable(await wt.styled(), home)).toMatchSnapshot(`${name}.txt`);
}

test("work items view (collapsed)", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await capture(wt, mock.home, "01-items");
});

test("work items view (item expanded + session activity)", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("Implement login form");
  await wt.press(KEY.down); // onto the session row
  await wt.press(KEY.right); // expand activity
  await wt.waitForText("bun test login");
  await wt.waitForStable();
  await capture(wt, mock.home, "02-items-expanded");
});

test("PRs view", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("2");
  await wt.waitForText("PRs on your work items");
  await wt.waitForStable();
  await capture(wt, mock.home, "03-prs");
});

// The GitHub-backend PRs page, used as the README hero. Seeds three PRs so all
// three sections render: one linked to an issue, one awaiting the viewer's review
// (authored by someone else), and one orphan the viewer authored. Distinct CI /
// review states make the badges representative. The linked PR's branch is the one
// the running `login` fixture session resolves to (`feature/login`), so expanding
// it reveals that live session and its recent activity nested under the PR — the
// whole point of the tool.
test("PRs view (GitHub backend)", async ({ launch, mock }) => {
  const ME = { login: "ada", name: "Ada Lovelace" };
  const prPass = (n: number, title: string, branch: string, author: string, extra: Record<string, unknown>) => ({
    number: n, title, url: `https://github.com/ada/appweb/pull/${n}`,
    headRefName: branch, isDraft: false, reviews: [],
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    mergeStateStatus: "CLEAN", createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-06-27T10:00:00.000Z", author: { login: author },
    closingIssuesReferences: [], body: "", ...extra,
  });
  // Branch `feature/login` matches the running login session; the issue link comes
  // from the closing reference, not the branch id.
  const linked = prPass(401, "Add login form validation", "feature/login", ME.login, {
    reviewDecision: "APPROVED", reviews: [{ author: { login: "grace" }, state: "APPROVED" }],
    closingIssuesReferences: [{ number: 301 }],
  });
  const review = prPass(377, "Upgrade the build toolchain", "grace/bump-toolchain", "grace", {
    reviewDecision: "REVIEW_REQUIRED",
  });
  const orphan = prPass(402, "Add request rate limiting to the API", "ada/rate-limiting", ME.login, {
    reviewDecision: "REVIEW_REQUIRED",
    statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null }],
  });
  await mock.setProvider("github");
  await mock.setGhState({
    authed: true,
    user: ME,
    issues: {
      "ada/appweb": [
        { number: 301, title: "Login form needs client-side validation", state: "OPEN", url: "https://github.com/ada/appweb/issues/301", labels: [], author: { login: ME.login } },
      ],
    },
    prs: {
      "ada/appweb": {
        "involves:ada": [linked],
        "author:ada": [linked, orphan],
        "review-requested:ada": [review],
      },
    },
  });

  const wt = await launch();
  await wt.waitForText("Created by me", 20000);
  await wt.waitForStable();
  await wt.press("2");
  await wt.waitForText("PRs on your issues");
  await wt.press(KEY.right); // expand PR #401 → reveals its session(s)
  await wt.waitForText("Implement login form");
  await wt.press(KEY.down); // onto the session row
  await wt.press(KEY.right); // expand its recent activity
  await wt.waitForText("bun test login");
  await wt.waitForStable();
  await capture(wt, mock.home, "03-prs-github");
});

test("sessions view (grouped by repo)", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");
  await wt.waitForStable();
  await capture(wt, mock.home, "04-sessions");
});

test("fresh-session agent picker, repo picker and branch prompt", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // session row
  await wt.press(KEY.down); // fresh row
  await wt.press(KEY.enter); // → agent picker (first step of every fresh flow)
  await wt.waitForText("Which agent should run this session?");
  await wt.waitForStable();
  await capture(wt, mock.home, "05a-agent-picker");

  await wt.press(KEY.enter); // pick Claude → repo picker
  await wt.waitForText("Pick a repo to create the worktree in");
  await wt.waitForStable();
  await capture(wt, mock.home, "05-repo-picker");

  await wt.press(KEY.enter); // pick top repo → branch prompt
  await wt.waitForText("New branch off origin/HEAD");
  await wt.waitForStable();
  await capture(wt, mock.home, "06-branch-prompt");
});

test("open-in-browser dialog", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press("o");
  await wt.waitForText("Open in browser");
  await wt.waitForStable();
  await capture(wt, mock.home, "07-open-dialog");
});
