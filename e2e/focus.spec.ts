// `agendo focus` and `agendo url` — bringing a session forward from a browser
// button — plus `agendo url-handler`, which registers the agendo:// scheme.
//
// Everything they touch outside agendo is a fake on PATH: tmux (attached
// clients are fixture data in `state.clients`), notify-send, wmctrl, xdotool
// and xdg-mime. The installer runs against a temp XDG_DATA_HOME /
// XDG_CONFIG_HOME, so neither the developer's desktop entries nor their
// mimeapps.list is ever written.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT, type MockEnv } from "./harness/mockEnv.ts";
import { CRASH_SESSION_ID, RUNNING_TARGET, STANDALONE_SESSION_ID, sessionName, tmuxState } from "./harness/fixtures.ts";

const FAKE_TMUX = join(REPO_ROOT, "e2e", "fakebin", "tmux");
const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
const STANDALONE_TARGET = sessionName("claude", STANDALONE_SESSION_ID);

/** Two attached clients; /dev/pts/7 was typed into last, so it is the one to move. */
const CLIENTS = [
  { name: "/dev/pts/1", pid: 4101, activity: 1_700_000_100, session: "agendo" },
  { name: "/dev/pts/7", pid: 4107, activity: 1_700_000_900, session: "agendo" },
  // A control-mode client is never the one moved, however recent its input.
  { name: "/dev/pts/9", pid: 4109, activity: 1_700_009_999, session: "agendo", control: true },
];

/** Run the CLI without blocking (a sync spawn deadlocks against the in-process mock backend). */
function agendo(env: Record<string, string>, ...args: string[]) {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], { cwd: REPO_ROOT, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res) =>
    child.on("close", (code) => res({ code, stdout, stderr })),
  );
}

/** The fixture tmux state with clients attached, a menu window, and anything extra. */
async function seed(mock: MockEnv, extra: { clients?: unknown[]; windows?: unknown[]; panes?: unknown[] } = {}) {
  await mock.setTmuxState({
    ...tmuxState,
    sessions: [...tmuxState.sessions, "agendo"],
    windows: [{ session: "agendo", index: 0, name: "launcher" }, ...(extra.windows ?? [])],
    panes: [...tmuxState.panes, { session: "agendo", window: "launcher", cwd: "/menu", placeholder: false }, ...(extra.panes ?? [])],
    clients: extra.clients ?? CLIENTS,
  });
}

/** The window id the fake tmux reports for a session's (only) window — asked directly, not through agendo. */
function windowIdOf(env: Record<string, string>, session: string): string {
  const r = spawnSync(FAKE_TMUX, ["display-message", "-p", "-t", `=${session}:`, "#{window_id}\t#{session_name}"], {
    env, encoding: "utf-8",
  });
  const id = r.stdout.split("\t")[0];
  expect(id).toMatch(/^@\d+$/);
  return id;
}

async function switches(mock: MockEnv): Promise<string[][]> {
  return (await mock.tmuxLog()).filter((a) => a[0] === "switch-client");
}

async function notifications(mock: MockEnv): Promise<string[]> {
  return (await mock.callLog()).filter((l) => l.startsWith("notify-send "));
}

test("focus --pr switches the most recently active client to the running session's window", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  const want = windowIdOf(mock.env, RUNNING_TARGET);
  // Distinct from the menu's window, so a switch to the wrong one can't pass.
  expect(want).not.toBe(windowIdOf(mock.env, "agendo"));
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", want]]);
  // Already running: nothing was resumed.
  expect((await mock.tmuxLog()).some((a) => a[0] === "new-session" || a[0] === "new-window")).toBe(false);
  expect(await notifications(mock)).toEqual([]);
});

test("focus --work-item resumes a paused session, then focuses it", async ({ mock }) => {
  // The crash session (WI 102) parked as a restore placeholder in the menu's host.
  await seed(mock, {
    windows: [{ session: "agendo", index: 1, name: CRASH_TARGET }],
    panes: [{ session: "agendo", window: CRASH_TARGET, cwd: "/crash", placeholder: true }],
  });
  const r = await agendo(mock.env, "focus", "--work-item", "102");
  expect(r.code, r.stderr).toBe(0);
  expect(r.stderr).toContain("resumed session");
  const log = await mock.tmuxLog();
  const kill = log.findIndex((a) => a[0] === "kill-window");
  const create = log.findIndex((a) => a[0] === "new-session" && a.includes(CRASH_TARGET));
  const sw = log.findIndex((a) => a[0] === "switch-client");
  // The placeholder goes, the agent comes back, and only THEN is the client moved.
  expect(kill).toBeGreaterThanOrEqual(0);
  expect(create).toBeGreaterThan(kill);
  expect(sw).toBeGreaterThan(create);
  expect(log[sw]).toEqual(["switch-client", "-c", "/dev/pts/7", "-t", windowIdOf(mock.env, CRASH_TARGET)]);
});

