// Coverage for the `agendo` CLI (src/index.tsx subcommands): --help, --llm, list,
// status, send. These don't render the TUI, so they run the entrypoint directly
// as a child process against the same mocked environment (fake az/tmux/git,
// fixture $HOME). The fake tmux serves a stored pane capture for the running
// session, so readiness classification is real — including the compacting state.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { COPILOT_SESSION_ID, CRASH_SESSION_ID, LOGIN_SESSION_ID, RUNNING_TARGET, tmuxState, sessionName } from "./harness/fixtures.ts";

// The short id the CLI prints / accepts (sessionName strips non-alphanumerics).
const shortIdOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
const SHORT_ID = shortIdOf(LOGIN_SESSION_ID);
const CRASH_SHORT_ID = shortIdOf(CRASH_SESSION_ID);
const COP_SHORT_ID = shortIdOf(COPILOT_SESSION_ID);

// A mid-generation TUI: the live token counter is the reliable "busy" signal, so
// `paneReadiness` classifies this as "busy" (not sendable / not settled).
const BUSY_PANE = [
  "  ● Implement login form",
  "  ⠋ Working… (12s · ↑ 2.1k tokens)",
  "  ─────────────────────────────────────────────",
  "  ❯ ",
  "  ─────────────────────────────────────────────",
].join("\n");

function agendo(env: Record<string, string>, ...args: string[]) {
  return agendoIn(REPO_ROOT, env, ...args);
}

/**
 * Like `agendo`, but from an explicit working directory. Needed by the `launch`
 * tests: `launchTask` creates its worktree relative to `process.cwd()`, so
 * running them from REPO_ROOT would have the fake git mkdir a directory inside
 * the developer's REAL repo. Point them at a repo in the mock home instead.
 */
