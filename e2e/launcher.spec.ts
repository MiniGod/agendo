// End-to-end tests for the launcher TUI, rendered in a real browser via the
// wterm harness against a fully mocked environment (Azure DevOps, sessions on
// disk, tmux, git — all faked; see e2e/harness). Every test drives the UI with
// keystrokes and asserts on what the browser actually shows, or on what the
// launcher tried to spawn (recorded by the fake-bin shims).
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import { RUNNING_TARGET } from "./harness/fixtures.ts";

// A path-scoped launcher (`agendo <path>`) filters the TUI to sessions under the
// path, and `a` toggles back to the global view. The fixture home has sessions
// under three repos (appweb ×2, applib ×1, standalone ×1); scoping to appweb
// hides the other two until the toggle reveals them again.
test("path scope: agendo <path> filters sessions; 'a' toggles global", async ({ launch, mock }) => {
  const appweb = join(mock.home, "repos", "appweb");
  const wt = await launch({ args: [appweb], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  let screen = await wt.waitForText("appweb (2)");

  // Scoped: the scope line names the agendo-namespaced host session + advertises
  // the toggle; only the appweb repo is present — applib / standalone filtered out.
  expect(screen).toContain("agendo-appweb"); // host session is agendo-<context>, not bare "appweb"
  expect(screen).toContain("show all"); // scoped-state hint (a → show all)
  expect(screen).toContain("Implement login form"); // running appweb session
  expect(screen).not.toContain("applib (1)");
  expect(screen).not.toContain("standalone (1)");

  // Toggle to global with `a`: the other repos reappear, and the scope line flips
  // to a "rescope to agendo-appweb" hint.
  wt.write("a");
  screen = await wt.waitForText("applib (1)");
  expect(screen).toContain("standalone (1)");
  expect(screen).toContain("global — all paths");
  expect(screen).toContain("rescope to agendo-appweb");

  // Toggle back: scoped again, other repos hidden once more.
  wt.write("a");
  screen = await wt.waitForText("show all");
  expect(screen).not.toContain("applib (1)");
});

// Poll an async predicate until it's true, or fail. Used for side effects that
// land in the fake-bin logs slightly after a keystroke.
async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test("work items view: sprint grouping, PR badge, running count, backlog toggle", async ({ launch }) => {
  const wt = await launch();
  const screen = await wt.waitForText("Current sprint", 20000);

  // Current iteration name comes from the mocked ADO iterations endpoint.
  expect(screen).toContain("Sprint 42");
  // WI 101 with its linked PR (badge shows approval 1/1 + ✓ CI from policy
  // enrichment) and a running session (● 1/1).
  expect(screen).toContain("Add login screen");
  expect(screen).toMatch(/Add login screen.*!5001 1\/1 ✓.*●\s*1\/1/);
  // WI 102 has no PR but a session matched by id-in-branch.
  expect(screen).toContain("Fix crash on startup");
  // WI 103 is in an older sprint → collapsed under the backlog toggle.
  expect(screen).toContain("Everything else assigned (1)");
  expect(screen).not.toContain("Update docs");
});

test("backlog toggle expands to reveal the older-sprint item", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Everything else assigned (1)", 20000);
  await wt.waitForStable();
  // Move to the toggle row (item101 → item102 → toggle) and open it.
  await wt.press(KEY.down);
  await wt.press(KEY.down);
  await wt.press(KEY.enter);
  const screen = await wt.waitForText("Update docs");
  expect(screen).toMatch(/#103\s+Task\s+New\s+Update docs/);
});

test("PRs view: linked PR with work-item context and orphan draft PR", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("2");
  const screen = await wt.waitForText("PRs on your work items");
  // Linked PR row: approval ✓ 1/1, CI ✓ pass, the work-item context cell.
  expect(screen).toMatch(/!5001\s+✓ 1\/1\s+✓ pass\s+Add login screen\s+#101 User Story/);
  expect(screen).toContain("PRs without a work item");
  // Orphan PR 6001 is a draft on the applib repo (draft replaces the CI cell).
  // Its context cell shows repo:branch (truncated by the narrow CONTEXT column).
  expect(screen).toMatch(/!6001\s+—\s+draft\s+Experiment spike/);
  expect(screen).toMatch(/applib:draft\/exp/);
  // The review section surfaces Grace's PRs where Ada is a requested reviewer.
  expect(screen).toContain("Awaiting your review");
  expect(screen).toMatch(/!7001\s+✓ 0\/1\s+● running\s+Refactor the parser/);
  expect(screen).toMatch(/!7002\s+✓ 1\/1\s+✓ pass\s+Speed up startup/);
});

test("sessions view: Running now section plus per-repo groups", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  const screen = await wt.waitForText("Running now");
  // The single live session surfaces in Running now (green ●, attach hint).
  // Its pane capture is an idle claude TUI → readiness "ready".
  expect(screen).toMatch(/Running now\s+\(1\)/);
  expect(screen).toContain("Implement login form");
  expect(screen).toContain("(ready → attach)");
  // Repos grouped, ranked by session count: appweb(2), applib(1), standalone(1).
  expect(screen).toContain("appweb (2)");
  expect(screen).toContain("applib (1)");
  expect(screen).toContain("standalone (1)");
});

test("expanding a work item reveals its session and lazily-loaded activity", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("Implement login form");
  await wt.press(KEY.down); // move onto the session row
  await wt.press(KEY.right); // expand it → triggers lazy activity load
  const screen = await wt.waitForText("bun test login", 8000);
  // Last prompt header + parsed action lines from the session's JSONL log.
  expect(screen).toContain('"Add a login form with validation"');
  expect(screen).toContain("login.tsx");
  expect(screen).toContain("Edit");
  expect(screen).toContain("+ start a fresh session…");

  // Capture a reference screenshot of the fully-rendered TUI for documentation.
  await wt.screenshot(join(import.meta.dirname, "screenshots", "launcher.png"));
});

