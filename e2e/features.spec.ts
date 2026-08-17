// Coverage for the launcher's feature surface: the identity switcher, the
// "Awaiting your review" PR section, CI / merge-gate status cells, the PR /
// session sort + grouping toggles, fuzzy search, session backlinks, restored
// placeholders, and the Settings page / backend picker (the GitHub-provider
// work). Same fully-mocked harness as launcher.spec.ts — every assertion is on
// what the browser-rendered TUI actually shows, or on what the launcher spawned.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import { sessionName, RUNNING_TARGET, LOGIN_SESSION_ID, CRASH_SESSION_ID, COPILOT_SESSION_ID } from "./harness/fixtures.ts";
import type { MockEnv } from "./harness/mockEnv.ts";
import type { WebTerminal } from "./harness/wterm.ts";

// Poll an async predicate until true or fail (for effects that land in the
// fake-bin logs slightly after a keystroke).
async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test("identity switcher: switching to a teammate reloads their work items", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  // `u` opens the roster. The authenticated user is marked "(you)"; the
  // configured team's members are listed alphabetically.
  await wt.press("u");
  const picker = await wt.waitForText("Switch who you are");
  expect(picker).toContain("Ada Lovelace");
  expect(picker).toContain("(you)");
  expect(picker).toContain("Grace Hopper");
  expect(picker).toContain("Alan Turing");

  // Roster order is Ada, Alan, Grace (by display name) — two downs lands on Grace.
  await wt.press(KEY.down);
  await wt.press(KEY.down);
  await wt.press(KEY.enter);

  // Work items reload for Grace: her story shows, Ada's items are gone, and the
  // header reflects the switch (no "(you)" since she isn't the az user).
  const screen = await wt.waitForText("Tune the detector", 20000);
  expect(screen).toContain("as Grace Hopper");
  expect(screen).not.toContain("Add login screen");
  expect(screen).not.toContain("Fix crash on startup");
});

test("PR view sort toggles between created and last-updated order", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("2");
  await wt.waitForText("Awaiting your review");

  // Default sort is by creation date: 7001 (created Jun 18) above 7002 (Jun 12).
  let screen = await wt.screen();
  expect(screen).toContain("CREATED");
  expect(screen).toMatch(/Refactor the parser[\s\S]*Speed up startup/);

  // `s` flips to last-updated: 7002 (updated Jun 24) now above 7001 (Jun 19).
  await wt.press("s");
  screen = await wt.waitForText("UPDATED");
  expect(screen).toMatch(/Speed up startup[\s\S]*Refactor the parser/);
});

test("PR view groups by repo on demand", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("2");
  let screen = await wt.waitForText("PRs on your work items");
  // Ungrouped by default — the hint offers to group, and PR titles are visible.
  expect(screen).toContain("g group");
  expect(screen).toContain("Refactor the parser");

  // `g` collapses each section into per-repo subgroups (collapsed by default),
  // so the PR titles tuck away behind repo toggles like "appweb (1)".
  await wt.press("g");
  screen = await wt.waitForText("g ungroup");
  expect(screen).toMatch(/▸ appweb \(\d+\)/);
  expect(screen).toMatch(/▸ applib \(\d+\)/);
  expect(screen).not.toContain("Refactor the parser"); // hidden in a collapsed group
});

test("PR view re-reads mutable PR state on refresh — a completed PR drops out (G2)", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("2"); // PR view
  // PR 5001 ("Add login screen") is linked to WI 101 → under "PRs on your work items".
  await wt.waitForText("PRs on your work items");
  let screen = await wt.waitForText("Add login screen");
  expect(screen).toContain("!5001");

  // The PR completes server-side. Its status lives behind ADO's per-load PR
  // cache, which used to freeze at "active" for the whole process — so a reload
  // kept showing it as an in-flight linked PR (while it vanished from orphans).
  mock.setAdoPr(5001, { status: "completed" });
  await wt.press("r"); // manual reload → loadModel → clearPrCache (the fix)

  // With the cache invalidated on reload, the completed PR is re-read and hidden
  // (the linked view is only about work still in flight).
  await waitUntil(async () => !(await wt.screen()).includes("Add login screen"), 15000);
  screen = await wt.screen();
  expect(screen).not.toContain("Add login screen");
  expect(screen).not.toContain("!5001");
});