function agendoIn(cwd: string, env: Record<string, string>, ...args: string[]) {
  return spawnSync("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], {
    cwd,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
}

/** Start the CLI without blocking, so a test can mutate fake-tmux state while a
 *  long-running command (e.g. `wait`) polls. Resolves with its exit code + output. */
function agendoAsync(env: Record<string, string>, ...args: string[]) {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], {
    cwd: REPO_ROOT,
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((res) =>
    child.on("close", (code) => res({ code, stdout, stderr })),
  );
  return { child, done };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("agendo --help prints usage under the new name", async ({ mock }) => {
  const r = agendo(mock.env, "--help");
  expect(r.status).toBe(0);
  // Post-rename: the binary is `agendo`, not `claunch`.
  expect(r.stdout).toContain("agendo — manage claude sessions");
  expect(r.stdout).toContain("agendo list, ls");
  expect(r.stdout).toContain("agendo status <id>");
  expect(r.stdout).not.toContain("claunch"); // the old name is fully gone
});

test("agendo --llm prints the background-session guide", async ({ mock }) => {
  const r = agendo(mock.env, "--llm");
  expect(r.status).toBe(0);
  // The guide is the agent-facing workflow text, headed by the new name.
  expect(r.stdout).toContain("agendo — running a separate background claude session");
});

test("agendo list shows the running session with readiness", async ({ mock }) => {
  const r = agendo(mock.env, "list");
  expect(r.status).toBe(0);
  // One running session: ready (idle pane), resumed kind (—), its short id + title.
  expect(r.stdout).toContain("ready");
  expect(r.stdout).toContain(SHORT_ID);
  expect(r.stdout).toContain("Implement login form");
  // …and a relative "last used" age column (the login fixture's mtime is ~now).
  expect(r.stdout).toMatch(/\d+[smhd] ago/);
});

test("agendo status reports running state + recent activity", async ({ mock }) => {
  const r = agendo(mock.env, "status", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("● running");
  expect(r.stdout).toContain("Implement login form");
  expect(r.stdout).toContain("ready"); // readiness line from the pane capture
  expect(r.stdout).toContain("feature/login"); // branch
  // The most recent human prompt + a parsed action from the JSONL log.
  expect(r.stdout).toContain("Add a login form with validation");
});

test("agendo status prints the agent's TodoWrite checklist (latest wins)", async ({ mock }) => {
  const r = agendo(mock.env, "status", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("tasks:");
  // The LATEST TodoWrite is authoritative: the form task is done, validation is
  // in progress, and a third task that only exists in the later list is present —
  // proving we surface the whole latest list, not the superseded earlier one.
  expect(r.stdout).toContain("[x] Write the login form");
  expect(r.stdout).toContain("[~] Add validation");
  expect(r.stdout).toContain("[ ] Wire up the submit handler");
});

test("agendo status prints the FULL untruncated final response", async ({ mock }) => {
  const r = agendo(mock.env, "status", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("final response:");
  expect(r.stdout).toContain("Done — login form added with validation.");
  // The final text is >400 chars; it must not be clipped at the 200-char action
  // truncation (the orchestrator needs the whole thing).
  expect(r.stdout).toContain("x".repeat(400));
});

test("agendo status reconstructs a checklist from Task events when no TodoWrite exists", async ({ mock }) => {
  // The crash session (idle) recorded des-workflow TaskCreate/TaskUpdate calls,
  // not a TodoWrite — the fallback replays them by taskId, last status winning.
  const r = agendo(mock.env, "status", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("tasks:");
  expect(r.stdout).toContain("[x] Reproduce the crash"); // update on ordinal id "1" → completed
  expect(r.stdout).toContain("[~] Patch the null deref"); // update on ordinal id "2", active → in_progress
  // A task deleted via TaskUpdate status:"deleted" must be dropped from the
  // checklist (it still appears in the raw activity log as its TaskCreate line —
  // that's accurate history — so scope the check to checklist rows `[…] label`).
  expect(r.stdout).not.toMatch(/\[.\] Write a regression test/);
});

test("agendo send delivers a prompt to a ready session", async ({ mock }) => {
  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`sent to ${RUNNING_TARGET}`);

  // It went through tmux: a paste buffer for the text, then an Enter to submit.
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(true);
  expect(tmux.some((argv) => argv[0] === "send-keys" && argv.includes("Enter"))).toBe(true);
});

test("agendo send refuses a compacting session unless forced", async ({ mock }) => {
  // Swap the running pane's capture for a mid-compaction TUI: the classifier must
  // read "compacting" (not "ready"), and `send` refuses to inject a prompt into a
  // session that's rewriting its own context — the regression 0369480 guards.
  await mock.setTmuxState({
    ...tmuxState,
    captures: {
      [RUNNING_TARGET]: ["✻ Compacting conversation… (esc to interrupt)", "  ▰▰▰▱▱▱ 42%"].join("\n"),
    },
  });

  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).not.toBe(0); // refused
  expect(r.stderr).toContain("compacting"); // names the state it saw
  // Nothing was injected: no paste-buffer / Enter reached tmux.
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(false);

  // With --force it goes through despite the compacting state.
  const forced = agendo(mock.env, "send", "-f", SHORT_ID, "run the tests");
  expect(forced.status).toBe(0);
  expect(forced.stdout).toContain(`sent to ${RUNNING_TARGET}`);
});

test("agendo list [dir] scopes the listing to sessions under the dir", async ({ mock }) => {
  // Two running managed windows under two different repo roots: the login claude
  // session (appweb) and the experiment copilot session (applib). `agendo list`
  // shows both; `agendo list <root>` shows only the sessions under that root —
  // the CLI mirror of the TUI's path filter (segment-aware, via isUnderRoot).
  const appweb = join(mock.home, "repos", "appweb");
  const applib = join(mock.home, "repos", "applib");
  const loginTarget = sessionName("claude", LOGIN_SESSION_ID); // === RUNNING_TARGET
  const expTarget = sessionName("copilot", COPILOT_SESSION_ID);
  const ready = ["  ─────────────", "  ❯ ", "  ─────────────"].join("\n");
  await mock.setTmuxState({
    sessions: [loginTarget, expTarget],
    windows: [],
    panes: [
      { session: loginTarget, window: loginTarget, cwd: join(appweb, ".claude", "worktrees", "login"), placeholder: false },
      { session: expTarget, window: expTarget, cwd: join(applib, ".claude", "worktrees", "experiment"), placeholder: false },
    ],
    captures: { [loginTarget]: ready, [expTarget]: ready },
  });

  // No dir → both sessions listed.
  const all = agendo(mock.env, "list");
  expect(all.status).toBe(0);
  expect(all.stdout).toContain("Implement login form"); // appweb (claude)
  expect(all.stdout).toContain("Experiment spike"); // applib (copilot)

  // Scoped to appweb → only the login session.
  const inAppweb = agendo(mock.env, "list", appweb);
  expect(inAppweb.status).toBe(0);
  expect(inAppweb.stdout).toContain("Implement login form");
  expect(inAppweb.stdout).not.toContain("Experiment spike");

  // Scoped to applib → only the experiment session.
  const inApplib = agendo(mock.env, "list", applib);
  expect(inApplib.status).toBe(0);
  expect(inApplib.stdout).toContain("Experiment spike");
  expect(inApplib.stdout).not.toContain("Implement login form");
});

// The usage-limit notice a throttled Claude Code pane shows — VERBATIM wording
// captured read-only from a real limited session (⎿ result block, NBSP padding,
// "hit your session limit" + "/usage-credits"), above the still-present input box.
const LIMIT_PANE = [
  "  ⎿  You've hit your session limit · resets 7:20pm (Atlantic/Reykjavik)",
  "     /usage-credits to finish what you’re working on.",
  "  ─────────────────────────────────────────────",
  "  ❯ ",
  "  ─────────────────────────────────────────────",
].join("\n");

test("agendo list/status report a usage-limited session", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });

  const list = agendo(mock.env, "list");
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("limited");

  const status = agendo(mock.env, "status", SHORT_ID);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("limited");
  expect(status.stdout).toContain("usage limit reached");
  expect(status.stdout).toContain("resets at"); // reset time was parsed
});

test("agendo unblock sends <esc>continue<enter> to a limited session", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });

  const r = agendo(mock.env, "unblock", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`unblocked ${RUNNING_TARGET}`);

  // The exact keystroke sequence reached tmux, to the right window: Escape, then
  // the literal word "continue", then Enter.
  const tmux = await mock.tmuxLog();
  const sendKeys = tmux.filter((argv) => argv[0] === "send-keys" && argv.includes(RUNNING_TARGET));
  expect(sendKeys).toContainEqual(["send-keys", "-t", RUNNING_TARGET, "Escape"]);
  expect(sendKeys).toContainEqual(["send-keys", "-t", RUNNING_TARGET, "-l", "continue"]);
  expect(sendKeys).toContainEqual(["send-keys", "-t", RUNNING_TARGET, "Enter"]);
});

test("agendo unblock refuses a session that isn't limited (no clobber)", async ({ mock }) => {
  // Default fixture pane is idle/ready — unblock must decline rather than inject.
  const r = agendo(mock.env, "unblock", SHORT_ID);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("not limited");
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "send-keys" && argv.includes("continue"))).toBe(false);
});

test("agendo status on an unknown id fails cleanly", async ({ mock }) => {
  const r = agendo(mock.env, "status", "no-such-session");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No session found");
});

