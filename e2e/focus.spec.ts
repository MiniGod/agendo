// `agendo focus` and `agendo url` — bringing a session forward from a browser
// button — plus `agendo url-handler`, which registers the agendo:// scheme.
//
// Everything they touch outside agendo is a fake on PATH: tmux (attached
// clients are fixture data in `state.clients`), notify-send, wmctrl, xdotool,
// i3-msg, swaymsg, xdg-mime and update-desktop-database. The installer runs
// against a temp XDG_DATA_HOME / XDG_CONFIG_HOME, so neither the developer's
// desktop entries nor their mimeapps.list is ever written.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT, type MockEnv } from "./harness/mockEnv.ts";
import { CRASH_SESSION_ID, RUNNING_TARGET, STANDALONE_SESSION_ID, sessionName, tmuxState } from "./harness/fixtures.ts";

const FAKE_TMUX = join(REPO_ROOT, "e2e", "fakebin", "tmux");
const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
const STANDALONE_TARGET = sessionName("claude", STANDALONE_SESSION_ID);

/**
 * An activity stamp that still reads as "typed into just now" however slowly the
 * CLI under test starts: in the future, which the typing guard counts as typing
 * (a stamp of plain `now` expires three seconds later, mid-run on a loaded runner).
 * Relies on `typingIn` in src/cli/focus/index.ts treating a future activity as typing.
 */
const typingNow = () => Math.floor(Date.now() / 1000) + 60;

/**
 * Hold link floor `name` (src/cli/focus/throttle.ts) the way a concurrent
 * link's claim does: its lock dir, dated in the future so it never reads as
 * stale. A stamp would expire two seconds after it was written — mid-run on a
 * loaded runner — while a held lock refuses every claim until the test ends.
 * Relies on `clearIfStale` in src/cli/focus/throttle.ts never reading a
 * future-dated lock as stale.
 */
function holdFloor(mock: MockEnv, name: string): void {
  const lock = join(mock.home, ".agendo", `${name}.lock`);
  mkdirSync(lock, { recursive: true });
  const future = Date.now() / 1000 + 3600;
  utimesSync(lock, future, future);
}

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
async function seed(
  mock: MockEnv,
  extra: {
    clients?: unknown[];
    /** What list-clients answers after its first call (see the fake tmux). */
    clientsLater?: unknown[];
    windows?: unknown[];
    panes?: unknown[];
    sessions?: string[];
    switchFails?: boolean;
    /** Leave the shared `agendo` launcher session out. */
    noLauncher?: boolean;
    /** Session options, e.g. a path-scoped launcher's `@cl_root`. */
    options?: Record<string, Record<string, string>>;
  } = {},
) {
  const launcher = extra.noLauncher ? [] : ["agendo"];
  await mock.setTmuxState({
    ...tmuxState,
    switchFails: extra.switchFails ?? false,
    options: extra.options ?? {},
    sessions: [...tmuxState.sessions, ...launcher, ...(extra.sessions ?? [])],
    windows: [...launcher.map((session) => ({ session, index: 0, name: "launcher" })), ...(extra.windows ?? [])],
    panes: [
      ...tmuxState.panes,
      ...launcher.map((session) => ({ session, window: "launcher", cwd: "/menu", placeholder: false })),
      ...(extra.panes ?? []),
    ],
    clients: extra.clients ?? CLIENTS,
    ...(extra.clientsLater ? { clientsLater: extra.clientsLater } : {}),
  });
}

/** The window id the fake tmux reports for a session's (only) window — asked directly, not through agendo. */
function windowIdOf(env: Record<string, string>, session: string, window?: string): string {
  const target = window ? `=${session}:=${window}` : `=${session}:`;
  const r = spawnSync(FAKE_TMUX, ["display-message", "-p", "-t", target, "#{window_id}\t#{session_name}"], {
    env, encoding: "utf-8",
  });
  const id = r.stdout.split("\t")[0];
  expect(id).toMatch(/^@\d+$/);
  return id;
}

/** The `=session:@N` target agendo switches a client to — scoped, so a linked window can't land elsewhere. */
function switchTarget(env: Record<string, string>, session: string, window?: string): string {
  return `=${session}:${windowIdOf(env, session, window)}`;
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
  const want = switchTarget(mock.env, RUNNING_TARGET);
  // Distinct from the menu's window, so a switch to the wrong one can't pass.
  expect(windowIdOf(mock.env, RUNNING_TARGET)).not.toBe(windowIdOf(mock.env, "agendo"));
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
  // Back into the tmux session its tab was parked in — not a session of its own.
  const create = log.findIndex((a) => a[0] === "new-window" && a.includes("=agendo") && a.includes(CRASH_TARGET));
  const sw = log.findIndex((a) => a[0] === "switch-client");
  // The placeholder goes, the agent comes back, and only THEN is the client moved.
  expect(kill).toBeGreaterThanOrEqual(0);
  // Killed at its host, not by a bare name tmux would resolve in its current session.
  expect(log[kill]).toEqual(["kill-window", "-t", `=agendo:=${CRASH_TARGET}`]);
  expect(create).toBeGreaterThan(kill);
  expect(sw).toBeGreaterThan(create);
  expect(log.some((a) => a[0] === "new-session")).toBe(false);
  expect(log[sw]).toEqual(["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", CRASH_TARGET)]);
});

test("focus <id> resumes an idle session by id and focuses it", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "focus", "standalonese");
  expect(r.code, r.stderr).toBe(0);
  // An idle session has no tab to return to: it opens beside what the client is showing.
  const log = await mock.tmuxLog();
  expect(log.some((a) => a[0] === "new-window" && a.includes("=agendo") && a.includes(STANDALONE_TARGET))).toBe(true);
  expect(log.some((a) => a[0] === "new-session")).toBe(false);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", STANDALONE_TARGET)]]);
});

