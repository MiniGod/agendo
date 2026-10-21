// One repo, one orchestrator — end to end (src/orchestration/repoOrchestrator.ts
// decides which session it is; src/launch/existingOrchestrator.ts brings the
// user to it).
//
// A second orchestrator in a repo squash-merges into the same main branch as the
// first, each unaware of what the other briefed. So every way of starting one —
// `O`, `G` when the scope is a repo, `launch --orchestrator` — looks first, and
// opens what is there: switched to when running, woken in its tab when paused,
// resumed when idle. Only a repo with none gets a new one. The Sessions view pins
// the answer above the list so it is readable before any key is pressed.
import { spawn } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import { CODEX_SESSION_ID, CRASH_SESSION_ID, LOGIN_SESSION_ID, RUNNING_TARGET, sessionName } from "./harness/fixtures.ts";
import { REPO_ROOT, type MockEnv } from "./harness/mockEnv.ts";

const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
const appweb = (home: string) => join(home, "repos", "appweb");

/** Mark fixture sessions as orchestrators of the given roles, as a launch would. */
async function markOrchestrators(home: string, roles: Record<string, "repo" | "global">): Promise<void> {
  await mkdir(join(home, ".agendo"), { recursive: true });
  await writeFile(join(home, ".agendo", "orchestrators.json"), JSON.stringify({ ids: Object.keys(roles) }));
  await writeFile(join(home, ".agendo", "orchestratorRoles.json"), JSON.stringify({ roles }));
}

/**
 * A session in the repo root that LOOKS like an orchestrator but was never
 * recorded as one — what an orchestrator started before the markers existed (or
 * by hand) leaves behind. The real duplicate: it must read as stale, never as
 * the one `O` opens.
 */
async function legacyLookalike(home: string): Promise<void> {
  const dir = join(home, ".claude", "projects", "appweb-legacy");
  await mkdir(dir, { recursive: true });
  const at = "2026-06-28T09:00:00.000Z";
  await writeFile(
    join(dir, "0e6e2941-1111-4222-8333-444455556666.jsonl"),
    [
      { type: "summary", cwd: appweb(home), gitBranch: "master", timestamp: at },
      { type: "ai-title", aiTitle: "appweb-orchestrator", timestamp: at },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

/**
 * A linked worktree of appweb OUTSIDE `.claude/worktrees/` — what `git worktree
 * add ../appweb-feat` leaves: a `.git` FILE pointing into appweb's own `.git`.
 */
async function appwebFeat(home: string): Promise<string> {
  const gitDir = join(appweb(home), ".git", "worktrees", "appweb-feat");
  await mkdir(gitDir, { recursive: true });
  await writeFile(join(gitDir, "commondir"), "../..\n");
  const at = join(home, "repos", "appweb-feat");
  await mkdir(at, { recursive: true });
  await writeFile(join(at, ".git"), `gitdir: ${gitDir}\n`);
  return at;
}

/** The crash session parked as a paused restore tab in the `agendo` host session. */
async function crashPaused(mock: MockEnv): Promise<void> {
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      // A window option in real tmux, so both the window and the pane listing
      // carry it — and the wake re-reads it from the window side.
      { session: "agendo", index: 2, name: CRASH_TARGET, placeholder: true },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: CRASH_TARGET, cwd: "/run/crash", placeholder: true },
    ],
    captures: {},
  });
}

async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

/** Anything that would be a NEW orchestrator: a fresh `cl-new-…` launch. */
const freshLaunches = (log: string[][]) => log.filter((a) => a[0] === "new-session" && a.some((t) => t.startsWith("cl-new-")));

/** The CLI from `cwd`, without blocking (the session index build is async). */
function agendoIn(cwd: string, env: Record<string, string>, ...args: string[]) {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res) => child.on("close", (code) => res({ code, stdout, stderr })));
}