// NB: the mock ADO server runs in-process, so the model-backed list modes must
// use the async spawn — a blocking spawnSync would freeze the test's event loop
// and the server could never answer the CLI's fetches (deadlock → timeout).
test("agendo list --json emits the running session with its associations", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  // --json (without --all) is still running-only: just the live login session.
  expect(rows).toHaveLength(1);
  const login = rows[0];
  expect(login.shortId).toBe(SHORT_ID);
  expect(login.running).toBe(true);
  expect(login.readiness).toBe("ready");
  expect(login.branch).toBe("feature/login"); // most-recent non-base branch
  // Machine-readable "last used" timestamp (ISO 8601, parseable).
  expect(typeof login.lastUsed).toBe("string");
  expect(Number.isNaN(Date.parse(login.lastUsed))).toBe(false);
  // Resolved through the model's sessionLinks: PR 5001 → work item 101.
  expect(login.pr.id).toBe(5001);
  expect(login.workItem.id).toBe(101);
});

test("agendo list --all includes idle sessions, marked running vs idle", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "--all").done;
  expect(r.code).toBe(0);
  // The live login session (●) plus idle ones (○) like the crash session.
  expect(r.stdout).toContain("●");
  expect(r.stdout).toContain("○");
  expect(r.stdout).toContain(SHORT_ID);
  expect(r.stdout).toContain(CRASH_SHORT_ID);
  // Associations rendered per row: login's PR, the crash session's work item.
  expect(r.stdout).toContain("!5001");
  expect(r.stdout).toContain("#102");
  // Relative "last used" age column present on the rows.
  expect(r.stdout).toMatch(/\d+[smhd] ago/);
});

test("agendo list --pr resolves the session on that PR's branch", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "--pr", "5001", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].shortId).toBe(SHORT_ID);
  expect(rows[0].pr.id).toBe(5001);
});

test("agendo list --work-item resolves the session matched by branch/worktree id", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "--work-item", "102", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  expect(rows).toHaveLength(1);
  expect(rows[0].shortId).toBe(CRASH_SHORT_ID);
  expect(rows[0].workItem.id).toBe(102);
  expect(rows[0].running).toBe(false); // it's idle, but still resolved
});

test("agendo resume headlessly creates the session's resume window (detached)", async ({ mock }) => {
  const r = agendo(mock.env, "resume", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`resumed session ${CRASH_SHORT_ID}`);

  // It spun up a detached tmux session running `claude --resume <id>` in place.
  const tmux = await mock.tmuxLog();
  const newSession = tmux.find(
    (argv) => argv[0] === "new-session" && argv.includes(`cl-claude-${CRASH_SHORT_ID}`),
  );
  expect(newSession).toBeTruthy();
  const joined = newSession!.join(" ");
  expect(joined).toContain("--resume");
  expect(joined).toContain(CRASH_SESSION_ID);
  // No handover: detached resume must not attach/switch the client.
  expect(tmux.some((argv) => argv[0] === "attach-session" || argv[0] === "switch-client")).toBe(false);
});

test("agendo resume targets tmux by EXACT name — a prefix-colliding neighbour isn't mistaken for it (T1)", async ({ mock }) => {
  // A live session whose name is a SUPERSTRING of the crash session's canonical
  // target (`cl-claude-<crash>` ⊂ `cl-claude-<crash>x`). Real tmux resolves a bare
  // `-t cl-claude-<crash>` by exact→unique-prefix→fnmatch, so it would bind to this
  // longer neighbour and report the crash session as already running (skipping the
  // resume, attaching into the wrong pane). The fix pins resolution with a leading
  // `=`, so the crash session is correctly seen as NOT running and resumed on its own.
  const canonical = `cl-claude-${CRASH_SHORT_ID}`;
  await mock.setTmuxState({
    ...tmuxState,
    sessions: [...tmuxState.sessions, `${canonical}x`],
    panes: [
      ...tmuxState.panes,
      { session: `${canonical}x`, window: `${canonical}x`, cwd: "/somewhere/else", placeholder: false },
    ],
  });

  const r = agendo(mock.env, "resume", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  // Not fooled into "already running" by the prefix-colliding neighbour.
  expect(r.stdout).toContain(`resumed session ${CRASH_SHORT_ID}`);
  expect(r.stdout).not.toContain("was already running");

  const tmux = await mock.tmuxLog();
  // It spun up its OWN detached session under the exact canonical name…
  expect(tmux.some((argv) => argv[0] === "new-session" && argv.includes(canonical))).toBe(true);
  // …and every has-session probe used the `=`-exact target form (the fix).
  const probes = tmux.filter((argv) => argv[0] === "has-session");
  expect(probes.length).toBeGreaterThan(0);
  for (const argv of probes) {
    const t = argv[argv.indexOf("-t") + 1];
    expect(t.startsWith("=")).toBe(true);
  }
});

test("agendo wait blocks until a busy session settles, then exits 0", async ({ mock }) => {
  // Start with the login pane mid-generation → "busy", so wait must keep polling.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--interval", "300ms", "--timeout", "20s");
  // Flip the pane to the idle/ready capture; the next poll should settle it.
  await sleep(1500);
  await mock.setTmuxState(tmuxState);

  const r = await done;
  expect(r.code).toBe(0);
  // Machine-friendly final state on stdout; progress went to stderr.
  expect(r.stdout).toContain(SHORT_ID);
  expect(r.stdout).toContain("ready");
});

test("agendo wait exits non-zero when the session stays busy past the timeout", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const r = agendo(mock.env, "wait", SHORT_ID, "--interval", "100ms", "--timeout", "600ms");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("timed out");
});