test("an idle session is never resumed into the user's own tmux session", async ({ mock }) => {
  // The client is showing a session of the user's, not a launcher: the agent
  // goes to the launcher session instead, and the client follows it there.
  await seed(mock, {
    sessions: ["main"],
    windows: [{ session: "main", index: 0, name: "zsh" }],
    clients: [{ name: "/dev/pts/7", pid: 4107, activity: 1_700_000_900, session: "main" }],
  });
  const r = await agendo(mock.env, "focus", "standalonese");
  expect(r.code, r.stderr).toBe(0);
  const log = await mock.tmuxLog();
  expect(log.some((a) => a[0] === "new-window" && a.includes("=agendo") && a.includes(STANDALONE_TARGET))).toBe(true);
  expect(log.some((a) => a[0] === "new-window" && a.includes("=main"))).toBe(false);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", STANDALONE_TARGET)]]);
});

test("a path-scoped launcher the client shows keeps both an idle and a paused resume", async ({ mock }) => {
  // `agendo-repo` is a launcher scoped to one repo (it carries `@cl_root`); the
  // crash session's tab is parked in it, and the client is looking at it.
  await seed(mock, {
    sessions: ["agendo-repo"],
    options: { "agendo-repo": { "@cl_root": "/repo" } },
    windows: [{ session: "agendo-repo", index: 0, name: "launcher" }, { session: "agendo-repo", index: 1, name: CRASH_TARGET }],
    panes: [
      { session: "agendo-repo", window: "launcher", cwd: "/repo", placeholder: false },
      { session: "agendo-repo", window: CRASH_TARGET, cwd: "/crash", placeholder: true },
    ],
    clients: [{ name: "/dev/pts/7", pid: 4107, activity: 1_700_000_900, session: "agendo-repo" }],
  });
  const idle = await agendo(mock.env, "focus", "standalonese");
  expect(idle.code, idle.stderr).toBe(0);
  const paused = await agendo(mock.env, "focus", "--work-item", "102");
  expect(paused.code, paused.stderr).toBe(0);
  const log = await mock.tmuxLog();
  for (const name of [STANDALONE_TARGET, CRASH_TARGET]) {
    expect(log.some((a) => a[0] === "new-window" && a.includes("=agendo-repo") && a.includes(name)), name).toBe(true);
  }
  expect(log.some((a) => a[0] === "new-window" && a.includes("=agendo"))).toBe(false);
});

test("a link never moves a terminal that is being typed in", async ({ mock }) => {
  await seed(mock, { clients: [{ name: "/dev/pts/7", pid: 4107, activity: typingNow(), session: "agendo" }] });
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("/dev/pts/7 was typed into");
  expect(await switches(mock)).toEqual([]);
  // Said, so a click that did nothing is not a mystery — naming the session, nothing from the link.
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo ignored — you were typing in agendo"]);
  // The same focus typed by hand is the human's own choice.
  const typed = await agendo(mock.env, "focus", "--pr", "5001");
  expect(typed.code, typed.stderr).toBe(0);
});

/** Four terminals, each on its own tmux session; pts/21 is being typed into right now. */
function spreadClients(targetSession: string, extra: { sessions?: string[] } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    sessions: ["agendo-tv-launcher", "agendo-agendo", ...(extra.sessions ?? [])],
    clients: [
      { name: "/dev/pts/1", pid: 4101, activity: now - 600, session: "agendo-tv-launcher" },
      { name: "/dev/pts/21", pid: 4121, activity: typingNow(), session: "agendo-agendo" },
      { name: "/dev/pts/6", pid: 4106, activity: now - 300, session: targetSession },
      { name: "/dev/pts/24", pid: 4124, activity: now - 60, session: "agendo-agendo" },
    ],
  };
}

/** wmctrl's view of the busy terminal (pts/21's) and the target's (pts/6's). */
const TWO_TERMINALS = "0x04000021  0 4121   host  Busy\n0x04000006  0 4106   host  Target";

test("a link moves the client already on the target's tmux session, not the one being typed in", async ({ mock }) => {
  await seed(mock, spreadClients(RUNNING_TARGET));
  const env = { ...mock.env, DISPLAY: ":99", FAKE_WMCTRL_LIST: TWO_TERMINALS };
  const r = await agendo(env, "url", "agendo://focus?pr=5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/6", "-t", switchTarget(mock.env, RUNNING_TARGET)]]);
  expect(await notifications(mock)).toEqual([]);
  // No terminal is raised while pts/21 is being typed in: raising takes keyboard
  // focus, which would send those keystrokes into the agent's prompt.
  expect((await mock.callLog()).some((l) => l.startsWith("wmctrl -ia"))).toBe(false);
});

test("with nobody typing, the link raises the moved client's terminal, not the most recent one's", async ({ mock }) => {
  const layout = spreadClients(RUNNING_TARGET);
  const quiet = layout.clients.map((c) => (c.name === "/dev/pts/21" ? { ...c, activity: Math.floor(Date.now() / 1000) - 30 } : c));
  await seed(mock, { ...layout, clients: quiet });
  const env = { ...mock.env, DISPLAY: ":99", FAKE_WMCTRL_LIST: TWO_TERMINALS };
  const r = await agendo(env, "url", "agendo://focus?pr=5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/6", "-t", switchTarget(mock.env, RUNNING_TARGET)]]);
  const log = await mock.callLog();
  expect(log).toContain("wmctrl -ia 0x04000006");
  expect(log).not.toContain("wmctrl -ia 0x04000021");
});

