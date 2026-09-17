// End-to-end: WINDOW ADOPTION. The user opens a window by hand in agendo's own
// tmux session (`ctrl+b c`) and types `claude`; the menu's background rescan
// must notice, identify which on-disk session it is, tag the window, rename it
// to the canonical `cl-claude-<id>` and show it as running — with nothing else
// in the session touched. Driven against the fake tmux (e2e/fakebin/tmux), so
// what the launcher DID is read off its call log and the state file, and the
// on-disk half — claude's per-process record under `~/.claude/sessions/` — is
// written into the fake HOME like any other fixture.
//
// The identity source is that record, not the transcript: it names the pane by
// id, and the pane id is what the fixture and the assertion meet on. Its pid is
// this test worker's own, which is the one pid guaranteed alive for the whole
// run; the negative case names a pid nothing can hold.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { CRASH_SESSION_ID, RUNNING_TARGET, tmuxState } from "./harness/fixtures.ts";
import type { MockEnv } from "./harness/mockEnv.ts";

/** An idle claude TUI — an empty input box — so the adopted row reads as ready. */
const READY_PANE = ["  ● Triage the crash", "  ────────────────────────────", "  ❯ ", "  ────────────────────────────", "  ? for shortcuts"].join("\n");

// The canonical name for the crash session (`sessionName("claude", "crash-session")`).
const CRASH_CANON = "cl-claude-crashsession";
// Where the fixture's crash session ran (see fixtures.ts `paths`).
const crashCwd = (home: string) => join(home, "repos", "appweb", ".claude", "worktrees", "fix-crash-102");

/** A host session holding the menu and one hand-opened window running claude. */
function hostWithHandWindow(home: string) {
  return {
    ...tmuxState,
    sessions: [RUNNING_TARGET, "agendo"],
    // The window records carry a cwd because the fake answers `list-windows`'
    // `#{pane_current_path}` from the window record, and the restore capture
    // skips a window that reports none.
    windows: [
      { session: "agendo", index: 0, name: "launcher", cwd: home },
      { session: "agendo", index: 1, name: "claude", cwd: crashCwd(home) }, // tmux's automatic-rename after the command
    ],
    panes: [
      ...tmuxState.panes,
      { session: "agendo", window: "launcher", cwd: home, placeholder: false, id: "%1" },
      { session: "agendo", window: "claude", cwd: crashCwd(home), placeholder: false, id: "%7" },
    ],
    captures: { ...tmuxState.captures, [CRASH_CANON]: READY_PANE, claude: READY_PANE },
  };
}

/**
 * Write claude's per-process record for `pid`, claiming pane `%7` of `agendo`.
 * The shape is the registry entry src/orchestration/peer.ts accepts — protocol
 * marker and socket path included — since that is the reader adoption sits on.
 */
async function writeRecord(mock: MockEnv, pid: number, over: Record<string, unknown> = {}): Promise<void> {
  const dir = join(mock.home, ".claude", "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${pid}.json`),
    JSON.stringify({
      pid, sessionId: CRASH_SESSION_ID, cwd: crashCwd(mock.home), startedAt: Date.now(), version: "2.1.273",
      kind: "interactive", entrypoint: "cli", tmux: "agendo:@9.%7", status: "idle", peerProtocol: 1,
      messagingSocketPath: join(mock.home, `cc-${pid}.sock`), ...over,
    }),
  );
}