test("agendo wait errors on an explicit id that isn't running", async ({ mock }) => {
  // The crash session exists on disk but has no live tmux window → can't settle.
  const r = agendo(mock.env, "wait", CRASH_SHORT_ID, "--timeout", "2s");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("not running");
});

test("agendo wait rejects a malformed --timeout and combined --state/--not", async ({ mock }) => {
  const bad = agendo(mock.env, "wait", SHORT_ID, "--timeout", "5min");
  expect(bad.status).not.toBe(0);
  expect(bad.stderr).toContain("needs a duration");

  const both = agendo(mock.env, "wait", SHORT_ID, "--state", "ready", "--not", "dialog");
  expect(both.status).not.toBe(0);
  expect(both.stderr).toContain("only one of");
});

test("agendo resume navigates to a session already running under a cl-wi- window (no duplicate)", async ({ mock }) => {
  // The crash session's worktree cwd, matching the fixture's crashCwd exactly so
  // reconcileLive attributes the id-less cl-wi-102 window back to it by cwd.
  const crashCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "fix-crash-102");
  await mock.setTmuxState({
    ...tmuxState,
    sessions: [...tmuxState.sessions, "cl-wi-102"],
    panes: [
      ...tmuxState.panes,
      { session: "cl-wi-102", window: "cl-wi-102", cwd: crashCwd, placeholder: false },
    ],
  });
  const r = agendo(mock.env, "resume", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("was already running");
  // Must NOT spawn a second agent under the canonical name for the same session.
  const tmux = await mock.tmuxLog();
  expect(
    tmux.some((argv) => argv[0] === "new-session" && argv.includes(`cl-claude-${CRASH_SHORT_ID}`)),
  ).toBe(false);
});

// ── `list pr` / `list issues` resource views ──────────────────────────────────
// These enumerate the backend's own PRs / work items (not local sessions) and
// hang the associated session off each, so an orchestrator can see what's in
// flight and which item it can delegate to. Model-backed → agendoAsync (the
// in-process ADO server would deadlock a blocking spawnSync). Both provider
// vocabs are exercised: ADO here (default fixtures), GitHub below.

test("agendo list pr lists my open PRs (ADO) with the session on each branch", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "pr").done;
  expect(r.code).toBe(0);
  // PR 5001 (linked to WI 101) with ADO's `!` prefix, its branch, and the running
  // login session working it. PR 6001 is my orphan draft.
  expect(r.stdout).toContain("!5001");
  expect(r.stdout).toContain("feature/login");
  expect(r.stdout).toContain(SHORT_ID);
  expect(r.stdout).toContain("Add login screen");
  expect(r.stdout).toContain("!6001");
  expect(r.stdout).toContain("[draft]");
  expect(r.stdout).toContain("●"); // the login session is running
  // Review PRs (Grace's, where I'm only a reviewer) are NOT my PRs → excluded.
  expect(r.stdout).not.toContain("!7001");
  expect(r.stdout).not.toContain("!7002");
});

test("agendo list pr --json carries PR id + associated sessions (ADO)", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "pr", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const byId = new Map(rows.map((p) => [p.id, p]));
  // My two created PRs, no review PRs.
  expect([...byId.keys()].sort((a, b) => a - b)).toEqual([5001, 6001]);
  const login = byId.get(5001);
  expect(login.branch).toBe("feature/login");
  expect(login.sessions[0].shortId).toBe(SHORT_ID);
  expect(login.sessions[0].source).toBe("claude");
  expect(login.sessions[0].running).toBe(true);
  // The orphan draft is flagged and carries its (idle) copilot session.
  const exp = byId.get(6001);
  expect(exp.isDraft).toBe(true);
  expect(exp.sessions[0].shortId).toBe(COP_SHORT_ID);
  expect(exp.sessions[0].running).toBe(false);
});

test("agendo list issues uses ADO's 'work item' vocab and associates sessions", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "issues").done;
  expect(r.code).toBe(0);
  // ADO vocab in the header — not GitHub's "issue" (no fixture title uses it).
  expect(r.stdout).toContain("work item");
  expect(r.stdout).not.toContain("issue");
  // My assigned items across sprints, each with its state.
  expect(r.stdout).toContain("#101");
  expect(r.stdout).toContain("In Progress");
  expect(r.stdout).toContain("#102");
  expect(r.stdout).toContain("#103");
  // WI 101 → running login session; WI 102 → idle crash session.
  expect(r.stdout).toContain(SHORT_ID);
  expect(r.stdout).toContain(CRASH_SHORT_ID);
});

test("agendo list wi is an alias for list issues", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "wi").done;
  expect(r.code).toBe(0);
  expect(r.stdout).toMatch(/\bwork item\b/);
  expect(r.stdout).toContain("#101");
});

test("agendo list issues --json carries item id + associated sessions (ADO)", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "list", "issues", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const byId = new Map(rows.map((i) => [i.id, i]));
  expect(byId.has(101)).toBe(true);
  expect(byId.has(102)).toBe(true);
  expect(byId.has(103)).toBe(true);
  const wi101 = byId.get(101);
  expect(wi101.state).toBe("In Progress");
  expect(wi101.sessions[0].shortId).toBe(SHORT_ID);
  expect(wi101.sessions[0].running).toBe(true);
  expect(byId.get(102).sessions[0].shortId).toBe(CRASH_SHORT_ID);
  expect(byId.get(103).sessions).toEqual([]); // no session on the docs task
});