test("focus typed by hand moves the terminal it was typed in, even with a client on the target's session", async ({ mock }) => {
  await seed(mock, spreadClients(RUNNING_TARGET));
  const r = await agendo(mock.env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/21", "-t", switchTarget(mock.env, RUNNING_TARGET)]]);
});

test("a link resuming an idle session opens it in its repo's launcher, and moves the client there", async ({ mock }) => {
  // pts/21 sits in a launcher of another repo and is being typed in; pts/6 shows the standalone repo's launcher.
  const layout = spreadClients("agendo-standalone", { sessions: ["agendo-standalone"] });
  await seed(mock, {
    ...layout,
    options: { "agendo-agendo": { "@cl_root": "/elsewhere/agendo" }, "agendo-standalone": { "@cl_root": join(mock.home, "repos", "standalone") } },
    windows: [{ session: "agendo-standalone", index: 0, name: "launcher" }],
  });
  const r = await agendo(mock.env, "url", "agendo://focus?session=standalonese");
  expect(r.code, r.stderr).toBe(0);
  const log = await mock.tmuxLog();
  expect(log.some((a) => a[0] === "new-window" && a.includes("=agendo-standalone") && a.includes(STANDALONE_TARGET))).toBe(true);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/6", "-t", switchTarget(mock.env, "agendo-standalone", STANDALONE_TARGET)]]);
});

/** The paused crash session's tab, parked in the shared `agendo` session, with `clientsLater` as the listing after the resume. */
async function seedPausedWithLater(mock: MockEnv, later: (now: number) => { name: string; pid: number; activity: number; session: string }[]) {
  const layout = spreadClients("agendo");
  await seed(mock, {
    ...layout,
    clientsLater: [...layout.clients, ...later(Math.floor(Date.now() / 1000))],
    windows: [{ session: "agendo", index: 1, name: CRASH_TARGET }],
    panes: [{ session: "agendo", window: CRASH_TARGET, cwd: "/crash", placeholder: true }],
  });
}

test("the re-check after a resume guards the client chosen THEN, and says the agent was resumed", async ({ mock }) => {
  // pts/6 stays idle; a client attached to the landing session meanwhile is being typed in.
  await seedPausedWithLater(mock, () => [{ name: "/dev/pts/30", pid: 4130, activity: typingNow(), session: "agendo" }]);
  const r = await agendo(mock.env, "url", "agendo://focus?workItem=102");
  expect(r.code).not.toBe(0);
  expect(await switches(mock)).toEqual([]);
  const said = (await notifications(mock)).join("\n");
  expect(said).toContain("not switching: /dev/pts/30 was typed into");
  expect(said).toContain(`WAS resumed and is running in tmux window ${CRASH_TARGET}`);
});

test("the re-check after a resume moves the client on the landing session that is most recent THEN", async ({ mock }) => {
  await seedPausedWithLater(mock, (now) => [{ name: "/dev/pts/30", pid: 4130, activity: now - 20, session: "agendo" }]);
  const r = await agendo(mock.env, "url", "agendo://focus?workItem=102");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/30", "-t", switchTarget(mock.env, "agendo", CRASH_TARGET)]]);
});

test("a link that got through and notified counts against the refusal-note floor", async ({ mock }) => {
  await seed(mock);
  const stamp = join(mock.home, ".agendo", "url-refused-note.stamp");
  const ok = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(ok.code, ok.stderr).toBe(0);
  // Said nothing, so the note floor is untouched: a refusal behind it would still be heard.
  expect(existsSync(stamp)).toBe(false);
  // Its focus stamp is what holds the next link, fired after it, to the two-second gap.
  expect(existsSync(join(mock.home, ".agendo", "url-focus.stamp"))).toBe(true);
  await pastFocusFloor();
  const failed = await agendo(mock.env, "url", "agendo://focus?pr=99999");
  expect(failed.code).not.toBe(0);
  const said = await notifications(mock);
  expect(said).toHaveLength(1);
  expect(said[0]).toContain("No agendo session for");
  // Said something: the floor is taken, so the refusals behind it stay quiet (see "a burst's later refusals are quiet").
  expect(existsSync(stamp)).toBe(true);
});

test("a typing refusal is not a second notification when a refused link already raised one", async ({ mock }) => {
  await seed(mock, { clients: [{ name: "/dev/pts/7", pid: 4107, activity: typingNow(), session: "agendo" }] });
  // The refusal-note floor held, as by a concurrent claim — a stamp from a refused link that just notified reads the same.
  holdFloor(mock, "url-refused-note");
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("/dev/pts/7 was typed into");
  expect(await notifications(mock)).toEqual([]);
});

test("a link resuming a paused session moves the client on the session it lands in", async ({ mock }) => {
  await seed(mock, {
    ...spreadClients("agendo"),
    windows: [{ session: "agendo", index: 1, name: CRASH_TARGET }],
    panes: [{ session: "agendo", window: CRASH_TARGET, cwd: "/crash", placeholder: true }],
  });
  const r = await agendo(mock.env, "url", "agendo://focus?workItem=102");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/6", "-t", switchTarget(mock.env, "agendo", CRASH_TARGET)]]);
});

test("with no client on the target's session, a link falls back to the most recent client — and its typing guard", async ({ mock }) => {
  await seed(mock, spreadClients("agendo-pc-to-phone-audio", { sessions: ["agendo-pc-to-phone-audio"] }));
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("/dev/pts/21 was typed into");
  expect(await switches(mock)).toEqual([]);
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo ignored — you were typing in agendo-agendo"]);
});

test("a link leaves a client alone that detached before the switch", async ({ mock }) => {
  await seed(mock, { clientsLater: [] });
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("url: ignored — /dev/pts/7 detached");
  expect(await switches(mock)).toEqual([]);
  expect(await notifications(mock)).toEqual([]);
});

test("a link that resumed an agent and then finds the client typed in says so, and does not switch", async ({ mock }) => {
  await seed(mock, { clientsLater: [{ name: "/dev/pts/7", pid: 4107, activity: typingNow(), session: "agendo" }] });
  const r = await agendo(mock.env, "url", "agendo://focus?session=standalonese");
  expect(r.code).not.toBe(0);
  expect((await mock.tmuxLog()).some((a) => a[0] === "new-window" && a.includes(STANDALONE_TARGET))).toBe(true);
  expect(await switches(mock)).toEqual([]);
  const said = (await notifications(mock)).join("\n");
  expect(said).toContain("not switching: /dev/pts/7 was typed into");
  expect(said).toContain(`WAS resumed and is running in tmux window ${STANDALONE_TARGET}`);
});

test("with no launcher session, an idle session gets a detached session of its own — even when focus runs inside tmux", async ({ mock }) => {
  await seed(mock, {
    noLauncher: true,
    sessions: ["main"],
    windows: [{ session: "main", index: 0, name: "zsh" }],
    clients: [{ name: "/dev/pts/7", pid: 4107, activity: 1_700_000_900, session: "main" }],
  });
  // Inside the user's own session, where a bare `new-window` would land in it.
  // The socket path is the test's own, so even an escaped real tmux finds no server.
  const env = { ...mock.env, TMUX: `${join(mock.tmpDir, "no-such-socket")},1,0`, TMUX_PANE: "%0" };
  const r = await agendo(env, "focus", "standalonese");
  expect(r.code, r.stderr).toBe(0);
  const log = await mock.tmuxLog();
  expect(log.some((a) => a[0] === "new-session" && a.includes(STANDALONE_TARGET))).toBe(true);
  expect(log.some((a) => a[0] === "new-window")).toBe(false);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, STANDALONE_TARGET)]]);
});