test("a hand-opened claude window is tagged, renamed and listed as running", async ({ launch, mock }) => {
  await mock.setTmuxState(hostWithHandWindow(mock.home));
  await writeRecord(mock, process.pid);

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  // The crash session was cold in every other spec; here the poll adopts its
  // window and it comes up running. The fixture's login session already fills
  // the "Running now" section on its own, so the header alone proves nothing:
  // the COUNT has to grow from one to two.
  await wt.waitForText("Investigate startup crash", 15000);
  await expect.poll(async () => (await mock.getTmuxState()).windows.map((w: { name: string }) => w.name), { timeout: 10000 })
    .toEqual(["launcher", CRASH_CANON]);
  await wt.waitForText(/Running now\s+\(2\)/, 10000);

  const state = await mock.getTmuxState();
  const adopted = state.windows.find((w: { name: string }) => w.name === CRASH_CANON);
  // The tag is the authoritative attribution tier, and it says ADOPTED — never
  // `launched`, which is reserved for windows agendo created itself.
  expect(adopted.tags).toMatchObject({
    "@cl_session_id": CRASH_SESSION_ID, "@cl_source": "claude", "@cl_acquired": "adopted", "@cl_branch": "worktree-fix-crash-102",
  });
  // The menu window is exactly as it was: not renamed, not tagged.
  expect(state.windows[0]).toMatchObject({ name: "launcher" });
  expect(state.windows[0].tags).toBeUndefined();

  const log = await mock.tmuxLog();
  // Everything addressed the pane by ID — the one handle that cannot bind to a
  // neighbour by prefix — and the name was pinned after the rename, or tmux's
  // automatic-rename would undo it on the next command.
  expect(log).toContainEqual(["rename-window", "-t", "%7", CRASH_CANON]);
  expect(log).toContainEqual(["set-window-option", "-t", "%7", "automatic-rename", "off"]);
  expect(log).toContainEqual(["set-option", "-w", "-t", "%7", "@cl_acquired", "adopted"]);
  // Exactly one rename: the next tick sees a managed window and leaves it be.
  expect(log.filter((a) => a[0] === "rename-window")).toHaveLength(1);
  expect(log.filter((a) => a[0] === "kill-window" || a[0] === "kill-pane")).toHaveLength(0);

  // A full reload snapshots the host session's tabs for restore. The adopted
  // window is a `cl-*` window with a tag now, so it is captured like any
  // launched tab — under the canonical name, with a real resume command — and
  // comes back as a paused tab the next time the host session is created.
  wt.write("r");
  await wt.waitForText("Investigate startup crash", 20000);
  await expect.poll(async () => {
    const raw = await readFile(join(mock.home, ".agendo", "restore", "agendo.json"), "utf-8").catch(() => "{}");
    const tabs = (JSON.parse(raw) as { tabs?: { name: string; argv: string[] }[] }).tabs ?? [];
    return tabs.map((t) => [t.name, t.argv.includes(CRASH_SESSION_ID)]);
  }, { timeout: 10000 }).toEqual([[CRASH_CANON, true]]);
});

test("a record for a process that no longer exists adopts nothing", async ({ launch, mock }) => {
  // The stale record a crashed claude leaves behind names a pid the kernel has
  // long since handed out — and a pane that may now hold the user's shell.
  await mock.setTmuxState(hostWithHandWindow(mock.home));
  await writeRecord(mock, 2 ** 30);

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  wt.write("3");
  await wt.waitForText("Sessions");
  // Let the 2s poll run at least twice more after the initial load — every scan
  // is one `list-panes -a` — then prove none of them acted.
  await expect.poll(async () => (await mock.tmuxLog()).filter((a) => a[0] === "list-panes" && a.includes("-a")).length, {
    timeout: 15000,
  }).toBeGreaterThanOrEqual(3);
  const state = await mock.getTmuxState();
  expect(state.windows.map((w: { name: string }) => w.name)).toEqual(["launcher", "claude"]);
  const log = await mock.tmuxLog();
  expect(log.filter((a) => a[0] === "rename-window")).toHaveLength(0);
  expect(log.filter((a) => a[0] === "set-option" && a.includes("-w"))).toHaveLength(0);
});