// GitHub vocab: flip the backend, wire the fake gh with an issue and a PR that
// closes it on the login session's branch, so the association resolves the same
// way it does in the TUI. Repo scope comes from the local sessions' origin slug
// (ada/appweb), matching the login session's repo.
async function seedGitHubList(mock: {
  setProvider: (n: "github") => Promise<void>;
  setGhState: (s: unknown) => Promise<void>;
}) {
  const PR = {
    number: 401,
    title: "Wire up the login screen",
    url: "https://github.com/ada/appweb/pull/401",
    headRefName: "feature/login", // the running login session's branch
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    reviews: [],
    statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }],
    mergeStateStatus: "CLEAN",
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-06-21T10:00:00.000Z",
    author: { login: "ada" },
    closingIssuesReferences: [{ number: 301 }], // links the PR to issue 301
    body: "",
  };
  await mock.setProvider("github");
  await mock.setGhState({
    authed: true,
    user: { login: "ada", name: "Ada Lovelace" },
    issues: {
      "ada/appweb": [
        { number: 301, title: "Header overlaps on mobile", state: "OPEN", url: "https://github.com/ada/appweb/issues/301", labels: [], author: { login: "ada" } },
      ],
    },
    prs: {
      "ada/appweb": {
        "involves:ada": [PR], // linkedIssues scan → files PR 401 under issue 301
        "author:ada": [PR], // fetchActivePRs
        "review-requested:ada": [],
      },
    },
  });
}

test("agendo list pr (GitHub) uses the '#' prefix and the login session on its branch", async ({ mock }) => {
  await seedGitHubList(mock);
  const r = await agendoAsync(mock.env, "list", "pr", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const pr = rows.find((p) => p.id === 401);
  expect(pr).toBeTruthy();
  expect(pr.branch).toBe("feature/login");
  expect(pr.sessions[0].shortId).toBe(SHORT_ID);
  expect(pr.sessions[0].running).toBe(true);

  const table = await agendoAsync(mock.env, "list", "pr").done;
  expect(table.code).toBe(0);
  expect(table.stdout).toContain("#401"); // GitHub's `#` PR prefix (ADO uses `!`)
  expect(table.stdout).toContain(SHORT_ID);
});

test("agendo list issues (GitHub) uses 'issue' vocab and associates the session", async ({ mock }) => {
  await seedGitHubList(mock);
  const r = await agendoAsync(mock.env, "list", "issues").done;
  expect(r.code).toBe(0);
  // GitHub vocab — the header says "issue", never ADO's "work item".
  expect(r.stdout).toMatch(/\bissue\b/);
  expect(r.stdout).not.toMatch(/\bwork item\b/);
  expect(r.stdout).toContain("#301");
  expect(r.stdout).toContain("Header overlaps on mobile");
  // Issue 301's closing PR is on the running login session's branch → associated.
  expect(r.stdout).toContain(SHORT_ID);

  const json = await agendoAsync(mock.env, "list", "issues", "--json").done;
  const rows = JSON.parse(json.stdout) as any[];
  const iss = rows.find((i) => i.id === 301);
  expect(iss).toBeTruthy();
  expect(iss.sessions[0].shortId).toBe(SHORT_ID);
  expect(iss.sessions[0].running).toBe(true);
});

test("agendo list rejects unknown sub-flags; a non-keyword positional is a dir filter", async ({ mock }) => {
  // `pr`/`issues`/`wi` route to the resource views; any other non-dash positional
  // falls through to the session list's `[dir]` path filter (path-scoped launchers),
  // so `list <dir>` must succeed (empty when nothing runs under it), not error.
  const dir = agendo(mock.env, "list", "no-such-dir");
  expect(dir.status).toBe(0);

  const badFlag = agendo(mock.env, "list", "pr", "--nope");
  expect(badFlag.status).not.toBe(0);
  expect(badFlag.stderr).toContain('unknown argument "--nope"');
});

// ── orchestrator mode (`launch --orchestrator`) ────────────────────────────────
// Orchestrator mode is delivered as text appended to the session's system prompt,
// so "is it wired up?" is answerable only by reading the argv the launcher spawned.
// These drive the real CLI against the fake tmux/git and assert on that argv.

/** The single `--append-system-prompt` value from a spawned claude argv. */
function appendedPrompt(argv: string[]): string {
  const flags = argv.filter((a) => a === "--append-system-prompt");
  // Exactly one occurrence matters: claude's flag takes ONE value, so a second
  // one would silently discard the first — the launcher prompt or the orchestrator
  // instructions would vanish with no error anywhere.
  expect(flags).toHaveLength(1);
  return argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
}

/**
 * The `git` invocations from the shared call log, as parsed argv arrays. The fake
 * git logs each call as `git <JSON argv>` (e2e/fakebin/git), so this decodes back
 * to exact arguments — letting a test distinguish `worktree-orchestrator` from
 * `worktree-orchestrator-2`, which a substring check cannot.
 */
function gitArgv(callLog: string[]): string[][] {
  return callLog
    .filter((l) => l.startsWith("git "))
    .map((l) => {
      try {
        return JSON.parse(l.slice("git ".length)) as string[];
      } catch {
        return [];
      }
    });
}

/**
 * A repo inside the mock home — safe for the fake git to mkdir a worktree in.
 * `standalone` is the fixture repo that actually exists on disk (with a `.git`),
 * so `repoRootForCwd` resolves it to itself and the worktree lands under the
 * throwaway home rather than anywhere real.
 */
const mockRepo = (home: string) => join(home, "repos", "standalone");

test("agendo --help and --llm document orchestrator mode", async ({ mock }) => {
  const help = agendo(mock.env, "--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--orchestrator, -O");
  expect(help.stdout).toContain("ORCHESTRATOR MODE");

  // The on-demand agent-facing guide advertises it too, so an agent asked to
  // "orchestrate this" finds the flag without the human naming it.
  const llm = agendo(mock.env, "--llm");
  expect(llm.status).toBe(0);
  expect(llm.stdout).toContain("launch --orchestrator");
});

test("agendo launch --orchestrator injects the orchestrator instructions into the spawned claude", async ({ mock }) => {
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "Build the reporting module");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("launched orchestrator session");
  const id = r.stdout.match(/launched orchestrator session (\S+)/)?.[1];
  expect(id).toBeTruthy();

  // It went out as a detached tmux session running claude.
  const tmux = await mock.tmuxLog();
  const spawned = tmux.find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  expect(spawned).toBeTruthy();

  const appended = appendedPrompt(spawned!);
  // Both prompts share the one value: the launcher's background-session pointer…
  expect(appended).toContain("You are running inside agendo");
  // …and the orchestrator instructions, with the directives that define the mode.
  expect(appended).toContain("ORCHESTRATOR MODE");
  expect(appended).toContain("Never write project code yourself");
  expect(appended).toContain("launch --name <slug>");
  expect(appended).toContain("have a SUB-AGENT review your change");
  expect(appended).toContain("do not open a pull request");
  // The goal is still the session's opening prompt.
  expect(spawned!).toContain("Build the reporting module");
  // Autonomy flags still apply — an orchestrator must not stall on approvals.
  expect(spawned!.join(" ")).toContain("--permission-mode");

  // It runs in the repo's MAIN checkout, NOT a worktree: it squash-merges into the
  // main branch, and git allows that branch in one working tree only. A worktree
  // would hand it an empty branch it never commits to and force every merge to
  // reach out to the repo root.
  expect(r.stdout).toContain(`(in ${mockRepo(mock.home)})`);
  const gitCalls = gitArgv(await mock.callLog());
  expect(gitCalls.some((a) => a.includes("worktree"))).toBe(false);

  // The launch is remembered, so a later cold resume can re-inject (see below).
  const marker = JSON.parse(await readFile(join(mock.home, ".agendo", "orchestrators.json"), "utf-8"));
  expect(marker.ids).toContain(id);
});

