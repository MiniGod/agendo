// Pausing and killing a session: `agendo pause <id>` and the list's `p` / `x` /
// `X` (src/app/sessionEnd/, src/ui/actions/sessionEnd.ts).
//
// Everything runs against the fake tmux, which deletes what a kill matched and
// lands a `new-window -t <host>` in that host — so a pause shows up as the agent
// tab going and a flagged placeholder of the same name taking its place, and a
// mistargeted kill as the wrong entry vanishing. No real tmux server is started.
//
// What every test also holds: nothing on disk but one restore-snapshot entry is
// written. The worktree (with uncommitted work in it) and the transcript survive.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import { REPO_ROOT, type MockEnv } from "./harness/mockEnv.ts";
import { BUSY_PANE, CRASH_SESSION_ID, LOGIN_SESSION_ID, RUNNING_TARGET, tmuxState } from "./harness/fixtures.ts";
import type { WebTerminal } from "./harness/wterm.ts";

const shortIdOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
const SHORT_ID = shortIdOf(LOGIN_SESSION_ID);
const CRASH_TARGET = `cl-claude-${shortIdOf(CRASH_SESSION_ID)}`;
const TITLE = "Implement login form";

/** The CLI, without blocking the event loop (the mock backends live in this process). */
function agendoAsync(env: Record<string, string>, ...args: string[]) {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], { cwd: REPO_ROOT, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res) =>
    child.on("close", (code) => res({ code, stdout, stderr })),
  );
}

const killsIn = (log: string[][]) => log.filter((a) => a[0] === "kill-window" || a[0] === "kill-session" || a[0] === "kill-pane");
const windowsOf = async (mock: MockEnv) =>
  (await mock.getTmuxState()).windows.map((w: { name: string; placeholder?: boolean }) => `${w.name}${w.placeholder ? " ⏸" : ""}`);
const restoreFile = (mock: MockEnv) => join(mock.home, ".agendo", "restore", "agendo.json");

/**
 * The login session running as tab 3 of the `agendo` host session, its worktree
 * on disk with uncommitted work in it — the shape a session started from the
 * menu has, and the one a pause needs.
 */
async function loginTab(mock: MockEnv, capture = tmuxState.captures[RUNNING_TARGET]): Promise<string> {
  const worktree = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, "WORK.txt"), "uncommitted work");
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 3, name: RUNNING_TARGET },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: RUNNING_TARGET, cwd: worktree, placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: capture },
  });
  return worktree;
}

/** The disk guarantee: the worktree's uncommitted file and the transcript are still there, and no git ran. */
async function expectNothingOnDiskTouched(mock: MockEnv, worktree: string): Promise<void> {
  expect(existsSync(join(worktree, "WORK.txt"))).toBe(true);
  expect(existsSync(join(mock.home, ".claude", "projects", "appweb-login", `${LOGIN_SESSION_ID}.jsonl`))).toBe(true);
  expect((await mock.callLog()).some((l) => l.startsWith("git ") && l.includes("worktree"))).toBe(false);
}

// ── `agendo pause` ───────────────────────────────────────────────────────────

test("agendo pause ends the agent and leaves its tab paused, restorable and resumable", async ({ mock }) => {
  const worktree = await loginTab(mock);

  const r = await agendoAsync(mock.env, "pause", SHORT_ID);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`paused ${RUNNING_TARGET}`);
  expect(r.stdout).toContain(`resume ${SHORT_ID}`);

  // The agent's tab went by its pinned location, and a flagged placeholder of the
  // same name took its place in the SAME host session.
  const log = await mock.tmuxLog();
  expect(killsIn(log)).toEqual([["kill-window", "-t", "=agendo:3"]]);
  expect(log.some((a) => a[0] === "new-window" && a.includes("=agendo") && a.includes(RUNNING_TARGET))).toBe(true);
  expect(await windowsOf(mock)).toEqual(["launcher", `${RUNNING_TARGET} ⏸`]);
  // The snapshot holds the tab (a close would have dropped it), so the paused tab
  // also survives a launcher restart — resuming the same session by id.
  const tabs = JSON.parse(await readFile(restoreFile(mock), "utf-8")).tabs;
  expect(tabs.map((t: { name: string }) => t.name)).toEqual([RUNNING_TARGET]);
  expect(tabs[0].argv.join(" ")).toContain(LOGIN_SESSION_ID);

  const list = await agendoAsync(mock.env, "list");
  expect(list.stdout).toMatch(/⏸\s+paused/);
  await expectNothingOnDiskTouched(mock, worktree);

  // Pausing it again is a success that does nothing.
  const again = await agendoAsync(mock.env, "pause", SHORT_ID);
  expect(again.code).toBe(0);
  expect(again.stdout).toContain("already paused");
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:3"]]);
});

