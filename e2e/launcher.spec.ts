// End-to-end tests for the launcher TUI, rendered in a real browser via the
// wterm harness against a fully mocked environment (Azure DevOps, sessions on
// disk, tmux, git — all faked; see e2e/harness). Every test drives the UI with
// keystrokes and asserts on what the browser actually shows, or on what the
// launcher tried to spawn (recorded by the fake-bin shims).
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, KEY } from "./harness/test.ts";
import { RUNNING_TARGET, tmuxState } from "./harness/fixtures.ts";

// Regression guard for the "session-detection regresses often" area: a launcher
// scoped to a repo whose BASENAME CONTAINS A DOT (`kappflug.is-2`). The host
// session name is slugified (`.`→`-`), but live-session detection must key on the
// pane cwd / session id — never the lossy slug — so a session actually running in
// that context is detected as running and attachable, not shown cold.
test("path scope: a running session in a dotted-basename repo is detected as running", async ({ launch, mock }) => {
  // Keep the backend on ADO so this stays a pure detection test (a github.com
  // remote would force the GitHub backend — covered by its own test).
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // A repo whose basename has a dot, plus a worktree under it.
  const repo = join(mock.home, "git", "kappflug.is-2");
  const worktree = join(repo, ".claude", "worktrees", "add-keppni-7");
  const SID = "11112222-3333-4444-5555-666677778888";
  const shortId = SID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12); // → 111122223333

  // Write an on-disk claude session whose cwd is the dotted worktree.
  const logDir = join(mock.home, ".claude", "projects", "kappflug-dot");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    join(logDir, `${SID}.jsonl`),
    JSON.stringify({ type: "summary", cwd: worktree, gitBranch: "worktree-add-keppni-7", timestamp: "2026-06-25T10:00:00.000Z" }) +
      "\n" +
      JSON.stringify({ type: "ai-title", aiTitle: "Add keppni scoring", timestamp: "2026-06-25T10:00:01.000Z" }) +
      "\n",
  );

  // Make it live via an ID-LESS work-item window (`cl-wi-…`) whose pane cwd is the
  // dotted worktree — the cwd-attribution path (the fragile one), inside a
  // slugified host session `agendo-kappflug-is-2`.
  const READY = ["  ● Add keppni scoring", "  ────────────────────────────", "  ❯ ", "  ────────────────────────────", "  ? for shortcuts"].join("\n");
  await mock.setTmuxState({
    sessions: [RUNNING_TARGET, "agendo-kappflug-is-2"],
    windows: [{ session: "agendo-kappflug-is-2", index: 1, name: "cl-wi-777" }],
    panes: [
      { session: RUNNING_TARGET, window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
      { session: "agendo-kappflug-is-2", window: "cl-wi-777", cwd: worktree, placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: READY, "cl-wi-777": READY },
  });

  const wt = await launch({ args: [repo], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  // The dotted-repo session must appear AND be detected running (green ● / attach),
  // not cold. `shortId` is unused here but documents the canonical name it maps to.
  const screen = await wt.waitForText("Add keppni scoring");
  expect(shortId).toBe("111122223333");
  expect(screen).toContain("kappflug.is-2"); // scoped to the dotted context
  // The session row for it shows a running marker, not the cold ○.
  expect(screen).toMatch(/●[^\n]*Add keppni scoring|Add keppni scoring[^\n]*(attach|running)/);
  expect(screen).toContain("Running now"); // it surfaces in the running section
});

// A path-scoped launcher (`agendo <path>`) filters the TUI to sessions under the
// path, and `a` toggles back to the global view. The fixture home has sessions
// under three repos (appweb ×2, applib ×1, standalone ×1); scoping to appweb
// hides the other two until the toggle reveals them again.
test("path scope: agendo <path> filters sessions; 'a' toggles global", async ({ launch, mock }) => {
  // appweb has an ADO origin here, so the path context does NOT force GitHub — it
  // keeps the persisted ADO default (see the github-forcing test below).
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
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

// When the path context is a github.com repo, the launcher FORCES the GitHub
// backend even though the persisted default is ADO — proving provider detection
// from the git remote overrides the configured default for a path context.
test("path scope: a github.com remote forces the GitHub backend over the ADO default", async ({ launch, mock }) => {
  // Persisted default stays ADO (fixture seeds provider: "ado"); we do NOT call
  // setProvider. The default git shim serves a github.com origin for the repo, so
  // detectRepoProvider → "github" wins. Seed the fake gh so the GitHub view loads.
  mock.env.FAKE_GIT_ORIGIN_HOST = "github";
  await mock.setGhState({
    authed: true,
    user: { login: "ada", name: "Ada Lovelace" },
    issues: {
      "ada/appweb": [
        { number: 301, title: "Header overlaps on mobile", state: "OPEN", url: "https://github.com/ada/appweb/issues/301", labels: [], author: { login: "ada" } },
      ],
    },
    prs: { "ada/appweb": { "involves:ada": [], "author:ada": [], "review-requested:ada": [] } },
  });

  const appweb = join(mock.home, "repos", "appweb");
  const wt = await launch({ args: [appweb], cols: 140, rows: 40 });

  // GitHub vocab proves the override: ADO would show "Current sprint" / "Work
  // items"; GitHub shows "Created by me" / "Issues", and the issue from gh.
  const screen = await wt.waitForText("Created by me", 20000);
  expect(screen).toContain("Issues"); // GitHub itemsTab (ADO would say "Work items")
  expect(screen).not.toContain("Current sprint"); // the ADO primary header is gone
  expect(screen).toContain("Header overlaps on mobile"); // data pulled via the gh code path
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

test("expanded session shows the agent's task checklist with per-item status", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("Implement login form");
  await wt.press(KEY.down); // move onto the session row
  await wt.press(KEY.right); // expand it → lazy activity load (incl. checklist)

  // The latest TodoWrite checklist renders as three rows with distinct glyphs:
  // ✔ completed, ◐ in-progress, ☐ pending.
  const screen = await wt.waitForText("Wire up the submit handler", 8000);
  expect(screen).toMatch(/✔\s*Write the login form/);
  expect(screen).toMatch(/◐\s*Add validation/);
  expect(screen).toMatch(/☐\s*Wire up the submit handler/);
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

// ── hands-off auto-resume from the numbered limit dialog ────────────────────────
// The numbered limit dialog hides its reset time, so the resetAt-gated resume can
// never fire on it. With auto-resume ON the readiness poll must send ONE Escape to
// reveal the "resets <time>" notice, exactly once per limit window, and never a
// stray `continue`. These drive the real Ink poll against the fake tmux and assert
// on the recorded send-keys — the end-to-end proof the wiring closes the gap.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The active numbered dialog (a `─`-ruled table above it, no input-box rule below).
const LIMIT_DIALOG = [
  "  ● Done. Work item created.",
  "  ┌───────────┬─────────────────────────────────────┐",
  "  │ State     │ In Review                           │",
  "  └───────────┴─────────────────────────────────────┘",
  "  What do you want to do?",
  "  ❯ 1. Stop and wait for limit to reset",
  "    2. Add funds to continue with usage credits",
  "  Enter to confirm · Esc to cancel",
].join("\n");

// send-keys argv (from the fake-tmux log) aimed at the login window.
const keysTo = async (mock: { tmuxLog: () => Promise<string[][]> }, target: string) =>
  (await mock.tmuxLog()).filter((a) => a[0] === "send-keys" && a.includes(target));

test("auto-resume ON: the limit dialog is revealed with exactly ONE Escape, never 'continue'", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // Persist auto-resume ON (the poll reads the setting at mount); keep the ADO
  // backend the fixture pins so the model still loads.
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: true }));
  // Park the running session in the numbered dialog (no reset time shown).
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_DIALOG } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);

  // The poll sends the reveal Escape.
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).some((a) => a.includes("Escape")));
  // Several more poll cycles (READINESS_MS = 1500ms) must NOT re-send: once-only.
  await sleep(4000);
  let keys = await keysTo(mock, RUNNING_TARGET);
  expect(keys.filter((a) => a.includes("Escape"))).toHaveLength(1); // exactly one reveal
  expect(keys.some((a) => a.includes("continue"))).toBe(false); // never continue on reveal
  expect(keys.some((a) => a.includes("Enter"))).toBe(false);

  // Recovery clears the reveal guard: flip to a ready pane, then back to the dialog.
  await mock.setTmuxState({ ...tmuxState }); // default READY pane → "ready"
  await sleep(3000); // let the poll observe recovery and clear the guard
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_DIALOG } });
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).filter((a) => a.includes("Escape")).length >= 2);
  keys = await keysTo(mock, RUNNING_TARGET);
  expect(keys.filter((a) => a.includes("Escape"))).toHaveLength(2); // re-revealed for the new window
  expect(keys.some((a) => a.includes("continue"))).toBe(false);
});