test("an orchestrator launched from a subdirectory still runs at the repo root", async ({ mock }) => {
  // "Merge right where you are" is only true if it starts in the primary checkout,
  // so a launch from a subdirectory (or from inside another worktree) must still
  // land at the root rather than wherever the human happened to be standing.
  const repo = mockRepo(mock.home);
  const sub = join(repo, "packages", "api");
  await mkdir(sub, { recursive: true });
  const r = agendoIn(sub, mock.env, "launch", "--orchestrator", "Coordinate the rewrite");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`(in ${repo})`);
  expect(r.stdout).not.toContain(`(in ${sub})`);
});

test("--orchestrator --worktree opts into isolation, and a second one gets its OWN worktree", async ({ mock }) => {
  // Worktree isolation is now opt-in for orchestrators. When taken, the role-named
  // slug is identical for every unnamed one, and `createWorktree` treats an
  // existing path as success — so without stepping past it the second would run in
  // the first one's checkout on its branch.
  const repo = mockRepo(mock.home);
  const first = agendoIn(repo, mock.env, "launch", "--orchestrator", "--worktree", "Goal A");
  expect(first.status).toBe(0);
  const second = agendoIn(repo, mock.env, "launch", "--orchestrator", "--worktree", "Goal B");
  expect(second.status).toBe(0);

  // Distinct worktree directories…
  const dirs = [first, second].map((r) => r.stdout.match(/\(in (.+?)\)/)?.[1]);
  expect(dirs[0]).toBeTruthy();
  expect(dirs[1]).toBeTruthy();
  expect(dirs[0]).not.toBe(dirs[1]);
  // …from distinct branches: the base slug, then the -2 suffix. Compared as parsed
  // argv entries rather than substrings, since "worktree-orchestrator" is itself a
  // prefix of "worktree-orchestrator-2".
  const branches = new Set(gitArgv(await mock.callLog()).flat());
  expect(branches.has("worktree-orchestrator")).toBe(true);
  expect(branches.has("worktree-orchestrator-2")).toBe(true);
});

test("agendo launch --name overrides the orchestrator's default slug", async ({ mock }) => {
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "--worktree", "--name", "rollout", "Ship it");
  expect(r.status).toBe(0);
  const args = gitArgv(await mock.callLog()).flat();
  expect(args).toContain("worktree-rollout");
  expect(args).not.toContain("worktree-orchestrator");
});

test("a plain agendo launch carries NO orchestrator instructions", async ({ mock }) => {
  // Guards the inverse: orchestrator mode must be opt-in, never leaking into the
  // ordinary background-session launch every agent already uses.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "Fix the header");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("launched background session");
  expect(r.stdout).not.toContain("orchestrator");

  const tmux = await mock.tmuxLog();
  const spawned = tmux.find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  const appended = appendedPrompt(spawned!);
  expect(appended).toContain("You are running inside agendo"); // launcher prompt still there
  expect(appended).not.toContain("ORCHESTRATOR MODE");
});

test("agendo launch --orchestrator --copilot is refused, not silently downgraded", async ({ mock }) => {
  // Copilot has no --append-system-prompt equivalent, so a Copilot "orchestrator"
  // would run with none of the instructions. Fail loudly instead.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "--copilot", "Coordinate this");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("--orchestrator is Claude-only");
  // Nothing was spawned.
  expect((await mock.tmuxLog()).some((argv) => argv[0] === "new-session" && argv.includes("copilot"))).toBe(false);
});