/** The launcher scoped to `dir`, on the Sessions view. */
async function sessionsIn(launch: (o?: { args?: string[]; cols?: number; rows?: number }) => Promise<any>, dir: string) {
  const wt = await launch({ args: [dir], cols: 160, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  await wt.waitForText("Running now");
  return wt;
}

test.beforeEach(({ mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
});

// ── the TUI, scoped to one repo ───────────────────────────────────────────────

test("scoped to a repo: the pinned row names its orchestrator, and O switches to it instead of starting a second", async ({ launch, mock }) => {
  await markOrchestrators(mock.home, { [LOGIN_SESSION_ID]: "repo" });
  await legacyLookalike(mock.home);
  const wt = await sessionsIn(launch, appweb(mock.home));
  const screen = await wt.waitForText("▌ Orchestrator");
  expect(screen).toContain("▌ Orchestrator  appweb  ● running  Implement login form  ·  O/G switch to it");
  // The look-alike is named, and named as NOT what the key opens.
  expect(screen).toContain("⚠ stale, not what O/G opens: appweb-orchestrator (○ idle)");
  // One repo, so the two coordinator keys share one hint.
  expect(screen).toContain("O/G orch");
  expect(screen).not.toContain("G global");

  wt.write("O");
  await waitUntil(async () => (await mock.tmuxLog()).some((a) => a[0] === "attach-session" && a.some((t) => t.includes(RUNNING_TARGET))));
  expect(freshLaunches(await mock.tmuxLog())).toEqual([]);
  // No picker on the way: the existing one IS the answer.
  expect(await wt.screen()).not.toContain("pick an agent");
});

test("scoped to a repo, G is O: an idle orchestrator is resumed, and the global one is not started", async ({ launch, mock }) => {
  await markOrchestrators(mock.home, { [CRASH_SESSION_ID]: "repo" });
  const wt = await sessionsIn(launch, appweb(mock.home));
  expect(await wt.waitForText("▌ Orchestrator")).toContain("○ idle  Investigate startup crash  ·  O/G resume it");

  wt.write("G");
  await waitUntil(async () =>
    (await mock.tmuxLog()).some((a) => a[0] === "new-session" && a.includes(CRASH_TARGET) && a.includes("--resume") && a.includes(CRASH_SESSION_ID)),
  );
  const log = await mock.tmuxLog();
  expect(freshLaunches(log)).toEqual([]);
  expect(log.some((a) => a.some((t) => t.includes("GLOBAL ORCHESTRATOR MODE")))).toBe(false);
});

test("a paused orchestrator is woken in its own tab, not respawned beside it", async ({ launch, mock }) => {
  await markOrchestrators(mock.home, { [CRASH_SESSION_ID]: "repo" });
  await crashPaused(mock);
  const wt = await sessionsIn(launch, appweb(mock.home));
  expect(await wt.waitForText("▌ Orchestrator")).toContain("⏸ paused  Investigate startup crash  ·  O/G resume it");

  wt.write("O");
  const tab = `=agendo:=${CRASH_TARGET}`;
  // Any key but q/esc wakes the placeholder loop; then the user is taken to that
  // exact tab — no `new-session`, which outside tmux would start a twin.
  await waitUntil(async () => {
    const log = await mock.tmuxLog();
    const woke = log.findIndex((a) => a[0] === "send-keys" && a.includes(tab) && a.includes("Enter"));
    const went = log.findIndex((a) => a[0] === "attach-session" && a.includes(tab));
    return woke >= 0 && went > woke;
  });
  expect((await mock.tmuxLog()).filter((a) => a[0] === "new-session")).toEqual([]);
});

test("a repo with none: O asks only for the agent, then where to run it — the repo is the scope", async ({ launch, mock }) => {
  const wt = await sessionsIn(launch, appweb(mock.home));
  expect(await wt.waitForText("▌ Orchestrator")).toContain("▌ Orchestrator  appweb  – none  ·  O/G start one");

  wt.write("O");
  await wt.waitForText("Orchestrator session — pick an agent");
  await wt.press(KEY.enter); // Claude → straight to the worktree choice, no repo picker
  const screen = await wt.waitForText("choose where to run");
  expect(screen).toContain("Orchestrator session in appweb");
  // Back goes to the step that was actually shown.
  await wt.press(KEY.escape);
  await wt.waitForText("Orchestrator session — pick an agent");

  // And through to the launch: in the main checkout — the default for an
  // orchestrator — recorded as THE repo's one.
  await wt.press(KEY.enter);
  expect(await wt.waitForText("choose where to run")).toMatch(/❯\s*Main repo checkout/);
  await wt.waitForStable();
  await wt.press(KEY.enter);
  await waitUntil(async () => freshLaunches(await mock.tmuxLog()).length > 0);
  const [started] = freshLaunches(await mock.tmuxLog());
  expect(started).toContain(appweb(mock.home));
  // Recorded by id (a repo-level role is the default, so it is the id alone),
  // and the window it launched in carries that id.
  const { ids } = JSON.parse(await readFile(join(mock.home, ".agendo", "orchestrators.json"), "utf-8")) as { ids: string[] };
  expect(ids).toHaveLength(1);
  expect(started).toContain(`cl-new-${ids[0].replace(/-/g, "").slice(0, 12)}`);
});

// ── the TUI over several repos ────────────────────────────────────────────────

test("scoped to a folder of repos: the block counts them, and G is still the global orchestrator", async ({ launch, mock }) => {
  await markOrchestrators(mock.home, { [LOGIN_SESSION_ID]: "repo" });
  const repos = join(mock.home, "repos");
  const wt = await sessionsIn(launch, repos);
  const screen = await wt.waitForText("▌ Orchestrators");
  expect(screen).toContain("● 1 running · – 2 none");
  expect(screen).toContain("● appweb  Implement login form");
  expect(screen).toContain("none in: applib, standalone");
  expect(screen).toContain("O orch · G global");

  wt.write("G");
  await waitUntil(async () => {
    const spawned = (await mock.tmuxLog()).find((a) => a[0] === "new-session" && a.includes(repos) && a.includes("claude"));
    return !!spawned && spawned.some((t) => t.includes("GLOBAL ORCHESTRATOR MODE"));
  });
});

test("unscoped: O through the repo picker opens the repo's existing orchestrator", async ({ launch, mock }) => {
  await markOrchestrators(mock.home, { [LOGIN_SESSION_ID]: "repo" });
  // Inside tmux, so the open is an inline switch and the menu stays up to say
  // what it did (outside, the attach hands the terminal over and the menu
  // restarts on return, notice and all).
  mock.env.TMUX = "/tmp/fake-tmux,1,0";
  const wt = await launch({ cols: 160, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  await wt.waitForText("Running now");

  wt.write("O");
  await wt.waitForText("Orchestrator session — pick an agent");
  await wt.press(KEY.enter); // Claude
  await wt.waitForText("Orchestrator session — pick a repo");
  await wt.press(KEY.enter); // appweb, which already has one → opened, no worktree choice
  await waitUntil(async () => (await mock.tmuxLog()).some((a) => a[0] === "switch-client" && a.some((t) => t.includes(RUNNING_TARGET))));
  expect(await wt.waitForText("already has an orchestrator")).toContain(
    "appweb already has an orchestrator — switched to Implement login form (claude) instead of starting a second",
  );
  expect(freshLaunches(await mock.tmuxLog())).toEqual([]);
});

// ── the CLI ───────────────────────────────────────────────────────────────────

test("launch --orchestrator in a repo with a running one says so, delivers nothing, and starts nothing", async ({ mock }) => {
  await markOrchestrators(mock.home, { [LOGIN_SESSION_ID]: "repo" });
  // From inside a worktree of the repo: the repo is the main checkout's.
  const r = await agendoIn(join(appweb(mock.home), ".claude", "worktrees", "login"), mock.env, "launch", "--orchestrator", "--model", "opus", "Ship the release");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("▸ appweb already has an orchestrator (running): Implement login form (claude) — not starting a second");
  expect(r.stdout).toContain("prompt:  NOT delivered");
  // A flag that only shapes a new one is said to have done nothing.
  expect(r.stdout).toContain("ignored: --model — they shape a new orchestrator, and none is started");
  expect(r.stdout).not.toContain("launched orchestrator session");
  expect((await mock.tmuxLog()).filter((a) => a[0] === "new-session")).toEqual([]);
});

test("launch --orchestrator in a repo with an idle one resumes it, the way resume would", async ({ mock }) => {
  await markOrchestrators(mock.home, { [CRASH_SESSION_ID]: "repo" });
  const r = await agendoIn(appweb(mock.home), mock.env, "launch", "--orchestrator", "Ship the release");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("(idle): Investigate startup crash (claude) — resuming it instead of starting a second");
  const log = await mock.tmuxLog();
  expect(log.some((a) => a[0] === "new-session" && a.includes("--resume") && a.includes(CRASH_SESSION_ID))).toBe(true);
  expect(freshLaunches(log)).toEqual([]);
});

test("launch --orchestrator --worktree=<path> looks in the repo that path is in, not the one it was run from", async ({ mock }) => {
  // The launch adopts the path wherever it lives, so the repo to ask is the
  // path's: run from somewhere else, it would otherwise find nothing there and
  // start appweb a second orchestrator.
  await markOrchestrators(mock.home, { [LOGIN_SESSION_ID]: "repo" });
  const elsewhere = join(mock.home, "repos", "standalone");
  const r = await agendoIn(elsewhere, mock.env, "launch", "--orchestrator", `--worktree=${join(appweb(mock.home), ".claude", "worktrees", "login")}`, "Ship it");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("▸ appweb already has an orchestrator (running): Implement login form (claude)");
  expect((await mock.tmuxLog()).filter((a) => a[0] === "new-session")).toEqual([]);
});

test("launch --orchestrator --attach with a running one switches to its window, starting nothing", async ({ mock }) => {
  await markOrchestrators(mock.home, { [LOGIN_SESSION_ID]: "repo" });
  const r = await agendoIn(appweb(mock.home), mock.env, "launch", "--orchestrator", "--attach");
  expect(r.code).toBe(0);
  const log = await mock.tmuxLog();
  expect(log.some((a) => a[0] === "attach-session" && a.some((t) => t.includes(RUNNING_TARGET)))).toBe(true);
  expect(log.filter((a) => a[0] === "new-session")).toEqual([]);
});

test("launch --orchestrator with a paused one resumes it, not a second beside it", async ({ mock }) => {
  await markOrchestrators(mock.home, { [CRASH_SESSION_ID]: "repo" });
  await crashPaused(mock);
  const r = await agendoIn(appweb(mock.home), mock.env, "launch", "--orchestrator");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("(paused): Investigate startup crash (claude) — resuming it instead of starting a second");
  const log = await mock.tmuxLog();
  // Exactly `resume`: the parked tab gives way to the agent resumed on its transcript.
  expect(log.some((a) => a[0] === "new-session" && a.includes("--resume") && a.includes(CRASH_SESSION_ID))).toBe(true);
  expect(log.filter((a) => a[0] === "new-session" && a.some((t) => /^cl-(?:bg|new)-/.test(t)))).toEqual([]);
});

test("launch --orchestrator where only a look-alike exists starts one, and names the look-alike as left alone", async ({ mock }) => {
  await legacyLookalike(mock.home);
  const r = await agendoIn(appweb(mock.home), mock.env, "launch", "--orchestrator", "Ship the release");
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("▸ appweb has no recorded orchestrator, so this starts one");
  expect(r.stderr).toMatch(/stale: {3}0e6e29411111 {2}appweb-orchestrator \(idle\) — left alone/);
  expect((await mock.tmuxLog()).filter((a) => a[0] === "new-session" && a.some((t) => t.startsWith("cl-bg-")))).toHaveLength(1);
});

test("launch --orchestrator from a linked worktree elsewhere starts it in the main checkout, where O would", async ({ mock }) => {
  const feat = await appwebFeat(mock.home);
  const r = await agendoIn(feat, mock.env, "launch", "--orchestrator", "Ship the release");
  expect(r.code).toBe(0);
  const call = (await mock.tmuxLog()).find((a) => a[0] === "new-session" && a.some((t) => t.startsWith("cl-bg-")));
  const cwd = call?.[call.indexOf("-c") + 1];
  expect(cwd && (await realpath(cwd))).toBe(await realpath(appweb(mock.home)));
});

test("list repos over a folder holding a linked worktree lists its repo once, not the worktree as a repo of its own", async ({ mock }) => {
  await appwebFeat(mock.home);
  const r = await agendoIn(mock.home, mock.env, "list", "repos", join(mock.home, "repos"), "--json");
  expect(r.code).toBe(0);
  const names = (JSON.parse(r.stdout) as Array<{ name: string }>).map((x) => x.name);
  expect(names).not.toContain("appweb-feat");
  expect(names.filter((n) => n === "appweb")).toHaveLength(1);
});

// ── one launched a moment ago ────────────────────────────────────────────────

test("one launched a moment ago is pinned as starting, and O switches to its window instead of a second", async ({ launch, mock }) => {
  // Its agent has written no transcript yet (the fake one never does), so only
  // its live window and its recorded id say it exists.
  const r = await agendoIn(appweb(mock.home), mock.env, "launch", "--orchestrator", "Ship the release");
  expect(r.code).toBe(0);
  const name = (await mock.tmuxLog()).find((a) => a[0] === "new-session")?.find((t) => t.startsWith("cl-bg-"));
  expect(name).toBeTruthy();

  const wt = await sessionsIn(launch, appweb(mock.home));
  expect(await wt.waitForText("◌ starting")).toContain(`▌ Orchestrator  appweb  ◌ starting  ${name}  ·  O/G switch to it`);
  wt.write("O");
  await waitUntil(async () => (await mock.tmuxLog()).some((a) => a[0] === "attach-session" && a.some((t) => t.includes(name!))));
  expect(freshLaunches(await mock.tmuxLog())).toEqual([]);
});

test("list repos names a Codex orchestrator too — recorded by its directory, as resume finds it", async ({ mock }) => {
  // Codex has no id until its rollout lands, so its orchestrator is recorded by
  // cwd. Read by id alone, the repo would list as unmanaged, and a global
  // orchestrator would start it a second.
  const codexCwd = join(appweb(mock.home), ".claude", "worktrees", "codex-tidy");
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(join(mock.home, ".agendo", "orchestratorCwds.json"), JSON.stringify({ cwds: { [codexCwd]: "repo" } }));
  const r = await agendoIn(appweb(mock.home), mock.env, "list", "repos", "--json");
  expect(r.code).toBe(0);
  const row = (JSON.parse(r.stdout) as Array<Record<string, any>>).find((x) => x.name === "appweb")!;
  expect(row.hasOrchestrator).toBe(true);
  expect(row.orchestrators.map((o: { id: string }) => o.id)).toEqual([CODEX_SESSION_ID]);
});