test("sessions view sort toggles between updated and created", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");

  // Sessions default to last-updated order; `s` flips the label to created.
  let screen = await wt.screen();
  expect(screen).toContain("s sort: updated");
  await wt.press("s");
  screen = await wt.waitForText("s sort: created");
  expect(screen).toContain("s sort: created");
});

test("fuzzy search filters the work items view", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  // `/` opens the search box; typing filters to a flat fuzzy-matched list.
  await wt.press("/");
  await wt.waitForText("search");
  await wt.press("crash", 300);
  const screen = await wt.waitForText("Search results");
  expect(screen).toContain("Fix crash on startup"); // 102 matches
  expect(screen).not.toContain("Add login screen"); // 101 filtered out

  // esc clears the search and restores the full list.
  await wt.press(KEY.escape);
  const restored = await wt.waitForText("Add login screen");
  expect(restored).not.toContain("Search results");
});

test("fuzzy search filters the PRs view", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("2");
  await wt.waitForText("Awaiting your review");

  await wt.press("/");
  await wt.press("refactor", 300);
  const screen = await wt.waitForText("Search results");
  expect(screen).toContain("Refactor the parser"); // 7001 matches
  expect(screen).not.toContain("Add login screen"); // 5001 filtered out
  expect(screen).not.toContain("Speed up startup"); // 7002 filtered out
});

test("fuzzy search filters the sessions view", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");

  await wt.press("/");
  await wt.press("experiment", 300);
  const screen = await wt.waitForText("Search results");
  expect(screen).toContain("Experiment spike"); // the copilot session
  expect(screen).not.toContain("Implement login form"); // login session filtered out
});

test("sessions view shows each session's linked PR / work item backlink", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  const screen = await wt.waitForText("Running now");
  // The login session's branch matches PR 5001, which links to work item 101.
  expect(screen).toMatch(/Implement login form.*!5001 → WI 101/);
});

test("resuming a Copilot session launches copilot (native support)", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");

  // Filter to the copilot session, focus the result, and resume it.
  await wt.press("/");
  await wt.press("experiment", 300);
  await wt.waitForText("Search results");
  await wt.press(KEY.down); // focus the first (only) result
  await wt.press(KEY.enter); // resume it (handover → tmux attach)

  // Copilot is resumed in its own tmux session with `copilot --resume=<id>` —
  // no longer the old "resume isn't wired yet" refusal.
  const copilotTarget = sessionName("copilot", COPILOT_SESSION_ID);
  await waitUntil(async () => {
    const log = await mock.tmuxLog();
    return log.some(
      (argv) =>
        argv[0] === "new-session" &&
        argv.includes(copilotTarget) &&
        argv.includes("copilot") &&
        argv.some((a) => a === `--resume=${COPILOT_SESSION_ID}`),
    );
  });
});

test("sessions view badges a restored-but-unopened placeholder tab", async ({ launch, mock }) => {
  // Give the crash session a dormant restore placeholder window (idle bash
  // awaiting a keypress) alongside the running login session.
  const crashTarget = sessionName("claude", CRASH_SESSION_ID);
  await mock.setTmuxState({
    sessions: [RUNNING_TARGET],
    windows: [],
    panes: [
      { session: RUNNING_TARGET, window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
      { session: "claude-launcher", window: crashTarget, cwd: "/run/crash", placeholder: true },
    ],
    captures: {},
  });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  const screen = await wt.waitForText("restored · press to resume");
  // The placeholder is the crash session, shown as restored (⏸), not running.
  expect(screen).toMatch(/Investigate startup crash.*restored · press to resume/);
});

test("a session under a legacy tmux window attaches to it without duplicating", async ({ launch, mock }) => {
  // The login session is live only under a LEGACY work-item window (cl-wi-101),
  // the pre-rename layout — no canonical cl-claude-<id> session exists. The app
  // must attribute it by cwd and, on resume, attach to that exact window rather
  // than spawn a duplicate cl-claude-<id> (the regression 5cadb58 guards against).
  const loginCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
  await mock.setTmuxState({
    sessions: [],
    windows: [{ session: "claude-launcher", index: 1, name: "cl-wi-101" }],
    panes: [{ session: "claude-launcher", window: "cl-wi-101", cwd: loginCwd, placeholder: false }],
    captures: {},
  });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  const screen = await wt.waitForText("Running now");
  // Attributed to the legacy window by cwd → shown running.
  expect(screen).toMatch(/Running now\s+\(1\)/);
  expect(screen).toContain("Implement login form");

  await wt.press(KEY.down); // ＋ new session → the running login session
  await wt.press(KEY.enter); // resume → attach

  // It attaches to the existing cl-wi-101 window; no cl-claude-… duplicate is spawned.
  const canonical = sessionName("claude", LOGIN_SESSION_ID); // cl-claude-loginsession
  await waitUntil(async () => {
    const log = await mock.tmuxLog();
    return log.some((argv) => argv[0] === "attach-session" && argv.includes("cl-wi-101"));
  });
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "new-session" && argv.includes(canonical))).toBe(false);
});