// ── the global orchestrator (`launch --global-orchestrator`) ──────────────────
// A second, distinct level: its own prompt, its own marker role, no worktree, and
// a layout that prefers a split pane beside the menu. The e2e env is deliberately
// outside tmux, so these cover the CLI contract and the outside-tmux fallback;
// the split itself is exercised in the inside-tmux test below.

test("agendo launch --global-orchestrator injects the GLOBAL instructions, not the repo ones", async ({ mock }) => {
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--global-orchestrator", "Ship the platform");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("launched global orchestrator session");
  const id = r.stdout.match(/launched global orchestrator session (\S+)/)?.[1];
  expect(id).toBeTruthy();

  const spawned = (await mock.tmuxLog()).find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  expect(spawned).toBeTruthy();
  const appended = appendedPrompt(spawned!);
  expect(appended).toContain("You are running inside agendo"); // launcher prompt still shares the value
  expect(appended).toContain("GLOBAL ORCHESTRATOR MODE");
  expect(appended).toContain("NO MERGES");
  expect(appended).toContain("NEVER `send` to an individual worktree session");
  // Emphatically NOT the repo-level prompt: that one tells it to squash-merge.
  expect(appended).not.toContain("# You are running in ORCHESTRATOR MODE");
  expect(appended).not.toContain("squash-merge that branch into the main branch");
  expect(spawned!).toContain("Ship the platform");
  expect(spawned!.join(" ")).toContain("--permission-mode");

  // No repository is involved, so no worktree is created — for a global one that
  // isn't a preference, there is simply no repo to make one in.
  expect(gitArgv(await mock.callLog()).some((a) => a.includes("worktree"))).toBe(false);

  // The marker records the LEVEL, not just "is an orchestrator", and keeps the
  // historical flat `ids` array so an older agendo still finds it.
  const marker = JSON.parse(await readFile(join(mock.home, ".agendo", "orchestrators.json"), "utf-8"));
  expect(marker.ids).toContain(id);
  expect(marker.roles[id!]).toBe("global");
});

test("--orchestrator --global is the same thing as --global-orchestrator", async ({ mock }) => {
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "--global", "Coordinate everything");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("launched global orchestrator session");
  const spawned = (await mock.tmuxLog()).find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  expect(appendedPrompt(spawned!)).toContain("GLOBAL ORCHESTRATOR MODE");
});

test("a global orchestrator does not sit inside a repo", async ({ mock }) => {
  // Its cwd is a vantage point, and `process.cwd()` is wherever the human stood —
  // usually one repo, which is exactly the impression a coordinator of ALL repos
  // must not give (and the invitation to run git there its prompt forbids).
  const repo = mockRepo(mock.home);
  const r = agendoIn(repo, mock.env, "launch", "--global-orchestrator", "Coordinate everything");
  expect(r.status).toBe(0);
  const cwd = r.stdout.match(/\(in (.+?)\)/)?.[1];
  expect(cwd).toBeTruthy();
  expect(cwd).not.toBe(repo);
  // It sits above the repos the launcher knows, which all live under the mock home.
  expect(repo.startsWith(cwd!)).toBe(true);
});

test("the global orchestrator reports where it opened, and falls back outside tmux", async ({ mock }) => {
  // The harness runs outside tmux, so there is no launcher pane to split — the
  // fallback must still produce a session AND say why it isn't beside the menu,
  // or "it didn't appear next to agendo" reads as a bug.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--global-orchestrator", "Coordinate everything");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("layout:");
  expect(r.stdout).toContain("its own tmux session");
  expect(r.stdout).toContain("not inside tmux");
});

test("the global orchestrator splits the launcher window when there's room", async ({ mock }) => {
  // Inside tmux, with a live agendo menu and a wide enough window, the default
  // layout is a pane beside it. Faked via TMUX + the fake tmux's window width.
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [{ session: "agendo", index: 0, name: "launcher" }],
    panes: [{ session: "agendo", window: "launcher", cwd: mock.home, id: "%1" }],
    captures: {},
    currentSession: "agendo",
    windowWidth: 220,
  });
  const env = { ...mock.env, TMUX: "/tmp/fake-tmux,1,0" };
  const r = agendoIn(mockRepo(mock.home), env, "launch", "--global-orchestrator", "Coordinate everything");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("split pane beside the agendo TUI");

  const tmux = await mock.tmuxLog();
  const split = tmux.find((argv) => argv[0] === "split-window");
  expect(split).toBeTruthy();
  expect(split!).toContain("-h"); // side by side, not stacked
  expect(split!).toContain("claude");
  // The pane is stamped with its managed name, or nothing could ever find it
  // again: it lives in the launcher's window, which keeps its own name.
  const stamp = tmux.find((argv) => argv[0] === "set-option" && argv.includes("@cl_pane_target"));
  expect(stamp).toBeTruthy();
  expect(stamp!.some((a) => a.startsWith("cl-bg-"))).toBe(true);
  // No window was created for it — the whole point of the split.
  expect(tmux.some((argv) => argv[0] === "new-window" && argv.includes("claude"))).toBe(false);
});

test("a narrow terminal gets a window instead of an unusable split", async ({ mock }) => {
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [{ session: "agendo", index: 0, name: "launcher" }],
    panes: [{ session: "agendo", window: "launcher", cwd: mock.home, id: "%1" }],
    captures: {},
    currentSession: "agendo",
    windowWidth: 90,
  });
  const env = { ...mock.env, TMUX: "/tmp/fake-tmux,1,0" };
  const r = agendoIn(mockRepo(mock.home), env, "launch", "--global-orchestrator", "Coordinate everything");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("its own tmux window");
  expect(r.stdout).toContain("90 cols");
  expect((await mock.tmuxLog()).some((argv) => argv[0] === "split-window")).toBe(false);
});