test("focus refuses a session running outside agendo: there is no window to bring forward", async ({ mock }) => {
  await seed(mock);
  // What a live claude advertises: a registry entry naming a socket that answers.
  const sock = join(mock.tmpDir, "peer.sock");
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(sock, r));
  mkdirSync(join(mock.env.HOME, ".claude", "sessions"), { recursive: true });
  writeFileSync(
    join(mock.env.HOME, ".claude", "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: STANDALONE_SESSION_ID, cwd: "/x", peerProtocol: 1, kind: "interactive", messagingSocketPath: sock, status: "busy" }),
  );
  try {
    const r = await agendo(mock.env, "focus", "standalonese");
    expect(r.code).toBe(2);
    expect((await notifications(mock)).join("\n")).toContain("is running outside agendo");
    const log = await mock.tmuxLog();
    expect(log.some((a) => ["new-session", "new-window", "switch-client"].includes(a[0]))).toBe(false);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a link to no session names it in the notification only by what agendo chose, not the page's token", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "url", "agendo://focus?session=reinstall-agendo-now");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("session reinstall-agendo-now");
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo No agendo session for the linked session"]);
});

test("a link by an id-less window name focuses the session that window is tagged with", async ({ mock }) => {
  // `cl-wi-…` embeds a work-item id, not a session id. Where the window carries a tag it wins over
  // the cwd fallback — here the cwd matches no session at all, so only the tag can resolve it.
  const name = "cl-wi-acme-appweb-777";
  await seed(mock, {
    windows: [{ session: "agendo", index: 1, name }],
    panes: [{ session: "agendo", window: name, cwd: "/elsewhere", placeholder: false, tags: { "@cl_session_id": STANDALONE_SESSION_ID } }],
  });
  const r = await agendo(mock.env, "url", `agendo://focus?session=${name}`);
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", name)]]);
  // It was running in that window: nothing resumed.
  expect((await mock.tmuxLog()).some((a) => a[0] === "new-session" || a[0] === "new-window")).toBe(false);
});

test("focus by an id-bearing window name is still focus by the short id it embeds", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "focus", RUNNING_TARGET);
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, RUNNING_TARGET)]]);
});

test("an untagged id-less window name goes by the window's attribution, as list shows it", async ({ mock }) => {
  // How a `cl-wi-` window really runs: launched with no id to tag, attributed by its cwd.
  const crashCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "fix-crash-102");
  await seed(mock, {
    windows: [{ session: "agendo", index: 1, name: "cl-wi-102" }],
    panes: [{ session: "agendo", window: "cl-wi-102", cwd: crashCwd, placeholder: false }],
  });
  const r = await agendo(mock.env, "focus", "cl-wi-102");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", "cl-wi-102")]]);
  expect((await mock.tmuxLog()).some((a) => a[0] === "new-session" || a[0] === "new-window")).toBe(false);
});

test("a codex fresh-launch window name goes by its cwd, the link `launch` prints for codex", async ({ mock }) => {
  // `cl-bg-codex-…` carries a uniquifier, not codex's id: the window is attributed by cwd.
  const name = "cl-bg-codex-x1";
  const codexCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "codex-tidy");
  await seed(mock, {
    windows: [{ session: "agendo", index: 1, name }],
    panes: [{ session: "agendo", window: name, cwd: codexCwd, placeholder: false }],
  });
  const r = await agendo(mock.env, "url", `agendo://focus?session=${name}`);
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", name)]]);
  expect((await mock.tmuxLog()).some((a) => a[0] === "new-session" || a[0] === "new-window")).toBe(false);
});