test("a claude split beside the menu is adopted as a pane, and the menu window is left alone", async ({ launch, mock }) => {
  const base = hostWithHandWindow(mock.home);
  await mock.setTmuxState({
    ...base,
    windows: [{ session: "agendo", index: 0, name: "launcher" }],
    panes: [
      ...tmuxState.panes,
      { session: "agendo", window: "launcher", cwd: mock.home, placeholder: false, id: "%1" },
      { session: "agendo", window: "launcher", cwd: crashCwd(mock.home), placeholder: false, id: "%7" },
    ],
  });
  await writeRecord(mock, process.pid);

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  wt.write("3");
  await wt.waitForText("Investigate startup crash", 15000);
  await expect.poll(async () => {
    const s = await mock.getTmuxState();
    return s.panes.find((p: { id?: string }) => p.id === "%7")?.paneTarget;
  }, { timeout: 10000 }).toBe(CRASH_CANON);
  // Running now already held the login session; the adopted pane makes two.
  await wt.waitForText(/Running now\s+\(2\)/, 10000);

  const state = await mock.getTmuxState();
  expect(state.windows).toEqual([{ session: "agendo", index: 0, name: "launcher" }]);
  const log = await mock.tmuxLog();
  expect(log).toContainEqual(["set-option", "-p", "-t", "%7", "@cl_pane_target", CRASH_CANON]);
  expect(log.filter((a) => a[0] === "rename-window")).toHaveLength(0);
  expect(log.filter((a) => a[0] === "set-option" && a.includes("-w"))).toHaveLength(0);
});

test("a paused tab for the same session is retired, and the hand-opened window takes its place", async ({ launch, mock }) => {
  // After a restart the crash session sits in the host as a placeholder window
  // (idle bash, `@cl_placeholder`), and the user resumes it by hand in a new
  // window instead of pressing into the tab. Without the retirement the host
  // would end up with two windows under one canonical name, and `close` would
  // hit the idle one. The placeholder is the ONE kill adoption may ever issue,
  // and it is addressed by the placeholder's pane id, never by the name the
  // hand-opened window is about to take.
  const base = hostWithHandWindow(mock.home);
  await mock.setTmuxState({
    ...base,
    windows: [
      ...base.windows,
      { session: "agendo", index: 2, name: CRASH_CANON, cwd: crashCwd(mock.home), placeholder: true },
    ],
    panes: [...base.panes, { session: "agendo", window: CRASH_CANON, cwd: crashCwd(mock.home), placeholder: true, id: "%5" }],
  });
  await writeRecord(mock, process.pid);

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  wt.write("3");
  await wt.waitForText("Investigate startup crash", 15000);
  await expect.poll(async () => (await mock.getTmuxState()).windows.map((w: { name: string }) => w.name), { timeout: 10000 })
    .toEqual(["launcher", CRASH_CANON]);
  // The paused tab already sat in "Running now" (placeholders count there, under
  // ⏸), so the count does not move here; what moves is the crash row's glyph,
  // ⏸ → ●, once the live scan attributes the session to the adopted window.
  await wt.waitForText(/●[^\n]*Investigate startup crash/, 10000);

  const state = await mock.getTmuxState();
  // The survivor is the hand-opened window (index 1, the record's pane), not the placeholder.
  expect(state.windows[1]).toMatchObject({ index: 1, name: CRASH_CANON });
  expect(state.windows[1].placeholder).toBeFalsy();
  expect(state.panes.some((p: { id?: string }) => p.id === "%5")).toBe(false);
  expect(state.panes.find((p: { id?: string }) => p.id === "%7")?.window).toBe(CRASH_CANON);
  const log = await mock.tmuxLog();
  const kills = log.filter((a) => a[0] === "kill-window" || a[0] === "kill-pane");
  expect(kills).toEqual([["kill-pane", "-t", "%5"]]);
  // ...and the kill was preceded by a re-read of the flag on that same pane,
  // not by a lookup of the name the hand window was about to take.
  const killAt = log.findIndex((a) => a[0] === "kill-pane");
  expect(log.slice(0, killAt).some((a) => a[0] === "list-panes" && a[1] === "-t" && a[2] === "%5")).toBe(true);
  expect(log.filter((a) => a[0] === "rename-window")).toEqual([["rename-window", "-t", "%7", CRASH_CANON]]);
});