test("agendo pause refuses a session with work in flight unless forced", async ({ mock }) => {
  await loginTab(mock, BUSY_PANE);

  const r = await agendoAsync(mock.env, "pause", SHORT_ID);
  expect(r.code).toBe(2);
  expect(r.stderr).toContain('Not pausing: session looks "busy"');
  expect(killsIn(await mock.tmuxLog())).toEqual([]);

  const forced = await agendoAsync(mock.env, "pause", "--force", SHORT_ID);
  expect(forced.code).toBe(0);
  expect(forced.stdout).toContain(`(was "busy")`);
  expect(await windowsOf(mock)).toEqual(["launcher", `${RUNNING_TARGET} ⏸`]);
});

test("agendo pause refuses a session that is no launcher tab — there is no tab to leave paused", async ({ mock }) => {
  // The default fixture: the agent runs as a tmux session of its own.
  await mock.setTmuxState(tmuxState);
  const r = await agendoAsync(mock.env, "pause", SHORT_ID);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("close it instead");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  expect((await mock.getTmuxState()).sessions).toContain(RUNNING_TARGET);
});

test("agendo pause refuses the only window of its host — tmux would end the host with it", async ({ mock }) => {
  await loginTab(mock); // for its worktree on disk; the tmux shape is replaced below
  await mock.setTmuxState({
    sessions: ["solo"],
    windows: [{ session: "solo", index: 0, name: RUNNING_TARGET }],
    panes: [{ session: "solo", window: RUNNING_TARGET, cwd: "/repos", placeholder: false }],
    captures: { [RUNNING_TARGET]: tmuxState.captures[RUNNING_TARGET] },
  });
  const r = await agendoAsync(mock.env, "pause", SHORT_ID);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("the only window in tmux session solo");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
});

test("agendo pause and close document themselves", async ({ mock }) => {
  const help = await agendoAsync(mock.env, "--help");
  expect(help.stdout).toContain("agendo pause <id>");
  expect(help.stdout).toContain("p pauses it");
  const llm = await agendoAsync(mock.env, "--llm");
  expect(llm.stdout).toContain("pause <id>");
});

// ── the list's p / x / X ─────────────────────────────────────────────────────

/** Open the Sessions view with the cursor on the running login session. */
async function onLoginRow(launch: () => Promise<WebTerminal>): Promise<WebTerminal> {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.press("3");
  await wt.waitForText("Running now");
  await wt.press(KEY.down); // past "＋ new session", onto the running row
  return wt;
}

test("p pauses the hovered session in place, and the row reads paused", async ({ launch, mock }) => {
  const worktree = await loginTab(mock);
  const wt = await onLoginRow(launch);
  await wt.press("p");
  await wt.waitForText(`⏸ paused ${TITLE}`, 20000);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:3"]]);
  expect(await windowsOf(mock)).toEqual(["launcher", `${RUNNING_TARGET} ⏸`]);
  await expectNothingOnDiskTouched(mock, worktree);
});

test("p refuses a session mid-turn, naming why, and kills nothing", async ({ launch, mock }) => {
  await loginTab(mock, BUSY_PANE);
  const wt = await onLoginRow(launch);
  await wt.press("p");
  await wt.waitForText('Not paused: session looks "busy"', 20000);
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
});