test("two id-less windows attributed to one session: one focuses, the other is refused, never resumed", async ({ mock }) => {
  // Both sit in the crash session's cwd, so the cwd fallback gives both to it, and it keeps one.
  const crashCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "fix-crash-102");
  const names = ["cl-wi-102", "cl-wi-103"];
  await seed(mock, {
    windows: names.map((name, i) => ({ session: "agendo", index: i + 1, name })),
    panes: names.map((window) => ({ session: "agendo", window, cwd: crashCwd, placeholder: false })),
  });
  const runs = [];
  for (const name of names) runs.push(await agendo(mock.env, "focus", name));
  expect(runs.filter((r) => r.code === 0)).toHaveLength(1);
  const won = names[runs.findIndex((r) => r.code === 0)];
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, "agendo", won)]]);
  expect(runs.find((r) => r.code !== 0)?.stderr).toContain("No agendo session");
  expect((await mock.tmuxLog()).some((a) => ["new-session", "new-window", "kill-window"].includes(a[0]))).toBe(false);
});

test("a window name no live window carries focuses nothing and resumes nothing", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "url", "agendo://focus?session=cl-wi-102");
  expect(r.code).not.toBe(0);
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo No agendo session for the linked session"]);
  const log = await mock.tmuxLog();
  expect(log.some((a) => ["new-session", "new-window", "switch-client", "kill-window"].includes(a[0]))).toBe(false);
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

test("on i3, focus goes through i3-msg so a window on another workspace is focused, not just marked urgent", async ({ mock }) => {
  await seed(mock);
  const env = { ...mock.env, DISPLAY: ":99", FAKE_I3_SOCKET: "/run/user/1000/i3/ipc-socket.1", FAKE_WMCTRL_LIST: "0x04600004  4 4107   host  Terminal" };
  const r = await agendo(env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  const log = await mock.callLog();
  expect(log).toContain("i3-msg [id=73400324] focus");
  expect(log.some((l) => l.startsWith("wmctrl -ia"))).toBe(false);
});

test("on i3, a focus i3 refuses falls back to wmctrl", async ({ mock }) => {
  await seed(mock);
  const env = { ...mock.env, DISPLAY: ":99", FAKE_I3_SOCKET: "/s", FAKE_I3_FAIL: "1", FAKE_WMCTRL_LIST: "0x04600004  4 4107   host  Terminal" };
  const r = await agendo(env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await mock.callLog()).toContain("wmctrl -ia 0x04600004");
});

test("focus falls back to xdotool when wmctrl knows no ancestor's window", async ({ mock }) => {
  await seed(mock);
  const env = { ...mock.env, DISPLAY: ":99", FAKE_WMCTRL_LIST: "", FAKE_XDOTOOL_PID: "4107", FAKE_XDOTOOL_WID: "67108871" };
  const r = await agendo(env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await mock.callLog()).toContain("xdotool windowactivate 67108871");
});

test("focus fails loudly when tmux will not switch the client", async ({ mock }) => {
  await seed(mock, { switchFails: true });
  const r = await agendo(mock.env, "focus", "--pr", "5001");
  expect(r.code).not.toBe(0);
  expect((await notifications(mock)).join("\n")).toContain("tmux could not switch /dev/pts/7");
});

test("a failure after a resume says the session is running, and where", async ({ mock }) => {
  await seed(mock, { switchFails: true });
  const r = await agendo(mock.env, "focus", "standalonese");
  expect(r.code).not.toBe(0);
  const said = (await notifications(mock)).join("\n");
  expect(said).toContain("tmux could not switch /dev/pts/7");
  expect(said).toContain(`WAS resumed and is running in tmux window ${STANDALONE_TARGET}`);
});

test("focus with no client opens the configured focusTerminal on the session, at its window", async ({ mock }) => {
  await seed(mock, { clients: [] });
  // Merged into the fixture config rather than replacing it: ~/.agendo/ is read first.
  const cfg = JSON.parse(readFileSync(join(mock.env.HOME, ".claude-launcher", "config.json"), "utf-8"));
  writeFileSync(join(mock.env.HOME, ".agendo", "config.json"), JSON.stringify({ ...cfg, focusTerminal: "fake-terminal -e tmux attach -t {session}" }));
  const r = await agendo(mock.env, "focus", "--pr", "5001");
  expect(r.code, r.stderr).toBe(0);
  const id = windowIdOf(mock.env, RUNNING_TARGET);
  expect((await mock.tmuxLog()).some((a) => a[0] === "select-window" && a.includes(`=${RUNNING_TARGET}:${id}`))).toBe(true);
  // The terminal is spawned detached, so its log line can land after agendo exits.
  await expect.poll(async () => mock.callLog()).toContain(`fake-terminal -e tmux attach -t =${RUNNING_TARGET}`);
});

/** Past the floor every link is held to (URL_FOCUS_GAP_MS), so a spec can reach the resume floor behind it. */
const pastFocusFloor = () => new Promise((r) => setTimeout(r, 2_100));

test("links are held to one per two seconds, and a refused one says so", async ({ mock }) => {
  await seed(mock);
  // The focus floor taken, as by a link handled just now — held directly, since spawning one would race the gap.
  holdFloor(mock, "url-focus");
  const second = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(second.code).not.toBe(0);
  expect(second.stderr).toContain("another agendo:// link was handled less than");
  // Said, so a double click is not a mystery.
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo ignored a link — another one was handled moments ago"]);
  expect(await switches(mock)).toEqual([]);
});

test("a burst's later refusals are quiet: one notification per gap, not one each", async ({ mock }) => {
  await seed(mock);
  // What a burst leaves behind: a link handled and a refusal noted, both just now.
  // Held directly, since spawning the burst would race the two-second gaps.
  for (const floor of ["url-focus", "url-refused-note"]) holdFloor(mock, floor);
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("another agendo:// link was handled less than");
  expect(await notifications(mock)).toEqual([]);
  expect(await switches(mock)).toEqual([]);
});

test("a burst of malformed links raises one notification, not one each", async ({ mock }) => {
  await seed(mock);
  expect((await agendo(mock.env, "url", "agendo://evil?n=0")).code).not.toBe(0);
  expect(await notifications(mock)).toHaveLength(1);
  // The rest of the burst, behind it: both floors held, as the first link's claim
  // and its notification leave them — held directly, since spawning would race the gap.
  for (const floor of ["url-focus", "url-refused-note"]) holdFloor(mock, floor);
  for (let i = 1; i < 3; i++) expect((await agendo(mock.env, "url", `agendo://evil?n=${i}`)).code).not.toBe(0);
  expect(await notifications(mock)).toHaveLength(1);
});

test("a state dir agendo cannot write refuses links, and says why", async ({ mock }) => {
  await seed(mock);
  // A FILE where a directory has to be: unwritable for root too, unlike a chmod.
  const env = { ...mock.env, HOME: join(mock.tmpDir, "blocked-home") };
  mkdirSync(env.HOME, { recursive: true });
  writeFileSync(join(env.HOME, ".agendo"), "");
  const r = await agendo(env, "url", "agendo://focus?pr=5001");
  expect(r.code).not.toBe(0);
  expect((await notifications(mock)).join("\n"), r.stderr).toContain("cannot record their use in its state dir");
  expect(await switches(mock)).toEqual([]);
});

test("url may resume only once in quick succession; focus typed by hand is not throttled", async ({ mock }) => {
  await seed(mock);
  const first = await agendo(mock.env, "url", "agendo://focus?session=standalonese");
  expect(first.code, first.stderr).toBe(0);
  await pastFocusFloor();
  const second = await agendo(mock.env, "url", `agendo://focus?workItem=102`);
  expect(second.code).not.toBe(0);
  expect((await notifications(mock)).join("\n")).toContain("not resuming another session from a link so soon");
  // An already-running session is still focused through a link: only resumes are throttled.
  await pastFocusFloor();
  const running = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(running.code, running.stderr).toBe(0);
  const typed = await agendo(mock.env, "focus", "--work-item", "102");
  expect(typed.code, typed.stderr).toBe(0);
});

test("url focuses through the same path as focus", async ({ mock }) => {
  await seed(mock);
  const r = await agendo(mock.env, "url", "agendo://focus?pr=5001");
  expect(r.code, r.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, RUNNING_TARGET)]]);
});

