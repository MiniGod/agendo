// Resuming a session that is ALREADY running must reach the live agent, never
// cold-start a second `claude --resume` on its transcript. Two agents appending
// to one transcript is real damage, so every resume path is pinned here against
// every place a live session can sit: a window inside a host session, a legacy
// (non-id-bearing) window, a pane parked in somebody else's window, and a tmux
// session of its own — from outside tmux (where the bug was) and from inside.
//
// Outside tmux, `openTarget` used to consult only `paneLocation` and
// `hasSession`. `has-session` resolves SESSION names only, so a window named
// `cl-claude-<id>` living inside the `agendo` host session read as absent and a
// detached duplicate was created beside it. The fake tmux's `has-session` used
// to match window names too, which is why no spec saw it; it now matches real
// tmux (see e2e/fakebin/tmux).
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import { REPO_ROOT, type MockEnv } from "./harness/mockEnv.ts";
import { windowTarget } from "../src/runtime/tmux/index.ts";
import { LOGIN_SESSION_ID, RUNNING_TARGET, tmuxState } from "./harness/fixtures.ts";

const SHORT_ID = LOGIN_SESSION_ID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
// Where a handover lands: the exact `=host:=window` target the live scan
// attributed the session to, not the first window that happens to share its name.
const IN_AGENDO = windowTarget("agendo", RUNNING_TARGET);

/**
 * Run the CLI without blocking the test process: a sync spawn would freeze the
 * event loop that serves the in-process mock backend, so any resume path that
 * ever reached it would hang to the timeout instead of failing an assertion.
 */
function agendo(env: Record<string, string>, ...args: string[]): Promise<{ status: number | null; stdout: string }> {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], { cwd: REPO_ROOT, env });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += d));
  return new Promise((res) => child.on("close", (status) => res({ status, stdout })));
}

const inTmux = (env: Record<string, string>) => ({ ...env, TMUX: "/tmp/fake-tmux,1,0", TMUX_PANE: "%0" });

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

/** The login session live as window `name` at index 2 of host session `agendo`. */
const asWindow = (name: string, cwd = "/run/login") => ({
  sessions: ["agendo"],
  windows: [
    { session: "agendo", index: 0, name: "launcher" },
    { session: "agendo", index: 2, name },
  ],
  panes: [
    { session: "agendo", window: "launcher", cwd: "/tmp", id: "%0", placeholder: false },
    { session: "agendo", window: name, cwd, id: "%7", placeholder: false },
  ],
  captures: { [name]: tmuxState.captures[RUNNING_TARGET] },
});

/** The login session parked in pane %4 of the menu's window, owning no window of its own. */
const asPane = {
  sessions: ["agendo"],
  windows: [{ session: "agendo", index: 0, name: "launcher" }],
  panes: [
    { session: "agendo", window: "launcher", cwd: "/tmp", id: "%0", placeholder: false },
    { session: "agendo", window: "launcher", cwd: "/run/login", id: "%4", paneTarget: RUNNING_TARGET, placeholder: false },
  ],
  captures: { [RUNNING_TARGET]: tmuxState.captures[RUNNING_TARGET] },
};

/** Every call that would start an agent. None may appear when the session is live. */
const starts = async (mock: MockEnv) =>
  (await mock.tmuxLog()).filter((a) => ["new-session", "new-window", "split-window", "respawn-pane"].includes(a[0]));

const handovers = async (mock: MockEnv, verb: string) => (await mock.tmuxLog()).filter((a) => a[0] === verb);