test("focus <id> resumes an idle session by id and focuses it", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "focus", "standalonese");
  expect(r.code, r.stderr).toBe(0);
  expect((await mock.tmuxLog()).some((a) => a[0] === "new-session" && a.includes(STANDALONE_TARGET))).toBe(true);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", windowIdOf(mock.env, STANDALONE_TARGET)]]);
});

test("focus with no linked session notifies and fails without launching anything", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "focus", "--pr", "9999");
  expect(r.code).not.toBe(0);
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo No agendo session for PR !9999"]);
  const log = await mock.tmuxLog();
  expect(log.some((a) => ["new-session", "new-window", "switch-client", "kill-window"].includes(a[0]))).toBe(false);
});

test("focus with no attached client notifies, fails, and resumes nothing", async ({ mock }) => {
  await seed(mock, { clients: [] });
  const r = await agendo(mock.env, "focus", "--work-item", "102");
  expect(r.code).not.toBe(0);
  expect((await notifications(mock)).join("\n")).toContain("no tmux client is attached");
  const log = await mock.tmuxLog();
  expect(log.some((a) => ["new-session", "new-window", "switch-client"].includes(a[0]))).toBe(false);
});

test("focus raises the client's terminal through wmctrl on X11", async ({ mock }) => {
  await seed(mock);
  const env = { ...mock.env, DISPLAY: ":99", FAKE_WMCTRL_LIST: "0x04000007  0 4107   host  Terminal" };
  const r = await agendo(env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await mock.callLog()).toContain("wmctrl -ia 0x04000007");
});

test("url focuses through the same path as focus", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", windowIdOf(mock.env, RUNNING_TARGET)]]);
});

const MALICIOUS = [
  "agendo://launch?prompt=rm%20-rf",
  "agendo://focus?pr=5001&session=x",
  "agendo://focus?pr=5001%26workItem=1",
  "agendo://focus?pr=$(touch${IFS}/tmp/pwned)",
  "agendo://focus?pr=5001;id",
  "agendo://focus?session=--attach",
  "agendo://focus/../send?session=abc",
  "javascript:alert(1)",
  `agendo://focus?pr=${"1".repeat(400)}`,
];

for (const url of MALICIOUS) {
  test(`url refuses ${url.slice(0, 50)}`, async ({ mock }) => {
    await seed(mock);
    const r = await agendo(mock.env, "url", url);
    expect(r.code).not.toBe(0);
    expect((await notifications(mock)).join("\n")).toContain("refused an agendo:// link");
    // Refused before tmux is asked anything at all.
    expect(await mock.tmuxLog()).toEqual([]);
  });
}

test("url-handler install, status and uninstall stay inside XDG_DATA_HOME / XDG_CONFIG_HOME", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const file = join(mock.tmpDir, "data", "applications", "agendo-url-handler.desktop");
  const mimeapps = join(mock.tmpDir, "config", "mimeapps.list");

  const before = await agendo(env, "url-handler", "status");
  expect(before.code).not.toBe(0);
  expect(before.stdout).toContain("not installed");

  const inst = await agendo(env, "url-handler", "install", "--exec", "/opt/agendo/bin/agendo");
  expect(inst.code, inst.stderr).toBe(0);
  expect(inst.stdout).toContain(file);
  const text = readFileSync(file, "utf-8");
  expect(text).toContain("Exec=/opt/agendo/bin/agendo url %u");
  expect(text).toContain("MimeType=x-scheme-handler/agendo;");
  expect(text).toContain("NoDisplay=true");
  expect(await mock.callLog()).toContain("xdg-mime default agendo-url-handler.desktop x-scheme-handler/agendo");

  const st = await agendo(env, "url-handler", "status");
  expect(st.code, st.stdout).toBe(0);
  expect(st.stdout).toContain("x-scheme-handler/agendo: agendo-url-handler.desktop");

  const un = await agendo(env, "url-handler", "uninstall");
  expect(un.code, un.stderr).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(mimeapps, "utf-8")).not.toContain("x-scheme-handler/agendo");
});

test("url-handler install defaults to a stable command, never a /tmp runner copy", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const r = await agendo(env, "url-handler", "install");
  expect(r.code, r.stderr).toBe(0);
  const exec = readFileSync(join(mock.tmpDir, "data", "applications", "agendo-url-handler.desktop"), "utf-8").match(/^Exec=(.*)$/m)?.[1];
  expect(exec).toMatch(/^\/\S+ .*url %u$/);
  expect(exec).not.toMatch(/\/tmp\//);
});
