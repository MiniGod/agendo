// End-to-end tests for the PAUSED (placeholder) window's own lifecycle — the
// little bash loop `placeholderArgv` bakes into every restored tab (src/restore.ts).
//
// Unlike the rest of the suite these don't render the launcher: the script IS the
// unit under test, so it's spawned straight into the wterm PTY (a real tty, which
// is what its blocking `read` needs) with the fake `tmux` shim first on PATH. So
// every `tmux` the script runs is recorded in `mock.tmuxLog()` and nothing is
// asserted by inspecting a real server — no tmux server is started at all.
//
// What matters here:
//   • `q` / Esc CLOSE the window (kill-window) and never start the agent, while
//     leaving the on-disk snapshot alone — the tab stays restorable.
//   • an ARROW key is not an Esc: its `\e` prefix must not be mistaken for the
//     quit key, or navigating in a paused tab would close it.
//   • any other key resumes, clearing `@cl_placeholder` first.
//   • the agent EXITING returns to the paused screen (no `exec`) and re-marks
//     `@cl_placeholder`, so the live set stops counting the window as running.
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { test as base, expect, KEY } from "./harness/test.ts";
import { WebTerminal } from "./harness/wterm.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { placeholderArgv } from "../src/restore.ts";
import type { RestoreTab } from "../src/restore.ts";
import type { Page } from "@playwright/test";

const TITLE = "Fix the login screen";
const HINT = "Press any key to resume · q or Esc to close this window";
// A fake agent that ANNOUNCES itself and then blocks, so a test can see the pane
// is running the agent and choose when it exits (a keypress ends the `read`).
// Stands in for the tab's real `claude --resume <id>`, which nothing here needs
// to actually run — src/launch.ts owns that argv, this owns what wraps it.
const AGENT_UP = "AGENT-IS-UP";
const FAKE_AGENT = ["bash", "-c", `printf '%s\\n' ${AGENT_UP}; read -rsn1 _`];

function tab(argv: string[] = FAKE_AGENT): RestoreTab {
  return { name: "cl-claude-abc123", cwd: REPO_ROOT, title: TITLE, argv };
}

/**
 * `paused(tab?)` — spawn the tab's placeholder script in a PTY and wait for its
 * paused screen. A fixture (rather than a plain helper) so every terminal it
 * hands out is closed on teardown even when an assertion fails mid-test, the way
 * the `launch` fixture does for the launcher itself.
 */
const test = base.extend<{ paused: (t?: RestoreTab) => Promise<WebTerminal> }>({
  paused: async ({ page, mock }, use) => {
    const terminals: WebTerminal[] = [];
    await use(async (t: RestoreTab = tab()) => {
      const [command, ...args] = placeholderArgv(t);
      const wt = await WebTerminal.launch({ page, command, args, cwd: REPO_ROOT, env: mock.env, rows: 12 });
      terminals.push(wt);
      await wt.waitForText(HINT);
      return wt;
    });
    for (const wt of terminals) await wt.close();
  },
});

/** Poll until the script's process exits (it closes its own window), or throw. */
async function expectExit(page: Page, wt: WebTerminal, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (wt.exitCode !== null) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`placeholder script never exited\n--- last screen ---\n${await wt.screen()}`);
}

/** Every `tmux` invocation the script made, as argv arrays. */
const killWindows = (log: string[][]) => log.filter((argv) => argv[0] === "kill-window");
const marks = (log: string[][]) => log.filter((argv) => argv[0] === "set-option");

test("paused window: shows the title and the resume/close hint", async ({ paused, mock }) => {
  const wt = await paused();
  const screen = await wt.screen();
  expect(screen).toContain(TITLE);
  expect(screen).toContain(HINT);
  // Nothing has run yet: no agent, and the window's placeholder flag untouched.
  expect(await mock.callLog()).toEqual([]);
  expect(marks(await mock.tmuxLog())).toEqual([]);
});

test("paused window: q closes the window without resuming or deleting the snapshot", async ({ page, paused, mock }) => {
  // A saved snapshot standing in for the tab's own restore entry: closing the
  // window must leave it exactly as it was, so `agendo resume <id>` (and the next
  // restore) still finds the session.
  const snapshot = join(mock.home, ".agendo", "restore", "agendo.json");
  const saved = JSON.stringify({ tabs: [tab()] }, null, 2);
  await mkdir(join(mock.home, ".agendo", "restore"), { recursive: true });
  await writeFile(snapshot, saved);

  const wt = await paused();
  await wt.press("q");
  await expectExit(page, wt);

  const log = await mock.tmuxLog();
  // Closes the CURRENT window — no `-t`, so tmux resolves it from the pane we're
  // in, the same way the placeholder flag is addressed.
  expect(killWindows(log)).toEqual([["kill-window"]]);
  expect(await mock.callLog()).toEqual([]); // the agent was never started
  expect(await readFile(snapshot, "utf-8")).toBe(saved); // nothing deleted on disk
});

