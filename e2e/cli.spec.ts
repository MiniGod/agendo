// Coverage for the `agendo` CLI (src/index.tsx subcommands): --help, --llm, list,
// status, send. These don't render the TUI, so they run the entrypoint directly
// as a child process against the same mocked environment (fake az/tmux/git,
// fixture $HOME). The fake tmux serves a stored pane capture for the running
// session, so readiness classification is real — including the compacting state.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { LOGIN_SESSION_ID, COPILOT_SESSION_ID, CRASH_SESSION_ID, RUNNING_TARGET, tmuxState, sessionName } from "./harness/fixtures.ts";

// The short id the CLI prints / accepts (sessionName strips non-alphanumerics).
const SHORT_ID = LOGIN_SESSION_ID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
const CRASH_SHORT_ID = CRASH_SESSION_ID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);

function agendo(env: Record<string, string>, ...args: string[]) {
  return spawnSync("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });
}

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

test("agendo status on an unknown id fails cleanly", async ({ mock }) => {
  const r = agendo(mock.env, "status", "no-such-session");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No session found");
});