test("open-in-browser dialog opens the work item via xdg-open", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  wt.write("o"); // open-in-browser dialog for the hovered WI 101
  const dialog = await wt.waitForText("Open in browser");
  expect(dialog).toContain("PR !5001");
  expect(dialog).toContain("issue #101");

  wt.write("i"); // open the issue (work item)
  await wt.waitForText("Opening #101 in browser…");
  await waitUntil(async () =>
    (await mock.callLog()).some((l) => l.startsWith("xdg-open ") && l.includes("/_workitems/edit/101")),
  );
});

test("fresh-session flow creates a worktree and launches claude in tmux", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // onto the session row
  await wt.press(KEY.down); // onto "+ start a fresh session…"
  await wt.press(KEY.enter); // → agent picker (first step of every fresh flow)

  // Every fresh flow now begins by choosing the agent; Claude is the first entry.
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // pick Claude → repo picker

  await wt.waitForText("Pick a repo to create the worktree in");
  await wt.press(KEY.enter); // pick the top repo (appweb)

  const branchScreen = await wt.waitForText("New branch off origin/HEAD");
  // Default branch derived from the work item id + slugified title.
  expect(branchScreen).toContain("worktree-add-login-screen-101");
  await wt.press(KEY.enter); // create worktree & launch

  const expectedCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "add-login-screen-101");

  // git worktree add was invoked for that path (fake git just mkdir's it).
  await waitUntil(async () =>
    (await mock.callLog()).some(
      (l) => l.startsWith("git ") && l.includes("worktree") && l.includes(expectedCwd),
    ),
  );
  // claude was launched in a tmux session named cl-wi-101 in the new worktree.
  await waitUntil(async () => {
    const log = await mock.tmuxLog();
    return log.some(
      (argv) =>
        argv[0] === "new-session" &&
        argv.includes("cl-wi-101") &&
        argv.includes(expectedCwd) &&
        argv.includes("claude"),
    );
  });
});

test("renders identically with the running session flipped off", async ({ launch, mock }) => {
  // Flip fake-tmux to have no live sessions before launch: badge goes gray.
  await mock.setTmuxState({ sessions: [], windows: [], panes: [] });
  const wt = await launch();
  const screen = await wt.waitForText("Add login screen", 20000);
  // No green running count for WI 101 now — just "1 sess".
  expect(screen).toMatch(/Add login screen.*1 sess/);
  expect(screen).not.toContain("● 1/1");
  // Sanity: the canonical target we toggled is the login session's.
  expect(RUNNING_TARGET).toBe("cl-claude-loginsession");
});