test("a link's repo narrows the lookup to the PR in that repo", async ({ mock }) => {
  await seed(mock);
  const elsewhere = await agendo(mock.env, "url", "agendo://focus?pr=5001&repo=acme/other");
  expect(elsewhere.code).not.toBe(0);
  // The repo is the page's free text: stderr names it, the notification does not.
  expect(elsewhere.stderr).toContain("PR !5001 in acme/other");
  expect(await notifications(mock)).toEqual(["notify-send --app-name=agendo agendo No agendo session for PR !5001"]);
  expect(await switches(mock)).toEqual([]);
  // The PR's session lives in appweb: the same number from appweb's page focuses it.
  const typed = await agendo(mock.env, "focus", "--pr", "5001", "--repo", "appweb");
  expect(typed.code, typed.stderr).toBe(0);
  expect(await switches(mock)).toEqual([["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, RUNNING_TARGET)]]);
});

test("a link's repo may be the ADO repository id: a known one narrows, an unknown GUID-shaped one matches every repo", async ({ mock }) => {
  await seed(mock);
  // PR 5001 lives in appweb (repository id repoA-guid). A known id is matched as
  // it is, whatever its shape; only an unknown GUID widens.
  // The one link (links are throttled) is the reported case: a real GUID agendo does not know.
  const link = await agendo(mock.env, "url", "agendo://focus?pr=5001&repo=4b12fdea-5ae3-48d4-a2cd-1f47d10700ce");
  expect(link.code, link.stderr).toBe(0);
  const to = ["switch-client", "-c", "/dev/pts/7", "-t", switchTarget(mock.env, RUNNING_TARGET)];
  expect(await switches(mock)).toEqual([to]);
  const own = await agendo(mock.env, "focus", "--pr", "5001", "--repo", "repoA-guid");
  expect(own.code, own.stderr).toBe(0);
  expect(await switches(mock)).toEqual([to, to]);
});

const MALICIOUS = [
  "agendo://launch?prompt=rm%20-rf",
  "agendo://focus?pr=5001&session=x",
  "agendo://focus?pr=5001%26workItem=1",
  "agendo://focus?pr=$(touch${IFS}/tmp/pwned)",
  "agendo://focus?pr=5001;id",
  "agendo://focus?session=--attach",
  "agendo://focus?pr=5001&repo=../../etc",
  "agendo://focus?session=standalonese&repo=appweb",
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
  const apps = join(mock.tmpDir, "data", "applications");

  const before = await agendo(env, "url-handler", "status");
  expect(before.code).not.toBe(0);
  expect(before.stdout).toContain("not installed");

  const inst = await agendo(env, "url-handler", "install", "--exec", "/opt/agendo/bin/agendo");
  expect(inst.code, inst.stderr).toBe(0);
  expect(inst.stdout).toContain(file);
  const text = readFileSync(file, "utf-8");
  // Run under a PATH with bun on it: the desktop session's own has no ~/.bun/bin.
  expect(text).toMatch(/^Exec=\/usr\/bin\/env "?PATH=\/\S* \/opt\/agendo\/bin\/agendo url %u$/m);
  expect(text).toContain("MimeType=x-scheme-handler/agendo;");
  expect(text).toContain("NoDisplay=true");
  expect(await mock.callLog()).toContain("xdg-mime default agendo-url-handler.desktop x-scheme-handler/agendo");
  // The desktop database is refreshed for exactly the dir the entry went into, so the portal sees it.
  expect(await mock.callLog()).toContain(`update-desktop-database ${apps}`);
  expect(readFileSync(join(apps, "mimeinfo.cache"), "utf-8")).toContain("x-scheme-handler/agendo=agendo-url-handler.desktop;");
  expect(inst.stderr).not.toContain("warning");

  const st = await agendo(env, "url-handler", "status");
  expect(st.code, st.stdout).toBe(0);
  expect(st.stdout).toContain("x-scheme-handler/agendo: agendo-url-handler.desktop");
  expect(st.stdout).not.toContain("mimeinfo.cache");

  const un = await agendo(env, "url-handler", "uninstall");
  expect(un.code, un.stderr).toBe(0);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(mimeapps, "utf-8")).not.toContain("x-scheme-handler/agendo");
  expect((await mock.callLog()).filter((l) => l.startsWith("update-desktop-database "))).toEqual([
    `update-desktop-database ${apps}`, `update-desktop-database ${apps}`,
  ]);
  expect(readFileSync(join(apps, "mimeinfo.cache"), "utf-8")).not.toContain("x-scheme-handler/agendo");
});

test("url-handler uninstall refreshes the database only when it removed an entry or one exists", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const apps = join(mock.tmpDir, "data", "applications");
  mkdirSync(apps, { recursive: true });
  const bare = await agendo(env, "url-handler", "uninstall");
  expect(bare.code, bare.stderr).toBe(0);
  expect((await mock.callLog()).some((l) => l.startsWith("update-desktop-database"))).toBe(false);
  // A database that may still list a stale entry is rebuilt, though nothing was removed.
  writeFileSync(join(apps, "mimeinfo.cache"), "[MIME Cache]\nx-scheme-handler/agendo=agendo-url-handler.desktop;\n");
  const stale = await agendo(env, "url-handler", "uninstall");
  expect(stale.code, stale.stderr).toBe(0);
  expect(await mock.callLog()).toContain(`update-desktop-database ${apps}`);
  expect(readFileSync(join(apps, "mimeinfo.cache"), "utf-8")).not.toContain("x-scheme-handler/agendo");
});

test("url-handler status warns when the desktop database does not list the entry", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const apps = join(mock.tmpDir, "data", "applications");
  const inst = await agendo(env, "url-handler", "install", "--exec", "/opt/agendo/bin/agendo");
  expect(inst.code, inst.stderr).toBe(0);
  // Default set, but not registered: what `gio mime` shows as "No registered applications".
  writeFileSync(join(apps, "mimeinfo.cache"), "[MIME Cache]\ntext/html=firefox.desktop;\n");
  const st = await agendo(env, "url-handler", "status");
  expect(st.code).toBe(1);
  expect(st.stdout).toContain("x-scheme-handler/agendo: agendo-url-handler.desktop");
  expect(st.stdout).toContain(`warning: ${join(apps, "mimeinfo.cache")} does not list agendo-url-handler.desktop`);
  expect(st.stdout).toContain(`run \`update-desktop-database ${apps}\``);
});