test("--window opts out of the split even on a wide terminal", async ({ mock }) => {
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [{ session: "agendo", index: 0, name: "launcher" }],
    panes: [{ session: "agendo", window: "launcher", cwd: mock.home, id: "%1" }],
    captures: {},
    currentSession: "agendo",
    windowWidth: 220,
  });
  const env = { ...mock.env, TMUX: "/tmp/fake-tmux,1,0" };
  const r = agendoIn(mockRepo(mock.home), env, "launch", "--global-orchestrator", "--window", "Coordinate everything");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("its own tmux window");
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "split-window")).toBe(false);
  expect(tmux.some((argv) => argv[0] === "new-window" && argv.includes("claude"))).toBe(true);
});

test("the worktree and layout flags are rejected where they don't apply", async ({ mock }) => {
  // Silently ignoring them would leave the caller believing they got isolation
  // (or a layout) they asked for twice.
  const wt = agendoIn(mockRepo(mock.home), mock.env, "launch", "--global-orchestrator", "--worktree", "x");
  expect(wt.status).not.toBe(0);
  expect(wt.stderr).toContain("tied to no repo");

  const layout = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "--window", "x");
  expect(layout.status).not.toBe(0);
  expect(layout.stderr).toContain("only apply to --global-orchestrator");

  expect((await mock.tmuxLog()).some((argv) => argv[0] === "new-session" && argv.includes("claude"))).toBe(false);
});

test("agendo launch --global-orchestrator --copilot is refused too", async ({ mock }) => {
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--global-orchestrator", "--copilot", "Coordinate");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("--orchestrator is Claude-only");
});

test("a global orchestrator resumes as a GLOBAL one, not a repo one", async ({ mock }) => {
  // The role is the whole reason the marker file grew past a flat id list: a
  // global orchestrator resumed with the repo prompt would start squash-merging.
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(
    join(mock.home, ".agendo", "orchestrators.json"),
    JSON.stringify({ ids: [CRASH_SESSION_ID], roles: { [CRASH_SESSION_ID]: "global" } }),
  );
  const r = agendo(mock.env, "resume", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  const resumed = (await mock.tmuxLog()).find(
    (argv) => argv[0] === "new-session" && argv.includes(`cl-claude-${CRASH_SHORT_ID}`),
  );
  const appended = appendedPrompt(resumed!);
  expect(appended).toContain("GLOBAL ORCHESTRATOR MODE");
  expect(appended).not.toContain("# You are running in ORCHESTRATOR MODE");
});

test("a marker file written before roles existed still resumes as a repo orchestrator", async ({ mock }) => {
  // Back-compat: an existing install's `{ids:[…]}` has no `roles` key at all, and
  // every orchestrator it recorded predates the global level — so it is a repo one.
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(
    join(mock.home, ".agendo", "orchestrators.json"),
    JSON.stringify({ ids: [CRASH_SESSION_ID] }),
  );
  const r = agendo(mock.env, "resume", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  const resumed = (await mock.tmuxLog()).find(
    (argv) => argv[0] === "new-session" && argv.includes(`cl-claude-${CRASH_SHORT_ID}`),
  );
  const appended = appendedPrompt(resumed!);
  expect(appended).toContain("# You are running in ORCHESTRATOR MODE");
  expect(appended).not.toContain("GLOBAL ORCHESTRATOR MODE");
});

test("marking a new orchestrator preserves the ids an older agendo wrote", async ({ mock }) => {
  // The read-modify-write must not drop pre-existing markers, or upgrading agendo
  // would silently strip the framing from every orchestrator already running.
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(
    join(mock.home, ".agendo", "orchestrators.json"),
    JSON.stringify({ ids: ["legacy-orchestrator-id"] }),
  );
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--global-orchestrator", "Coordinate");
  expect(r.status).toBe(0);
  const marker = JSON.parse(await readFile(join(mock.home, ".agendo", "orchestrators.json"), "utf-8"));
  expect(marker.ids).toContain("legacy-orchestrator-id");
  // …and the legacy id gains no role entry, so it keeps reading back as "repo".
  expect(marker.roles["legacy-orchestrator-id"]).toBeUndefined();
});

test("orchestrator mode survives a cold resume; an ordinary session isn't given it", async ({ mock }) => {
  // claude records neither --append-system-prompt nor --agent in its session state,
  // so resume must re-inject from the launcher's own marker file. Mark the (idle)
  // crash session as an orchestrator, then resume it and read the spawned argv.
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(
    join(mock.home, ".agendo", "orchestrators.json"),
    JSON.stringify({ ids: [CRASH_SESSION_ID] }),
  );

  const r = agendo(mock.env, "resume", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  const resumed = (await mock.tmuxLog()).find(
    (argv) => argv[0] === "new-session" && argv.includes(`cl-claude-${CRASH_SHORT_ID}`),
  );
  expect(resumed).toBeTruthy();
  expect(appendedPrompt(resumed!)).toContain("ORCHESTRATOR MODE");

  // The login session is NOT in the marker file, so its resume stays a plain one.
  // (It's live under RUNNING_TARGET, so kill that first or resume just navigates.)
  await mock.setTmuxState({ sessions: [], windows: [], panes: [], captures: {} });
  const plain = agendo(mock.env, "resume", SHORT_ID);
  expect(plain.status).toBe(0);
  const other = (await mock.tmuxLog()).find(
    (argv) => argv[0] === "new-session" && argv.includes(`cl-claude-${SHORT_ID}`),
  );
  expect(other).toBeTruthy();
  expect(appendedPrompt(other!)).not.toContain("ORCHESTRATOR MODE");
});