test.describe("outside tmux", () => {
  test("resume of a session running as a window in a host session attaches to it, starting nothing", async ({ mock }) => {
    await mock.setTmuxState(asWindow(RUNNING_TARGET));
    const r = await agendo(mock.env, "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "attach-session")).toEqual([["attach-session", "-t", IN_AGENDO]]);
  });

  test("resume without --attach reports the live window as already running", async ({ mock }) => {
    await mock.setTmuxState(asWindow(RUNNING_TARGET));
    const r = await agendo(mock.env, "resume", SHORT_ID);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("was already running");
    expect(await starts(mock)).toEqual([]);
  });

  test("resume of a session under a legacy window name attaches to that window", async ({ mock }) => {
    // Attributed by cwd, not by id: the name carries no session id at all.
    const loginCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
    await mock.setTmuxState(asWindow("cl-wi-101", loginCwd));
    const r = await agendo(mock.env, "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "attach-session")).toEqual([["attach-session", "-t", windowTarget("agendo", "cl-wi-101")]]);
  });

  test("resume of a pane-hosted session attaches to its pane", async ({ mock }) => {
    await mock.setTmuxState(asPane);
    const r = await agendo(mock.env, "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "attach-session")).toEqual([["attach-session", "-t", "%4"]]);
  });

  test("resume of a session that is a tmux session of its own attaches to it", async ({ mock }) => {
    // The default fixture: the login session was launched outside tmux.
    const r = await agendo(mock.env, "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "attach-session")).toEqual([["attach-session", "-t", windowTarget(RUNNING_TARGET, RUNNING_TARGET)]]);
  });

  test("a same-named restore placeholder in another host session does not capture the resume", async ({ mock }) => {
    // tmux allows duplicate window names and agendo makes them: a path-scoped
    // host listed FIRST still holds a paused tab under the canonical name, while
    // the agent runs in `agendo`. Landing on the placeholder and pressing a key
    // would wake it into a second agent on the same transcript.
    const live = asWindow(RUNNING_TARGET);
    await mock.setTmuxState({
      ...live,
      sessions: ["agendo-appweb", ...live.sessions],
      windows: [{ session: "agendo-appweb", index: 1, name: RUNNING_TARGET }, ...live.windows],
      panes: [{ session: "agendo-appweb", window: RUNNING_TARGET, cwd: "/run/login", id: "%9", placeholder: true }, ...live.panes],
    });
    const r = await agendo(mock.env, "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "attach-session")).toEqual([["attach-session", "-t", IN_AGENDO]]);
  });

  test("enter on a running session in the menu attaches to its window, starting nothing", async ({ launch, mock }) => {
    await mock.setTmuxState(asWindow(RUNNING_TARGET));
    const wt = await launch();
    await wt.waitForText("Current sprint", 20000);
    await wt.waitForStable();
    await wt.press("3");
    expect(await wt.waitForText("Running now")).toMatch(/Running now\s+\(1\)/);
    await wt.press(KEY.down); // ＋ new session → the running login session
    await wt.press(KEY.enter);
    await waitUntil(async () => (await handovers(mock, "attach-session")).length > 0);
    expect(await handovers(mock, "attach-session")).toEqual([["attach-session", "-t", IN_AGENDO]]);
    expect(await starts(mock)).toEqual([]);
  });
});

test.describe("inside tmux", () => {
  test("resume of a session running as a window switches to it, starting nothing", async ({ mock }) => {
    await mock.setTmuxState({ ...asWindow(RUNNING_TARGET), currentSession: "agendo" });
    const r = await agendo(inTmux(mock.env), "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "switch-client")).toEqual([["switch-client", "-t", IN_AGENDO]]);
  });

  test("resume of a pane-hosted session selects its pane, starting nothing", async ({ mock }) => {
    await mock.setTmuxState({ ...asPane, currentSession: "agendo" });
    const r = await agendo(inTmux(mock.env), "resume", SHORT_ID, "--attach");
    expect(r.status).toBe(0);
    expect(await starts(mock)).toEqual([]);
    expect(await handovers(mock, "select-window")).toEqual([["select-window", "-t", "%4", ";", "select-pane", "-t", "%4"]]);
  });

  test("enter on a running session in the menu switches to its window, starting nothing", async ({ launch, mock }) => {
    await mock.setTmuxState({ ...asWindow(RUNNING_TARGET), currentSession: "agendo" });
    mock.env.TMUX = "/tmp/fake-tmux,1,0";
    const wt = await launch();
    await wt.waitForText("Current sprint", 20000);
    await wt.waitForStable();
    await wt.press("3");
    expect(await wt.waitForText("Running now")).toMatch(/Running now\s+\(1\)/);
    await wt.press(KEY.down); // ＋ new session → the running login session
    await wt.press(KEY.enter);
    await waitUntil(async () => (await handovers(mock, "switch-client")).length > 0);
    expect(await handovers(mock, "switch-client")).toEqual([["switch-client", "-t", IN_AGENDO]]);
    expect(await starts(mock)).toEqual([]);
  });
});