/**
 * A PATH with every fake but update-desktop-database, plus only the real tools
 * the CLI and the fakes need — so the real binary, which /usr/bin may well hold,
 * is out of reach as surely as a desktop without desktop-file-utils.
 */
function pathWithoutUpdateDb(mock: MockEnv): string {
  const bin = join(mock.tmpDir, "bin-without-update-db");
  mkdirSync(bin);
  const fakebin = join(REPO_ROOT, "e2e", "fakebin");
  for (const name of readdirSync(fakebin)) {
    if (name !== "update-desktop-database") symlinkSync(join(fakebin, name), join(bin, name));
  }
  const realDirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const tool of ["bun", "bash", "grep", "mkdir", "dirname", "touch", "mv", "head", "cut", "sed", "cat"]) {
    const dir = realDirs.find((d) => existsSync(join(d, tool)));
    if (dir) symlinkSync(join(dir, tool), join(bin, tool));
  }
  return bin;
}

test("url-handler install and uninstall only warn when update-desktop-database is missing", async ({ mock }) => {
  const env = {
    ...mock.env, PATH: pathWithoutUpdateDb(mock), XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config"),
  };
  const apps = join(mock.tmpDir, "data", "applications");
  const inst = await agendo(env, "url-handler", "install", "--exec", "/opt/agendo/bin/agendo");
  expect(inst.code, inst.stderr).toBe(0);
  expect(inst.stderr).toContain(`warning: update-desktop-database could not run`);
  expect(inst.stderr).toContain(`run \`update-desktop-database ${apps}\``);
  expect(existsSync(join(apps, "agendo-url-handler.desktop"))).toBe(true);
  expect(await mock.callLog()).toContain("xdg-mime default agendo-url-handler.desktop x-scheme-handler/agendo");
  // Nothing rebuilt the database: no real update-desktop-database ran either.
  expect(existsSync(join(apps, "mimeinfo.cache"))).toBe(false);

  const st = await agendo(env, "url-handler", "status");
  expect(st.code).toBe(1);
  expect(st.stdout).toContain("does not list agendo-url-handler.desktop");

  const un = await agendo(env, "url-handler", "uninstall");
  expect(un.code, un.stderr).toBe(0);
  expect(un.stderr).toContain(`run \`update-desktop-database ${apps}\``);
  expect(existsSync(join(apps, "agendo-url-handler.desktop"))).toBe(false);
  expect(existsSync(join(apps, "mimeinfo.cache"))).toBe(false);
});