test("paused window: a bare Esc closes the window", async ({ page, paused, mock }) => {
  const wt = await paused();
  await wt.press(KEY.escape, 400); // > ESC_SEQUENCE_TIMEOUT, so it reads as a lone Esc
  await expectExit(page, wt);
  expect(killWindows(await mock.tmuxLog())).toEqual([["kill-window"]]);
  expect(await mock.callLog()).toEqual([]);
});

test("paused window: an arrow key resumes — its Esc prefix is not a quit", async ({ paused, mock }) => {
  // The regression this guards: `\e[A` starts with the same byte as Esc, so a
  // naive one-byte read would close the window on every arrow press.
  const wt = await paused();
  await wt.press(KEY.up);
  await wt.waitForText(AGENT_UP);
  expect(wt.exitCode).toBeNull(); // still alive — the window was not closed
  const log = await mock.tmuxLog();
  expect(killWindows(log)).toEqual([]);
  // Resuming clears the placeholder flag so the live set counts it as running.
  expect(marks(log)).toEqual([["set-option", "-uw", "@cl_placeholder"]]);
});

test("paused window: Ctrl-C on the paused screen is not a way out", async ({ paused, mock }) => {
  // Closing stays a q/Esc decision. Without the script's `trap : INT`, SIGINT
  // would take the wrapper down and the window with it.
  const wt = await paused();
  await wt.press(KEY.ctrlC, 400);
  expect(wt.exitCode).toBeNull();
  expect(await wt.screen()).toContain(HINT);
  expect(killWindows(await mock.tmuxLog())).toEqual([]);
  expect(await mock.callLog()).toEqual([]); // and it didn't resume either
});

test("paused window: an agent killed by Ctrl-C returns to the paused screen", async ({ paused, mock }) => {
  // The fake agent has no INT trap, so Ctrl-C kills it outright — the crash case.
  // A non-interactive bash normally re-raises SIGINT on itself when its child
  // dies of it, which would close the window instead of re-pausing.
  const wt = await paused();
  await wt.press("x");
  await wt.waitForText(AGENT_UP);
  await wt.press(KEY.ctrlC, 400);
  await wt.waitForText(HINT);
  expect(wt.exitCode).toBeNull();
  expect(marks(await mock.tmuxLog())).toEqual([
    ["set-option", "-uw", "@cl_placeholder"],
    ["set-option", "-w", "@cl_placeholder", "1"],
  ]);
});

test("paused window: an ordinary key resumes the tab's argv", async ({ paused, mock }) => {
  // Uses a resume-shaped argv (env prefix, an id with a space) so the quoting
  // `shq` does for `bash -c` is exercised end to end against the fake `claude`.
  const wt = await paused(tab(["env", "CLAUDE_CONFIG_DIR=/tmp/cfg", "claude", "--resume", "id with space"]));
  await wt.press("j");
  await expect.poll(() => mock.callLog()).toEqual(["claude --resume id with space"]);
  expect(killWindows(await mock.tmuxLog())).toEqual([]);
  expect(wt.exitCode).toBeNull();
});

test("paused window: the agent exiting returns to the paused screen and re-marks the placeholder", async ({ page, paused, mock }) => {
  const wt = await paused();
  await wt.press("x");
  await wt.waitForText(AGENT_UP);
  await wt.press("x"); // ends the fake agent's `read` — the agent exits
  // No `exec`, so the pane comes back to the placeholder instead of closing.
  await wt.waitForText(HINT);
  expect(wt.exitCode).toBeNull();
  const screen = await wt.screen();
  expect(screen).toContain(TITLE);
  expect(screen).not.toContain(AGENT_UP); // redrawn, not appended below the agent
  // The flag is cleared on resume and set again on exit, in that order — a
  // re-paused window must stop counting as a running session.
  expect(marks(await mock.tmuxLog())).toEqual([
    ["set-option", "-uw", "@cl_placeholder"],
    ["set-option", "-w", "@cl_placeholder", "1"],
  ]);
  // And it's still a live paused tab: q closes it from here just the same.
  await wt.press("q");
  await expectExit(page, wt);
  expect(killWindows(await mock.tmuxLog())).toEqual([["kill-window"]]);
});