test("auto-resume OFF: the limit dialog is left untouched (no Escape, no keystrokes)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // Setting OFF (default) — write it explicitly for clarity.
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: false }));
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_DIALOG } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  // Give the poll several cycles; with the setting off it must never mutate the pane.
  await sleep(4000);
  const keys = await keysTo(mock, RUNNING_TARGET);
  expect(keys).toHaveLength(0);
});

// ── session-discovery staleness: the fast timer must RE-SCAN, not just reconcile ──
// The liveness poll used to reconcile fresh tmux windows against the STALE session
// index from the last full loadModel, so a session started afterwards was dropped
// (never entered liveWindows, never readiness-polled, never auto-resumed). The
// timer now re-runs the cheap local scan (loadLocalSessions). These drive the real
// app + fake tmux and assert on the recorded tmux/ADO calls.

// Write an on-disk claude session so SessionIndex.build() discovers it on rescan.
async function writeSession(home: string, id: string, cwd: string, title: string, branch = "feature/late") {
  const logDir = join(home, ".claude", "projects", `late-${id.slice(0, 8)}`);
  await mkdir(logDir, { recursive: true });
  await writeFile(
    join(logDir, `${id}.jsonl`),
    JSON.stringify({ type: "summary", cwd, gitBranch: branch, timestamp: "2026-07-08T09:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "ai-title", aiTitle: title, timestamp: "2026-07-08T09:00:01.000Z" }) + "\n",
  );
}
const shortIdOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
const IDLE_READY = ["  ● idle", "  ────────────────────────────", "  ❯ ", "  ────────────────────────────", "  ? for shortcuts"].join("\n");

test("(a) a session started AFTER the initial load appears + is live-polled within one rescan (no `r`)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  await wt.waitForText("Running now");

  // A brand-new claude session appears on disk AND as a live id-bearing window,
  // both AFTER the initial full load — exactly the window the stale index dropped.
  const SID = "99998888-7777-6666-5555-444433332222";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "appweb");
  await writeSession(mock.home, SID, cwd, "Late arriving session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { ...tmuxState.captures, [win]: IDLE_READY },
  });

  // Without pressing `r`: the rescan discovers it, so it shows up in the list...
  await wt.waitForText("Late arriving session", 12000);
  // ...and its window entered liveWindows — proven by the readiness poll capturing
  // its pane (the poll only reads windows in model.liveWindows).
  await waitUntil(async () => (await mock.tmuxLog()).some((a) => a[0] === "capture-pane" && a.includes(win)));
});