test("move a session to another Claude profile — picker + move, and a refusal while it runs", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");

  // The login session is LIVE in tmux. agendo can't establish that a running
  // claude is safely idle (nor gracefully exit it), so `m` refuses outright
  // rather than move files out from under it.
  await wt.press("/");
  await wt.press("login", 300);
  await wt.waitForText("Search results");
  await wt.press(KEY.down); // focus the result
  await wt.press("m");
  expect(await wt.waitForText("before moving it to another profile")).toContain("Implement login form");

  // The crash session isn't running, so the picker opens: the profile it lives
  // in is shown but not offered, and the (session-less) second profile is.
  await wt.press(KEY.escape); // cancel the search
  await wt.press("/");
  await wt.press("crash", 300);
  await wt.waitForText("Search results");
  await wt.press(KEY.down);
  await wt.press("m");
  const picker = await wt.waitForText("Move to another Claude profile");
  expect(picker).toContain("Investigate startup crash");
  expect(picker).toMatch(/\.claude\s+lives here now/);
  expect(picker).toMatch(/\.claude-work\s+move here/);

  // Enter moves it: the transcript (and its sidecar dir) land under the target
  // profile's projects/, keeping the encoded-cwd dir name.
  await wt.press(KEY.enter);
  expect(await wt.waitForText("Moved", 20000)).toContain(".claude-work");
  await waitUntil(async () =>
    existsSync(join(mock.home, ".claude-work", "projects", "appweb-crash", `${CRASH_SESSION_ID}.jsonl`)) &&
    !existsSync(join(mock.home, ".claude", "projects", "appweb-crash", `${CRASH_SESSION_ID}.jsonl`)),
  );

  // …and the reloaded session now reports the new profile in its meta lines.
  await wt.press(KEY.right); // expand the session row
  expect(await wt.waitForText("profile", 20000)).toContain(".claude-work");
});

test("a session resumed while the profile picker is open is not moved out from under it", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");

  // Open the picker for the idle crash session.
  await wt.press("/");
  await wt.press("crash", 300);
  await wt.waitForText("Search results");
  await wt.press(KEY.down);
  await wt.press("m");
  await wt.waitForText("Move to another Claude profile");

  // …then it gets resumed behind the launcher's back while the picker sits open
  // (a keypress in a restore-placeholder tab from another tmux client, a second
  // agendo). The refusal is the whole safety story for a live agent, so it has to
  // be re-derived from tmux at commit time, not trusted from when the picker opened.
  const crashTarget = sessionName("claude", CRASH_SESSION_ID);
  await mock.setTmuxState({
    sessions: [RUNNING_TARGET, crashTarget],
    windows: [],
    panes: [
      { session: RUNNING_TARGET, window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
      { session: crashTarget, window: crashTarget, cwd: "/run/crash", placeholder: false },
    ],
    captures: {},
  });

  await wt.press(KEY.enter);
  expect(await wt.waitForText("started running")).toContain("Investigate startup crash");
  // Not a single file moved.
  const rel = ["projects", "appweb-crash", `${CRASH_SESSION_ID}.jsonl`];
  expect(existsSync(join(mock.home, ".claude", ...rel))).toBe(true);
  expect(existsSync(join(mock.home, ".claude-work", ...rel))).toBe(false);
});