test("url-handler status warns when the program its entry starts is gone", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const inst = await agendo(env, "url-handler", "install", "--exec=/nonexistent/agendo-bin --flag");
  expect(inst.code, inst.stderr).toBe(0);
  expect(readFileSync(join(mock.tmpDir, "data", "applications", "agendo-url-handler.desktop"), "utf-8"))
    .toContain(" /nonexistent/agendo-bin --flag url %u");
  const st = await agendo(env, "url-handler", "status");
  expect(st.stdout).toContain("warning: /nonexistent/agendo-bin does not exist");
});

test("url-handler reinstall is idempotent, and its entry finds bun under its own PATH", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const file = join(mock.tmpDir, "data", "applications", "agendo-url-handler.desktop");
  const wrapper = join(mock.tmpDir, "agendo-wrapper");
  writeFileSync(wrapper, '#!/bin/bash\nexec bun x agendo "$@"\n', { mode: 0o755 });
  const first = await agendo(env, "url-handler", "install", "--exec", wrapper);
  expect(first.code, first.stderr).toBe(0);
  const text = readFileSync(file, "utf-8");
  const again = await agendo(env, "url-handler", "install", "--exec", wrapper);
  expect(again.code, again.stderr).toBe(0);
  expect(readFileSync(file, "utf-8")).toBe(text);
  expect(text.match(/^Exec=.*$/gm)).toHaveLength(1);
  expect(text.match(/PATH=/g)).toHaveLength(1);
  const st = await agendo(env, "url-handler", "status");
  expect(st.code, st.stdout).toBe(0);
  expect(st.stdout).not.toContain("warning");
});

test("url-handler status warns when its entry runs bun without a PATH that has it", async ({ mock }) => {
  // The desktop session's PATH is systemd's default; a machine with bun in one of those dirs cannot show the bug.
  test.skip(["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"].some((d) => existsSync(join(d, "bun"))));
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const apps = join(mock.tmpDir, "data", "applications");
  const wrapper = join(mock.tmpDir, "agendo-wrapper");
  writeFileSync(wrapper, '#!/bin/bash\nexec bun x agendo "$@"\n', { mode: 0o755 });
  // An entry from before install baked a PATH in: what the reported link ran, and silently failed.
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, "agendo-url-handler.desktop"), `[Desktop Entry]\nType=Application\nExec=${wrapper} url %u\n`);
  const st = await agendo(env, "url-handler", "status");
  expect(st.stdout).toContain(`warning: ${wrapper} runs bun, which is not on the desktop session's PATH`);
  expect(st.stdout).toContain("re-run `url-handler install`");
});

test("url-handler status warns about an entry from before the fix that runs bunx without bun on PATH", async ({ mock }) => {
  test.skip(["/usr/local/bin", "/usr/bin", "/bin", "/usr/local/sbin", "/usr/sbin", "/sbin"].some((d) => existsSync(join(d, "bun"))));
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const apps = join(mock.tmpDir, "data", "applications");
  // bunx by absolute path still runs agendo's `#!/usr/bin/env bun` bin, which asks PATH for bun.
  const bunx = join(mock.tmpDir, "bunx");
  writeFileSync(bunx, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  mkdirSync(apps, { recursive: true });
  writeFileSync(join(apps, "agendo-url-handler.desktop"), `[Desktop Entry]\nType=Application\nExec=${bunx} agendo@0.3.0 url %u\n`);
  const st = await agendo(env, "url-handler", "status");
  expect(st.stdout).toContain(`warning: ${bunx} runs bun, which is not on the desktop session's PATH`);
});

const BAD_HANDLER_ARGS: string[][] = [
  ["url-handler"],
  ["url-handler", "frobnicate"],
  ["url-handler", "install", "--bogus"],
  ["url-handler", "install", "--exec"],
  ["url-handler", "install", "--exec", "has%percent"],
  ["url-handler", "status", "extra"],
];

for (const argv of BAD_HANDLER_ARGS) {
  test(`url-handler refuses ${argv.slice(1).join(" ") || "no subcommand"}`, async ({ mock }) => {
    const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
    const r = await agendo(env, ...argv);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("url-handler:");
    expect(existsSync(join(mock.tmpDir, "data", "applications"))).toBe(false);
    expect((await mock.callLog()).some((l) => l.startsWith("xdg-mime default"))).toBe(false);
    expect((await mock.callLog()).some((l) => l.startsWith("update-desktop-database"))).toBe(false);
  });
}

test("url-handler install defaults to a stable command, never a /tmp runner copy", async ({ mock }) => {
  const env = { ...mock.env, XDG_DATA_HOME: join(mock.tmpDir, "data"), XDG_CONFIG_HOME: join(mock.tmpDir, "config") };
  const r = await agendo(env, "url-handler", "install");
  expect(r.code, r.stderr).toBe(0);
  const exec = readFileSync(join(mock.tmpDir, "data", "applications", "agendo-url-handler.desktop"), "utf-8").match(/^Exec=(.*)$/m)?.[1];
  expect(exec).toMatch(/^\/\S+ .*url %u$/);
  expect(exec).not.toMatch(/\/tmp\//);
});