test("(b) the fast rescan does NO backend fetch; work items stay put across several rescans", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000); // full load done (items rendered)

  await sleep(1000); // let any tail of the initial load's ADO calls settle
  const before = mock.ado.requests.length;

  // Add a new live session mid-run so rescans have real work + a model change.
  const SID = "12341234-5678-5678-9012-901290129012";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "appweb");
  await writeSession(mock.home, SID, cwd, "Another late session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { ...tmuxState.captures, [win]: IDLE_READY },
  });

  await sleep(6000); // several LIVE_POLL_MS rescans go by
  // Not one extra backend request — the slow fetch stays on the `r` cadence.
  expect(mock.ado.requests.length).toBe(before);
  // The network-derived work items are preserved from the last full load...
  const screen = await wt.waitForText("Add login screen");
  expect(screen).toContain("Add login screen");
  // ...and the rescan still surfaced the new session (proving it DID run).
  wt.write("3");
  await wt.waitForText("Another late session", 12000);
});

test("(d) a rescan must not re-fire `continue` for an already-resumed limited window", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: true }));
  // A limited pane whose reset time is an EXPLICIT past date (yesterday 3pm) — an
  // explicit month+day parses to that concrete instant (unlike a bare time, which
  // rolls forward and could land in the future near midnight), so it's reliably
  // in the past and within RESET_LOOKBACK → auto-resume fires on the first sample.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const yst = new Date(Date.now() - 24 * 3600_000);
  const label = `3:00pm ${MON[yst.getMonth()]} ${yst.getDate()}`;
  const rule = "  ─────────────────────────────────────────────";
  const LIMITED_PAST = [
    `  Claude usage limit reached. Your limit will reset at ${label}.`,
    rule,
    "  ❯ ",
    rule,
    "  ? for shortcuts",
  ].join("\n");
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMITED_PAST } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);

  // It fires the resume exactly once.
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).some((a) => a.includes("continue")));
  const continues = async () => (await keysTo(mock, RUNNING_TARGET)).filter((a) => a.includes("continue")).length;
  expect(await continues()).toBe(1);

  // Now force a rescan MODEL CHANGE (a new session appears) → the readiness effect
  // re-arms and re-samples. The frozen resetAt + fire-once guard must survive the
  // rescan, so `continue` is NOT sent again.
  const SID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "appweb");
  await writeSession(mock.home, SID, cwd, "Bystander session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { [RUNNING_TARGET]: LIMITED_PAST, [win]: IDLE_READY },
  });
  // Wait for the rescan to pick up the bystander (proves the re-arm happened)…
  wt.write("3");
  await wt.waitForText("Bystander session", 12000);
  await sleep(3000); // …and several more samples of the still-limited login pane.
  expect(await continues()).toBe(1); // still exactly one — never re-fired
});