test("x asks first: n leaves the session alone, y kills it the way close does", async ({ launch, mock }) => {
  const worktree = await loginTab(mock);
  const wt = await onLoginRow(launch);
  await wt.press("x");
  await wt.waitForText(`Kill ${TITLE}? y/n`, 20000);
  await wt.press("n");
  await wt.waitForText("Kill cancelled");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);

  await wt.press("x");
  await wt.waitForText(`Kill ${TITLE}? y/n`, 20000);
  await wt.press("y");
  await wt.waitForText(`killed ${TITLE}`, 20000);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:3"]]);
  expect(await windowsOf(mock)).toEqual(["launcher"]);
  await expectNothingOnDiskTouched(mock, worktree);
});

test("x refuses a busy session; X asks with what is in flight, then force-kills", async ({ launch, mock }) => {
  await loginTab(mock, BUSY_PANE);
  const wt = await onLoginRow(launch);
  await wt.press("x");
  await wt.waitForText("X force-kills", 20000);
  expect(killsIn(await mock.tmuxLog())).toEqual([]);

  await wt.press("X");
  await wt.waitForText(`session looks "busy" — force kill ${TITLE}? y/n`, 20000);
  await wt.press("y");
  await wt.waitForText(`killed ${TITLE}`, 20000);
  expect(await windowsOf(mock)).toEqual(["launcher"]);
});

test("X re-checks on y: a turn that started while it asked is not forced past", async ({ launch, mock }) => {
  await loginTab(mock);
  const wt = await onLoginRow(launch);
  await wt.press("X");
  await wt.waitForText(`Nothing in flight — force kill ${TITLE}? y/n`, 20000);
  await loginTab(mock, BUSY_PANE); // the agent starts a turn under the question
  await wt.press("y");
  await wt.waitForText("which changed since you were asked — X asks again", 20000);
  expect(killsIn(await mock.tmuxLog())).toEqual([]);

  await wt.press("X");
  await wt.waitForText(`session looks "busy" — force kill ${TITLE}? y/n`, 20000);
  await wt.press("y");
  await wt.waitForText(`killed ${TITLE}`, 20000);
  expect(await windowsOf(mock)).toEqual(["launcher"]);
});

test("x on a paused tab closes it for good; p there only says it is paused", async ({ launch, mock }) => {
  // The crash session sits as an unopened restore tab, its snapshot entry the
  // thing that would bring it back on the next launcher start.
  await mkdir(join(mock.home, ".agendo", "restore"), { recursive: true });
  await writeFile(
    restoreFile(mock),
    JSON.stringify({ tabs: [{ name: CRASH_TARGET, cwd: "/run/crash", title: "Crash", argv: ["claude", "--resume", CRASH_SESSION_ID] }] }),
  );
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 2, name: CRASH_TARGET },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: CRASH_TARGET, cwd: "/run/crash", placeholder: true },
    ],
    captures: {},
  });
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.press("3");
  await wt.press("/");
  await wt.write("startup crash");
  await wt.press(KEY.down); // into the results, onto the paused session
  await wt.press("p");
  await wt.waitForText("is already paused — enter wakes it");
  await wt.press("x");
  await wt.waitForText("paused tab for good? y/n", 20000);
  await wt.press("y");
  await wt.waitForText("closed Investigate startup crash's paused tab", 20000);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:2"]]);
  expect(JSON.parse(await readFile(restoreFile(mock), "utf-8")).tabs).toEqual([]);
});

test("p and x on a row that is not a live session say why and do nothing", async ({ launch, mock }) => {
  await loginTab(mock);
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.press(KEY.down); // a work item row
  await wt.press("p");
  await wt.waitForText("p pauses a running session — this row is a work item.");
  await wt.press("x");
  await wt.waitForText("x kills a running session — this row is a work item.");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
});