// ── moving a session that has a restored-but-unopened tab on screen ──────────
// tmux bakes a placeholder's resume command into the pane's script when the
// window is created, so a move that only rewrites the saved snapshot leaves the
// VISIBLE tab resuming against the profile the session just left. Rebuilding it
// means killing and respawning a window, which is the highest-blast-radius thing
// in this feature — hence one test per guard.
const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
const CRASH_TAB_CWD = (home: string) => join(home, "repos", "appweb", ".claude", "worktrees", "fix-crash-102");

/**
 * Give the crash session a saved restore tab plus the tmux state backing it,
 * boot the launcher, and open the profile picker on that session — the common
 * prelude of the three tests below, which differ only in the state they set up.
 */
async function pickerOnCrashSession(
  launch: (opts?: { cols?: number; rows?: number; args?: string[] }) => Promise<WebTerminal>,
  mock: MockEnv,
  state: { tabCwd: string; tabArgv: string[]; windows: unknown[]; panes: unknown[] },
): Promise<WebTerminal> {
  await mkdir(join(mock.home, ".agendo", "restore"), { recursive: true });
  await writeFile(
    join(mock.home, ".agendo", "restore", "agendo.json"),
    JSON.stringify({
      tabs: [
        { name: CRASH_TARGET, cwd: state.tabCwd, title: "Investigate startup crash", argv: state.tabArgv },
      ],
    }),
  );
  await mock.setTmuxState({
    sessions: [RUNNING_TARGET, "agendo"],
    windows: state.windows,
    panes: [{ session: RUNNING_TARGET, window: RUNNING_TARGET, cwd: "/run/login", placeholder: false }, ...state.panes],
    captures: {},
  });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("3");
  await wt.waitForText("Running now");
  await wt.press("/");
  await wt.press("crash", 300);
  await wt.waitForText("Search results");
  await wt.press(KEY.down);
  await wt.press("m");
  await wt.waitForText("Move to another Claude profile");
  await wt.press(KEY.enter);
  return wt;
}

/**
 * Did the launcher kill the crash session's window in the launcher host session?
 *
 * BOTH halves of the `session:window` target are `=`-pinned. The `=` is
 * per-component (man tmux), so pinning only the session leaves the window half
 * resolvable by prefix/fnmatch — and managed names nest (`cl-pr-5` ⊂ `cl-pr-50`),
 * which is how a kill lands on the wrong tab of the same launcher.
 */
const CRASH_WINDOW_TARGET = `=agendo:=${CRASH_TARGET}`;
const killedCrashWindow = (log: string[][]) =>
  log.some((a) => a[0] === "kill-window" && a.includes(CRASH_WINDOW_TARGET));

test("moving a session rebuilds its restored-but-unopened tab against the new profile", async ({ launch, mock }) => {
  const cwd = CRASH_TAB_CWD(mock.home);
  await mkdir(cwd, { recursive: true }); // the tab's dir must exist — see the guard test below
  const wt = await pickerOnCrashSession(launch, mock, {
    tabCwd: cwd,
    tabArgv: ["env", `CLAUDE_CONFIG_DIR=${join(mock.home, ".claude")}`, "claude", "--resume", CRASH_SESSION_ID],
    // A real window in the launcher's host session, flagged as an unloaded placeholder.
    windows: [{ session: "agendo", index: 1, window: CRASH_TARGET, cwd, placeholder: true }],
    panes: [{ session: "agendo", window: CRASH_TARGET, cwd, placeholder: true }],
  });

  // The notice says so explicitly, so the rebuilt tab isn't a silent side effect.
  expect(await wt.waitForText("restored tab repointed", 20000)).toContain("Moved");

  // The old window is killed and an equivalent one respawned carrying the NEW
  // profile — a placeholder pane's command can't be amended in place.
  await waitUntil(async () => {
    const log = await mock.tmuxLog();
    const killed = log.findIndex((a) => a[0] === "kill-window" && a.includes(CRASH_WINDOW_TARGET));
    const spawned = log.findIndex(
      (a) =>
        a[0] === "new-window" &&
        a.includes(CRASH_TARGET) &&
        a.some((tok) => tok.includes(`CLAUDE_CONFIG_DIR=${join(mock.home, ".claude-work")}`)),
    );
    return killed >= 0 && spawned > killed;
  });
  // …and no respawn still carries the profile the session left.
  const log = await mock.tmuxLog();
  expect(
    log.some((a) => a[0] === "new-window" && a.some((t) => t.includes(`CLAUDE_CONFIG_DIR=${join(mock.home, ".claude")} `))),
  ).toBe(false);
});

test("a placeholder tab whose directory is gone is left alone, not killed without a replacement", async ({ launch, mock }) => {
  // Same setup, minus the tab's working directory (a pruned worktree).
  // `new-window -c <gone>` fails and tmuxQuiet swallows the error, so killing
  // first would destroy a visible tab and put nothing back — as a side effect of
  // a move that otherwise SUCCEEDED. Leaving the stale tab is strictly better.
  const cwd = CRASH_TAB_CWD(mock.home); // deliberately never created
  const wt = await pickerOnCrashSession(launch, mock, {
    tabCwd: cwd,
    tabArgv: ["claude", "--resume", CRASH_SESSION_ID],
    windows: [{ session: "agendo", index: 1, window: CRASH_TARGET, cwd, placeholder: true }],
    panes: [{ session: "agendo", window: CRASH_TARGET, cwd, placeholder: true }],
  });

  // The move still lands…
  const notice = await wt.waitForText("Moved", 20000);
  expect(existsSync(join(mock.home, ".claude-work", "projects", "appweb-crash", `${CRASH_SESSION_ID}.jsonl`))).toBe(true);
  // …but the tab was not touched, and the notice doesn't claim it was.
  expect(notice).not.toContain("restored tab repointed");
  expect(killedCrashWindow(await mock.tmuxLog())).toBe(false);
});

test("the placeholder flag authorizing a kill is read from THIS host session, not a same-named window elsewhere", async ({ launch, mock }) => {
  // The same session is tabbed in two launchers. In ours the tab has already been
  // woken into a real agent (flag cleared); in the OTHER launcher it's still a
  // dormant placeholder. Reading the flag from a global window list would let the
  // other launcher's flag authorize killing the live window in ours.
  const cwd = CRASH_TAB_CWD(mock.home);
  await mkdir(cwd, { recursive: true });
  const wt = await pickerOnCrashSession(launch, mock, {
    tabCwd: cwd,
    tabArgv: ["env", `CLAUDE_CONFIG_DIR=${join(mock.home, ".claude")}`, "claude", "--resume", CRASH_SESSION_ID],
    windows: [
      { session: "agendo", index: 1, window: CRASH_TARGET, cwd, placeholder: false }, // ours: woken
      { session: "agendo-other", index: 1, window: CRASH_TARGET, cwd, placeholder: true }, // theirs: dormant
    ],
    // Only the other launcher's pane is reported, so the session still reads as
    // not-running and the move itself is allowed to proceed.
    panes: [{ session: "agendo-other", window: CRASH_TARGET, cwd, placeholder: true }],
  });

  const notice = await wt.waitForText("Moved", 20000);
  expect(notice).not.toContain("restored tab repointed");
  expect(killedCrashWindow(await mock.tmuxLog())).toBe(false);
});

test("settings page shows the backend + per-provider auth, and opens the backend picker", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();

  // `,` opens Settings (the new home for backend + identity, replacing the old
  // inline footer toggles).
  await wt.press(",");
  const settings = await wt.waitForText("Settings");
  expect(settings).toContain("Backend"); // the current backend row…
  expect(settings).toContain("Azure DevOps"); // …forced to ADO by the fixture state.json
  expect(settings).toContain("Viewing as");
  expect(settings).toContain("Ada Lovelace (you)");

  // The Authentication section probes each provider's CLI asynchronously. The
  // fake `gh` is installed but logged out, so its line resolves to a definite
  // "not authenticated" (not the machine's real gh state).
  const authed = await wt.waitForText("not authenticated", 8000);
  expect(authed).toMatch(/gh installed · not authenticated/);

  // Enter on the Backend row opens the picker; both backends are listed and ADO
  // is marked current (●). We do NOT select GitHub here (that reloads the model);
  // the GitHub backend gets its own end-to-end test.
  await wt.press(KEY.enter);
  const picker = await wt.waitForText("Switch backend");
  expect(picker).toContain("Azure DevOps");
  expect(picker).toContain("GitHub");
  expect(picker).toMatch(/●.*Azure DevOps/); // ADO is the current backend
  expect(picker).toContain("via gh"); // GitHub is installed (fake gh on PATH)

  await wt.press(KEY.escape); // back to settings
  await wt.waitForText("Settings");
});
