// Coverage for the `agendo` CLI (src/index.tsx subcommands): --help, --llm, list,
// status, send. These don't render the TUI, so they run the entrypoint directly
// as a child process against the same mocked environment (fake az/tmux/git,
// fixture $HOME). The fake tmux serves a stored pane capture for the running
// session, so readiness classification is real — including the compacting state.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripAnsi } from "../src/tmux.ts";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { BUSY_PANE, COMPACTING_PANE, COPILOT_SESSION_ID, CRASH_SESSION_ID, LOGIN_SESSION_ID, RUNNING_TARGET, STANDALONE_SESSION_ID, tmuxState, sessionName } from "./harness/fixtures.ts";
import { stripAnsi as stripAnsiText } from "../src/tmux.ts";

// The short id the CLI prints / accepts (sessionName strips non-alphanumerics).
const shortIdOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
const SHORT_ID = shortIdOf(LOGIN_SESSION_ID);
const CRASH_SHORT_ID = shortIdOf(CRASH_SESSION_ID);
const COP_SHORT_ID = shortIdOf(COPILOT_SESSION_ID);
// The standalone fixture session is on `main` in a plain checkout — no PR and no
// work item resolve onto it, so it's the "nothing linked" case.
const STANDALONE_SHORT_ID = shortIdOf(STANDALONE_SESSION_ID);

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

/**
 * Resolve once the child's stderr matches — so a test can synchronise on what the
 * process has ACTUALLY observed rather than on a sleep guessed to be longer than
 * its startup.
 *
 * `wait` prints one `pending: <id>=<state>` line per unsettled poll, which makes
 * its polls externally observable. A fixed head start instead makes the test mean
 * different things on different machines: whether the first poll saw the session
 * alive decides how many polls the run needs, and a slower boot silently shifts
 * that — turning a correct wait into a red build. Syncing here also lands the
 * test's state change in the child's sleep between polls rather than inside a
 * poll's multi-command tmux read, where it could tear.
 *
 * Pass a non-global regex: the whole accumulated buffer is re-tested per chunk
 * (so a match split across chunks still lands), and `/g` would carry `lastIndex`
 * between those tests.
 */
function whenStderrMatches(child: ReturnType<typeof spawn>, re: RegExp, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stderr!.off("data", onData);
      child.off("close", onClose);
    };
    const fail = (why: string) => {
      cleanup();
      // Don't leave a `wait` polling for its full timeout behind a failed sync —
      // with retries that would stack several orphans against the same fixture.
      child.kill();
      reject(new Error(`${why}; stderr so far: ${stripAnsiText(seen) || "(empty)"}`));
    };
    const timer = setTimeout(() => fail(`stderr never matched ${re} within ${timeoutMs}ms`), timeoutMs);
    const onData = (d: Buffer) => {
      seen += d.toString();
      if (!re.test(stripAnsiText(seen))) return;
      cleanup();
      resolve();
    };
    // Exiting without ever matching is a setup failure (an unknown id, nothing
    // running). Report THAT rather than idling out the timeout above and blaming
    // the sync for a process that was never going to print the line.
    const onClose = () => fail(`process exited before stderr matched ${re}`);
    child.stderr!.on("data", onData);
    child.on("close", onClose);
  });
}

/** The `pending: <id>=<state>` states `wait` reported, in order — its polls, as
 *  the process itself saw them. */
function pendingStates(stderr: string): string[] {
  return [...stripAnsiText(stderr).matchAll(/pending: \w+=(\w+)/g)].map((m) => m[1]);
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
  // `wait` MUST be advertised here, not just in --help. This guide is the only
  // command list an agent is pointed at, so a verb missing from it effectively
  // does not exist — which is why orchestrators re-polled `status` on a guessed
  // cadence instead of being notified.
  //
  // Match only text that is INDEPENDENT of SELF_CMD. Every invocation line is
  // prefixed with however this launcher can re-invoke itself, which varies by
  // environment: `agendo` when it's on PATH, `bunx agendo` under a package
  // runner, and a bare `<bun> <abs path to index.tsx>` in CI. Asserting on
  // "agendo wait" passes locally and fails on a runner for reasons that have
  // nothing to do with the guide.
  expect(r.stdout).toContain(" wait <id...> --any --json --timeout 30m");
  // …and that it actually teaches the workflow, not just that the verb exists:
  // run it in the background, don't re-poll, and here's what each flag buys.
  expect(r.stdout).toContain("Be told when it needs you (DON'T poll)");
  expect(r.stdout).toContain("treat its exit as the");
  expect(r.stdout).toContain("--any wakes on the first of several sessions to settle");
  expect(r.stdout).toContain("--json prints what you woke up to find out");
  expect(r.stdout).toContain("--state limited");
  // Same argument for the stall qualifier: an orchestrator reads THIS, never the
  // README, so a signal only documented there is one it will never look for. It
  // must also carry the caveat — a flag an agent trusts as "finished" is worse
  // than no flag at all.
  expect(r.stdout).toContain("--stalled-after");
  expect(r.stdout).toContain("idleSeconds");
  expect(r.stdout).toContain("agendo cannot tell finished");
  // `close` for the same reason: an agent that can't see the verb here reaches for
  // a raw `tmux kill-window` (bare-targeted, and fnmatch-prone) instead — which is
  // exactly what this command exists to replace. Same SELF_CMD-independent match.
  expect(r.stdout).toContain(" close <id>");
  expect(r.stdout).toContain("never hand-roll a kill");
  // …and that closing is advertised as SAFE, since an agent that doubts the
  // worktree survives won't use it.
  expect(r.stdout).toContain("commits are guaranteed untouched on disk");
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

test("agendo status surfaces a running Workflow run with agent progress + phases", async ({ mock }) => {
  // The login session launched workflow wf_login01 and never got a completion
  // notification; the session is live, so the run reports as running. Progress
  // comes from its journal (2 started / 1 result), phases + models from the
  // persisted script meta and the per-agent meta files.
  const r = agendo(mock.env, "status", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("workflows:");
  expect(r.stdout).toContain("[~] login-hardening — running · 1/2 agents done");
  expect(r.stdout).toContain("Harden the login flow end-to-end"); // launch summary
  expect(r.stdout).toContain("phases: Research (sonnet) → Develop (opus)");
  expect(r.stdout).toContain("agents: opus, sonnet"); // per-agent meta tally (alphabetical)
  expect(r.stdout).toContain("run: wf_login01");
});

test("agendo status shows a notified workflow as completed on an idle session", async ({ mock }) => {
  // The crash session's workflow got a <task-notification> with status
  // completed — authoritative even though the session itself is idle (without
  // it, an idle session would downgrade the run to "interrupted"). Its script
  // file doesn't exist, so detail degrades gracefully (no phases line).
  const r = agendo(mock.env, "status", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("[x] crash-triage — completed · 1/1 agents done");
  expect(r.stdout).toContain("Triage the startup crash across subsystems");
  expect(r.stdout).not.toContain("phases:");
  // The injected notification is NOT a human prompt — the real last prompt wins.
  expect(r.stdout).toContain("last prompt: App crashes on startup");
  expect(r.stdout).not.toContain("last prompt: <task-notification>");
});

test("agendo list carries workflow state (◆ marker + --json rows)", async ({ mock }) => {
  // Plain list: the running login session shows the running-workflow marker.
  const plain = agendo(mock.env, "list");
  expect(plain.status).toBe(0);
  expect(plain.stdout).toContain("◆1");
  // JSON (--all): both sessions expose their workflow refs with effective status.
  const r = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const login = rows.find((x) => x.shortId === SHORT_ID);
  expect(login.workflows).toEqual([
    { runId: "wf_login01", name: "login-hardening", status: "running", summary: "Harden the login flow end-to-end" },
  ]);
  const crash = rows.find((x) => x.shortId === CRASH_SHORT_ID);
  expect(crash.workflows).toEqual([
    { runId: "wf_crash01", name: "crash-triage", status: "completed", summary: "Triage the startup crash across subsystems" },
  ]);
  // A session that launched nothing reports an empty array, not undefined.
  const cop = rows.find((x) => x.shortId === COP_SHORT_ID);
  expect(cop.workflows).toEqual([]);
});

test("agendo send delivers a prompt to a ready session", async ({ mock }) => {
  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);

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
  expect(forced.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
});

/**
 * Stand up what a live claude session exposes: a real unix socket, plus the
 * `~/.claude/sessions/<pid>.json` registry entry that advertises it. The pid is
 * THIS process's so peer.ts's liveness probe passes. Returns the frames the
 * socket received and a closer.
 *
 * NB these tests must use `agendoAsync`, not `agendo`: the server runs
 * in-process, and a blocking spawnSync would freeze the event loop so the
 * connection is never accepted (same hazard as the mock ADO server).
 */
async function fakePeer(
  mock: { tmpDir: string; home: string },
  name: string,
  status: string,
  sessionId: string = LOGIN_SESSION_ID,
  over: Record<string, unknown> = {},
  configDir = ".claude",
) {
  const sockPath = join(mock.tmpDir, `${name}.sock`);
  const frames: string[] = [];
  const server = createServer((c) => c.on("data", (d) => frames.push(d.toString())));
  await new Promise<void>((r) => server.listen(sockPath, r));
  await mkdir(join(mock.home, configDir, "sessions"), { recursive: true });
  await writeFile(
    join(mock.home, configDir, "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd: "/run/login",
      peerProtocol: 1,
      kind: "interactive",
      messagingSocketPath: sockPath,
      status,
      ...over,
    }),
  );
  return { frames, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** The frame text the peer has received so far — polled, since the parent's
 *  socket read races the child's exit. */
const framesOf = (peer: { frames: string[] }) => () => peer.frames.join("");

test("agendo send prefers the session's messaging socket over the tmux pane", async ({ mock }) => {
  const peer = await fakePeer(mock, "peer", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("queued via socket");

    // Exactly the documented injection frame, addressed by session id so the
    // receiver can drop it if this pid ever gets recycled.
    await expect.poll(framesOf(peer)).toBe(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "run the tests" },
        session_id: LOGIN_SESSION_ID,
      }) + "\n",
    );

    // …and nothing was typed into the pane.
    const tmux = await mock.tmuxLog();
    expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(false);
  } finally {
    await peer.close();
  }
});

test("agendo send over the socket queues into a busy session instead of refusing", async ({ mock }) => {
  // The pane-paste path must refuse a compacting session (it would clobber the
  // screen). The socket path has no such hazard — the receiver queues the frame
  // and reads it when the turn ends — so it goes through and says so.
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: ["✻ Compacting conversation… (esc to interrupt)", "  ▰▰▰▱▱▱ 42%"].join("\n") },
  });
  const peer = await fakePeer(mock, "peer-busy", "busy");
  try {
    const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0); // NOT refused, unlike the paste path
    expect(r.stdout).toContain("compacting"); // but it reports what it walked into
    await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');
  } finally {
    await peer.close();
  }
});

test("agendo send reaches a session that has a socket but NO tmux window", async ({ mock }) => {
  // A session running outside agendo (plain terminal, editor) has no `cl-…`
  // window. `status` reports it as ◆ running and tells you to `send` to it, so
  // send must not require a window it can never have. The standalone fixture
  // session is idle in tmux terms; give it a socket and it becomes reachable.
  const peer = await fakePeer(mock, "peer-windowless", "idle", STANDALONE_SESSION_ID);
  try {
    const r = await agendoAsync(mock.env, "send", shortIdOf(STANDALONE_SESSION_ID), "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("queued via socket");
    await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');
    // Nothing was typed anywhere — there is no pane for this session.
    const tmux = await mock.tmuxLog();
    expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(false);
  } finally {
    await peer.close();
  }
});

// ── which route did it take? ─────────────────────────────────────────────────
// The two routes are not interchangeable — the socket queues into a session that
// may be mid-turn, the pane types into one that had to be idle — and nothing
// about the session afterwards tells them apart. So `send` names the route it
// took, on both outputs, always. These pin the machine-readable half: a caller
// that keys on `route`/`queued` is relying on them being present and correct on
// every outcome, refusals included.

/** The `--json` payload, with stdout proven to be JSON and nothing else. */
function sendJson(stdout: string): Record<string, unknown> {
  expect(stdout.trimStart().startsWith("{")).toBe(true); // no ▸ progress lines leaked in
  return JSON.parse(stdout);
}

test("agendo send --json reports the socket route it took", async ({ mock }) => {
  const peer = await fakePeer(mock, "peer-json-socket", "busy");
  try {
    const r = await agendoAsync(mock.env, "send", "--json", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    const o = sendJson(r.stdout);
    expect(o.ok).toBe(true);
    expect(o.route).toBe("socket");
    // The load-bearing distinction: this message is in a QUEUE, not on screen.
    expect(o.queued).toBe(true);
    expect(o.sessionId).toBe(LOGIN_SESSION_ID);
    expect(o.pid).toBe(process.pid);
    expect(o.socket).toEqual({ enabled: true, disabledBy: null });
    await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');
  } finally {
    await peer.close();
  }
});

test("agendo send --json reports the pane route it took", async ({ mock }) => {
  // No peer at all, so the same command means something different: the text is on
  // screen now, and the pane had to be ready to accept it.
  const r = await agendoAsync(mock.env, "send", "--json", SHORT_ID, "run the tests").done;
  expect(r.code).toBe(0);
  const o = sendJson(r.stdout);
  expect(o.ok).toBe(true);
  expect(o.route).toBe("pane");
  expect(o.queued).toBe(false);
  expect(o.target).toBe(RUNNING_TARGET);
  expect(o.sessionId).toBe(null); // nothing resolved a peer
});

test("agendo send --json carries a route of null and a reason when it refuses", async ({ mock }) => {
  // A refusal is exactly when a caller most needs to know what happened, and
  // `route: null` is the unambiguous "delivered by neither" — distinct from a
  // pane send that merely printed something to stderr on the way.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  const peer = await fakePeer(mock, "peer-json-refused", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", "--json", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(2);
    const o = sendJson(r.stdout);
    expect(o.ok).toBe(false);
    expect(o.route).toBe(null);
    expect(o.queued).toBe(false);
    expect(o.reason).toBe("limited");
    expect(peer.frames).toEqual([]);
  } finally {
    await peer.close();
  }
});

// ── the kill switch ──────────────────────────────────────────────────────────
// The socket rides an internal, undocumented claude protocol. `peerProtocol`
// gates on the version claude advertises and an unusable socket falls back to
// the pane, but neither catches the failure that would matter: a build that
// still advertises version 1 and still ACCEPTS the frame, having changed what it
// does with it. So there is a switch a human can throw immediately — durably in
// config.json, or per-invocation via the environment.
//
// Off has to mean off: not "discover the peer and then decline to use it", but
// no discovery and no write at all, since a resolved peer changes the outcome by
// itself (a windowless session would read as reachable right up to the refusal).
// Every case below therefore asserts on the socket receiving NOTHING, not just
// on what was printed.

/** Where the fixture $HOME keeps its config.json (the legacy dir loadConfig falls back to). */
const configPath = (mock: { home: string }) => join(mock.home, ".claude-launcher", "config.json");

test("agendo send takes the pane when config.json turns the socket off", async ({ mock }) => {
  writeFileSync(configPath(mock), JSON.stringify({ peerSocket: false }));
  const peer = await fakePeer(mock, "peer-cfg-off", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
    // Named, not silent: a caller expecting socket semantics has to be able to
    // see that it got keystroke semantics, and why.
    expect(r.stdout).toContain("socket disabled by config");
    expect(peer.frames).toEqual([]);
    const tmux = await mock.tmuxLog();
    expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(true);
  } finally {
    await peer.close();
  }
});

test("agendo send takes the pane when AGENDO_PEER_SOCKET turns the socket off", async ({ mock }) => {
  const peer = await fakePeer(mock, "peer-env-off", "idle");
  try {
    const env = { ...mock.env, AGENDO_PEER_SOCKET: "0" };
    const r = await agendoAsync(env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
    expect(r.stdout).toContain("socket disabled by AGENDO_PEER_SOCKET");
    expect(peer.frames).toEqual([]);
  } finally {
    await peer.close();
  }
});

// The variable is the one-off override and the file is the durable preference,
// so the variable has to win in BOTH directions — an override that could only
// disable would be half a switch, and would leave no way to test a `false`
// config's effect without editing the file back and forth.
for (const [label, configured, envValue, expectSocket] of [
  ["AGENDO_PEER_SOCKET=1 re-enables a config that says false", false, "1", true],
  ["AGENDO_PEER_SOCKET=0 overrides a config that says true", true, "0", false],
] as const) {
  test(`agendo send: ${label}`, async ({ mock }) => {
    writeFileSync(configPath(mock), JSON.stringify({ peerSocket: configured }));
    const peer = await fakePeer(mock, `peer-override-${envValue}`, "idle");
    try {
      const env = { ...mock.env, AGENDO_PEER_SOCKET: envValue };
      const r = await agendoAsync(env, "send", "--json", SHORT_ID, "run the tests").done;
      expect(r.code).toBe(0);
      const o = sendJson(r.stdout);
      expect(o.route).toBe(expectSocket ? "socket" : "pane");
      // …and the payload attributes the decision to the env var either way, so
      // "why is this on the wrong route" is answerable without guessing.
      expect(o.socket).toEqual({ enabled: expectSocket, disabledBy: expectSocket ? null : "env" });
      if (expectSocket) await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');
      else expect(peer.frames).toEqual([]);
    } finally {
      await peer.close();
    }
  });
}

test("an unrecognized AGENDO_PEER_SOCKET value disables the socket and says so", async ({ mock }) => {
  // Deliberately fails CLOSED, unlike the config key (where a stray value is
  // ignored, as resumeDialogChoice's is). Setting this variable at all is an act
  // of turning something off in a hurry; a typo that handed back the very path
  // the user was escaping would make it a switch you cannot rely on.
  const peer = await fakePeer(mock, "peer-env-typo", "idle");
  try {
    const env = { ...mock.env, AGENDO_PEER_SOCKET: "disbale" };
    const r = await agendoAsync(env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("isn't a recognized on/off value");
    expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
    expect(peer.frames).toEqual([]);
  } finally {
    await peer.close();
  }
});

test("with the socket off, send refuses a busy pane again", async ({ mock }) => {
  // The behaviour the switch is really restoring. With the socket on, a
  // compacting session is queued to and reported (exit 0). With it off, `send`
  // is back to what it was before the socket existed: a paste would clobber the
  // screen, so it refuses — and refuses without having written to the socket
  // that was sitting right there.
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: ["✻ Compacting conversation… (esc to interrupt)", "  ▰▰▰▱▱▱ 42%"].join("\n") },
  });
  const peer = await fakePeer(mock, "peer-off-busy", "busy");
  try {
    const env = { ...mock.env, AGENDO_PEER_SOCKET: "off" };
    const r = await agendoAsync(env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not ready");
    expect(peer.frames).toEqual([]);
  } finally {
    await peer.close();
  }
});

test("with the socket off, a windowless session is unreachable again — and says which", async ({ mock }) => {
  // The other half of "exactly today's behaviour": reaching a session that has no
  // tmux window is a capability the socket ADDED, so switching it off has to take
  // it away. The failure must not read as "that session isn't running" when the
  // truth is "you turned off the only route to it".
  const peer = await fakePeer(mock, "peer-off-windowless", "idle", STANDALONE_SESSION_ID);
  try {
    const env = { ...mock.env, AGENDO_PEER_SOCKET: "0" };
    const r = await agendoAsync(env, "send", shortIdOf(STANDALONE_SESSION_ID), "run the tests").done;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("messaging socket is disabled");
    expect(r.stderr).toContain("AGENDO_PEER_SOCKET");
    expect(peer.frames).toEqual([]);
  } finally {
    await peer.close();
  }
});

test("agendo status still sees a peer with the socket switched off", async ({ mock }) => {
  // The switch turns off SPEAKING an undocumented protocol; it does not turn off
  // reading a registry file. Gating discovery everywhere would make a live
  // session vanish from `status` — and stop `resume` refusing to put a second
  // claude on a transcript that already has one — which is the opposite of the
  // caution the switch exists for.
  const peer = await fakePeer(mock, "peer-off-status", "busy", STANDALONE_SESSION_ID);
  try {
    const env = { ...mock.env, AGENDO_PEER_SOCKET: "0" };
    const r = await agendoAsync(env, "status", shortIdOf(STANDALONE_SESSION_ID)).done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("◆ running");
    expect(r.stdout).toContain(`pid ${process.pid}`);
  } finally {
    await peer.close();
  }
});

test("agendo status reports a session running outside agendo as ◆ running", async ({ mock }) => {
  const peer = await fakePeer(mock, "peer-status", "busy", STANDALONE_SESSION_ID);
  try {
    const r = await agendoAsync(mock.env, "status", shortIdOf(STANDALONE_SESSION_ID)).done;
    expect(r.code).toBe(0);
    // Not "○ idle": the transcript is stale but the process is alive.
    expect(r.stdout).toContain("◆ running");
    expect(r.stdout).toContain(`pid ${process.pid}`);
    expect(r.stdout).toContain("attach does not");
  } finally {
    await peer.close();
  }
});

test("agendo resume refuses a session already running outside agendo", async ({ mock }) => {
  // Resuming it would put a second live claude on one transcript.
  const peer = await fakePeer(mock, "peer-resume", "busy", STANDALONE_SESSION_ID);
  try {
    const r = await agendoAsync(mock.env, "resume", shortIdOf(STANDALONE_SESSION_ID)).done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("already running outside agendo");
    // No window was created for it.
    const tmux = await mock.tmuxLog();
    expect(tmux.some((argv) => argv[0] === "new-window" || argv[0] === "new-session")).toBe(false);
  } finally {
    await peer.close();
  }
});

test("agendo send falls back to the tmux pane when the advertised socket is dead", async ({ mock }) => {
  // The nastier stale case: the pid IS live (it's ours) but the socket it
  // advertises is gone — the session died between discovery and send. Failing
  // here would strand a prompt even though the tmux window is still usable, so
  // the send must fall through to the pane.
  await mkdir(join(mock.home, ".claude", "sessions"), { recursive: true });
  await writeFile(
    join(mock.home, ".claude", "sessions", `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: LOGIN_SESSION_ID,
      cwd: "/run/login",
      peerProtocol: 1,
      kind: "interactive",
      messagingSocketPath: join(mock.tmpDir, "never-bound.sock"),
      status: "idle",
    }),
  );

  const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
  expect(r.code).toBe(0);
  expect(r.stderr).toContain("falling back to the tmux pane");
  expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(true);
});

test("agendo send refuses a usage-limited session even over the socket", async ({ mock }) => {
  // Queuing is safe for "busy", but not for "limited": nothing will read the
  // frame until the cap resets, so claiming success would mislead an
  // orchestrator that keys on the exit code.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  const peer = await fakePeer(mock, "peer-limited", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage limit");
    expect(peer.frames).toEqual([]); // nothing was queued
  } finally {
    await peer.close();
  }
});

test("agendo send falls back to the tmux pane when the registry entry is stale", async ({ mock }) => {
  // A registry file outlives its process. Point one at a dead pid (and a socket
  // that does not exist) — the liveness probe must reject it and the send must
  // still land, via the pane, rather than erroring on a vanished socket.
  await mkdir(join(mock.home, ".claude", "sessions"), { recursive: true });
  await writeFile(
    join(mock.home, ".claude", "sessions", "999999999.json"),
    JSON.stringify({
      pid: 999_999_999, // above /proc/sys/kernel/pid_max — cannot be live
      sessionId: LOGIN_SESSION_ID,
      cwd: "/run/login",
      peerProtocol: 1,
      kind: "interactive",
      messagingSocketPath: join(mock.tmpDir, "gone.sock"),
      status: "idle",
    }),
  );

  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
  expect(r.stdout).not.toContain("queued via socket");
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(true);
});

test("agendo send refuses a closed session rather than queueing where nobody reads", async ({ mock }) => {
  // What `agendo close` leaves behind: the window is gone and the process is
  // dead, but the registry file it wrote outlives it — and on an abrupt kill the
  // socket inode can outlive it too. Both are therefore present here, and the
  // socket is genuinely LISTENING, so the only thing separating this from a live
  // peer is the pid. If discovery trusted the advertised socket instead, `send`
  // would connect, hand over the bytes and report a queued success for a message
  // no one will ever read — the exact false success this test exists to forbid.
  const sockPath = join(mock.tmpDir, "closed-session.sock");
  const frames: string[] = [];
  const orphan = createServer((c) => c.on("data", (d) => frames.push(d.toString())));
  await new Promise<void>((r) => orphan.listen(sockPath, r));
  await mkdir(join(mock.home, ".claude", "sessions"), { recursive: true });
  await writeFile(
    join(mock.home, ".claude", "sessions", "999999998.json"),
    JSON.stringify({
      pid: 999_999_998, // above /proc/sys/kernel/pid_max — cannot be live
      sessionId: STANDALONE_SESSION_ID,
      cwd: "/run/standalone",
      peerProtocol: 1,
      kind: "interactive",
      messagingSocketPath: sockPath,
      status: "idle",
    }),
  );
  try {
    // STANDALONE has no `cl-…` window, so once the peer is rejected there is no
    // route left at all — and "no route" must be an error, never a quiet success.
    const r = await agendoAsync(mock.env, "send", shortIdOf(STANDALONE_SESSION_ID), "run the tests").done;
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no live tmux window and no messaging socket");
    expect(r.stdout).not.toContain("queued via socket");
    expect(frames).toEqual([]); // nothing was handed to the orphaned socket
  } finally {
    await new Promise<void>((r) => orphan.close(() => r()));
  }
});

// Anything the registry advertises that we don't positively recognize must read
// as "no peer" and leave the send on the tmux path. Writing frames a receiver may
// not parse — or queueing into something with no TUI to render them — is worse
// than typing into the pane, which always works.
for (const [label, over] of [
  ["an unknown protocol version", { peerProtocol: 99 }],
  ["a non-interactive kind", { kind: "background" }],
] as const) {
  test(`agendo send ignores a peer advertising ${label}`, async ({ mock }) => {
    const peer = await fakePeer(mock, "peer-unrecognized", "idle", LOGIN_SESSION_ID, over);
    try {
      const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
      expect(r.code).toBe(0);
      expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
      expect(r.stdout).not.toContain("queued via socket");
      expect(peer.frames).toEqual([]); // the socket was never written to
    } finally {
      await peer.close();
    }
  });
}

test("agendo send finds a peer registered under a second ~/.claude* profile", async ({ mock }) => {
  // Sessions are spread across profile dirs (~/.claude, ~/.claude-work), which is
  // why claudeConfigDirs() exists. Discovery that only looked at ~/.claude would
  // silently drop half a machine's sessions back onto the pane path.
  const peer = await fakePeer(mock, "peer-profile", "idle", LOGIN_SESSION_ID, {}, ".claude-work");
  try {
    const r = await agendoAsync(mock.env, "send", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("queued via socket");
    await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');
  } finally {
    await peer.close();
  }
});

test("agendo send never routes a copilot session to a claude peer", async ({ mock }) => {
  // `send` resolves the peer from the bare token without consulting the session
  // index, so nothing structural stops a copilot id from matching a claude peer's
  // short id. Only claude registers a socket, so a copilot session must always
  // take the pane path — pinned here so a future id scheme can't silently
  // misdeliver one agent's prompt into another's queue.
  const peer = await fakePeer(mock, "peer-copilot", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", COP_SHORT_ID, "run the tests").done;
    expect(r.stdout).not.toContain("queued via socket");
    expect(peer.frames).toEqual([]); // the claude peer was left alone
  } finally {
    await peer.close();
  }
});

test("agendo send --force queues to a usage-limited session over the socket", async ({ mock }) => {
  // The un-forced case refuses (exit 2). --force is the documented override, and
  // over the socket it means "queue it anyway, it'll be read after the reset" —
  // not the pane path's "type into whatever is on screen".
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  const peer = await fakePeer(mock, "peer-limited-forced", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", "-f", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("queued via socket");
    await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');
    // Still the socket, not keystrokes — --force must not downgrade the path.
    const tmux = await mock.tmuxLog();
    expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(false);
  } finally {
    await peer.close();
  }
});

test("agendo status prefers the window over the registry when a session has both", async ({ mock }) => {
  // A peer with a live agendo window is attachable, so it must read ● (attach
  // works), never ◆ (attach does not) — the registry must not override tmux.
  const peer = await fakePeer(mock, "peer-both", "busy");
  try {
    const r = await agendoAsync(mock.env, "status", SHORT_ID).done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("● running");
    expect(r.stdout).not.toContain("◆ running");
    expect(r.stdout).not.toContain("attach does not");
  } finally {
    await peer.close();
  }
});

// A pane whose input box holds claude's greyed-out autocomplete SUGGESTION —
// nothing typed, Tab would accept it. Written without SGR escapes, which is the
// case colour alone cannot resolve (a suggestion in a grey `inputRealText`
// doesn't enumerate looks exactly like this): only the caret settles it. The
// `❯` sits at column 2, so the first input cell is column 4 and the box is
// capture row 2.
const GHOST_PANE = [
  "  ● Implement login form",
  "  ─────────────────────────────────────────────",
  "  ❯ wait for the review, then commit and open the PR",
  "  ─────────────────────────────────────────────",
].join("\n");
const GHOST_PROMPT_CURSOR = { x: 4, y: 2 };

test("agendo send treats a ghost suggestion as an empty box (caret still at the prompt)", async ({ mock }) => {
  // End-to-end proof that the caret reaches the classifier through the CLI: the
  // same screen is sendable or not purely on where tmux reports the caret.
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: GHOST_PANE },
    cursors: { [RUNNING_TARGET]: GHOST_PROMPT_CURSOR },
  });

  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(true);
});

test("agendo send still refuses when the caret sits at the END of the same text (a real draft)", async ({ mock }) => {
  // The guard against over-correcting: identical pane, caret where typing leaves
  // it, so the box holds a draft and `send` must not clobber it.
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: GHOST_PANE },
    cursors: {
      [RUNNING_TARGET]: { x: GHOST_PROMPT_CURSOR.x + "wait for the review, then commit and open the PR".length, y: 2 },
    },
  });

  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("queued");
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "paste-buffer")).toBe(false);
});

// The claude CLI's OWN resume dialog, verbatim from a real blocked session (the
// same fixture detection.spec.ts pins). There is NO input box behind it: `send`
// is keystroke injection, so a message pasted here would be typed into a
// numbered menu and Enter would pick whatever landed selected.
const RESUME_DIALOG_PANE = readFileSync(join(import.meta.dirname, "fixtures", "resume-dialog.ansi"), "utf-8");
// What the pane looks like once the session has actually reloaded.
const RESUMED_BOX_PANE = [
  "  ● Resumed from summary — picking the work back up.",
  "  ─────────────────────────────────────────────",
  "  ❯ ",
  "  ─────────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

/** Every `send-keys … <key>` invocation's position in the log, in order. */
const keyIndexes = (log: string[][], key: string) =>
  log.flatMap((argv, i) => (argv[0] === "send-keys" && argv[3] === key ? [i] : []));
/** The keys sent to the running pane, in order — the whole keystroke story. */
const keysSent = (log: string[][]) =>
  log.filter((argv) => argv[0] === "send-keys" && argv[2] === RUNNING_TARGET).map((argv) => argv.slice(3).join(" "));

/**
 * Fake-tmux state whose pane serves `queue` one capture per read, then `rest`
 * for every read after that — so a test can script the pane CHANGING between
 * reads (dialog → dialog → box) deterministically, instead of racing a timer
 * against the CLI's own polling. See `captureQueue` in e2e/fakebin/tmux.
 */
const scriptedPane = (queue: string[], rest: string) => ({
  ...tmuxState,
  captureQueue: { [RUNNING_TARGET]: queue },
  captures: { [RUNNING_TARGET]: rest },
});
/**
 * The same dialog with the `❯` cursor moved down onto option 2 (as-is) — what the
 * pane looks like after one Down. Built by moving the marker between lines (the
 * capture paints the cursor and the number in different colours, so the two are
 * not adjacent in the raw text).
 */
const RESUME_DIALOG_ON_AS_IS = RESUME_DIALOG_PANE.split("\n")
  .map((line) => {
    if (/^\s*❯\s*1\./.test(stripAnsiText(line))) return line.replace("❯", " ");
    if (/^\s{4}2\./.test(stripAnsiText(line))) return line.replace(/^ {4}/, "  ❯ ");
    return line;
  })
  .join("\n");

test("agendo send answers claude's resume dialog FIRST, then pastes the message", async ({ mock }) => {
  // The whole point: before this, the session sat on the dialog forever
  // (readiness "dialog" ⇒ send refuses). Now `send` confirms the configured
  // option, waits for a real input box, and only then delivers.
  //
  // Three dialog reads: runSend's own readiness read, then the two matching
  // looks that settle the selection. The cursor already sits on option 1, so the
  // answer is a bare Enter.
  await mock.setTmuxState(scriptedPane(Array(3).fill(RESUME_DIALOG_PANE), RESUMED_BOX_PANE));
  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  // Default config ⇒ the option claude marks (recommended).
  expect(r.stdout).toContain("answering claude's resume dialog (summary): 1. Resume from summary (recommended)");
  expect(r.stdout).toContain(`pasted into pane ${RUNNING_TARGET}`);

  const log = await mock.tmuxLog();
  const setBuffer = log.findIndex((argv) => argv[0] === "set-buffer");
  const paste = log.findIndex((argv) => argv[0] === "paste-buffer");
  const enters = keyIndexes(log, "Enter");
  // THE ORDER IS THE SAFETY PROPERTY: the menu is confirmed before the message
  // is ever staged, let alone pasted.
  expect(enters).toHaveLength(2); // the dialog's confirm, then the message's submit
  expect(setBuffer).toBeGreaterThan(enters[0]);
  expect(paste).toBeGreaterThan(setBuffer);
  expect(enters[1]).toBeGreaterThan(paste);
  expect(log[setBuffer]).toEqual(["set-buffer", "-b", "cl-send", "--", "run the tests"]);
  // Nothing but those two Enters ever reached the pane — in particular no digit,
  // which could ACTIVATE an option on some CLI versions and merely select it on
  // others, leaving no safe meaning for the Enter that follows.
  expect(keysSent(log)).toEqual(["Enter", "Enter"]);
});

// ── the dialog step and the delivery step are separate concerns ──────────────
// Answering the resume dialog is keystrokes; delivering the message may be the
// socket. A peer frame arrives as "another Claude session sent a message", which
// the receiver will NOT take as the answer to a pending prompt — so the socket is
// an alternative for the DELIVERY only, and can never stand in for the dialog.

test("agendo send answers the resume dialog with keystrokes, then delivers over the socket", async ({ mock }) => {
  // The reconciliation, end to end: the dialog is confirmed by keystroke exactly
  // as it is without a socket, and only the message itself changes route. If the
  // socket were allowed to serve the dialog step, the frame would be queued past
  // an unanswered menu and the session would stay parked forever.
  await mock.setTmuxState(scriptedPane(Array(3).fill(RESUME_DIALOG_PANE), RESUMED_BOX_PANE));
  const peer = await fakePeer(mock, "peer-dialog", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", "--timeout", "5s", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(0);
    // Step 1 still happened, on the pane.
    expect(r.stdout).toContain("answering claude's resume dialog (summary): 1. Resume from summary (recommended)");
    // Step 2 took the socket instead of the pane.
    expect(r.stdout).toContain("queued via socket");
    expect(r.stdout).not.toContain(`pasted into pane ${RUNNING_TARGET}`);
    await expect.poll(framesOf(peer)).toContain('"content":"run the tests"');

    const log = await mock.tmuxLog();
    // ONE Enter — the dialog's confirm. The message's own submit Enter is absent
    // because the message never went through the pane at all.
    expect(keysSent(log)).toEqual(["Enter"]);
    expect(log.some((argv) => argv[0] === "set-buffer" || argv[0] === "paste-buffer")).toBe(false);
  } finally {
    await peer.close();
  }
});

test("agendo send won't queue past a resume dialog it failed to answer", async ({ mock }) => {
  // The gate must bind the socket path too. The box never comes back, so the
  // dialog is still up — and a frame queued behind it would sit unread while
  // `send` reported success. Nothing is delivered by EITHER route.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const peer = await fakePeer(mock, "peer-dialog-stuck", "idle");
  try {
    const r = await agendoAsync(mock.env, "send", "--force", "--timeout", "1s", SHORT_ID, "run the tests").done;
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no input box appeared");
    expect(peer.frames).toEqual([]); // not queued — the socket did not bypass the gate
    const log = await mock.tmuxLog();
    expect(log.some((argv) => argv[0] === "set-buffer" || argv[0] === "paste-buffer")).toBe(false);
  } finally {
    await peer.close();
  }
});

test("agendo send walks the selection to the configured option before confirming", async ({ mock }) => {
  // 'as-is' is option 2 while the cursor starts on 1: one Down, then a re-read
  // that SEES the cursor land on 2, and only then Enter. Nothing is confirmed on
  // an assumption about where the selection ended up.
  const cfgPath = join(mock.home, ".claude-launcher", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, resumeDialogChoice: "as-is" }, null, 2));

  // Frames 4 and 5 are STALE — the pane hasn't repainted yet when it's read after
  // the Down. However many such frames arrive, they must not provoke a second
  // Down: one past the target is "Don't ask me again", which permanently changes
  // the user's global claude CLI behaviour. (Two of them defeat a rule that only
  // asks for "the same selection twice running" — a display running N frames
  // behind is perfectly stable frame to frame.)
  await mock.setTmuxState(
    scriptedPane(
      [...Array(5).fill(RESUME_DIALOG_PANE), ...Array(2).fill(RESUME_DIALOG_ON_AS_IS)],
      RESUMED_BOX_PANE,
    ),
  );
  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("answering claude's resume dialog (as-is): 2. Resume full session as-is");

  const log = await mock.tmuxLog();
  expect(keysSent(log)).toEqual(["Down", "Enter", "Enter"]); // move · confirm · submit
  expect(keyIndexes(log, "Down")[0]).toBeLessThan(log.findIndex((argv) => argv[0] === "set-buffer"));
});

/** A synthetic resume menu: `cursorOn` is the highlighted option's number. */
const resumeMenu = (cursorOn: number, labels: string[]) =>
  [
    "  This session is 1h 14m old and 249.4k tokens.",
    "",
    ...labels.map((l, i) => `  ${cursorOn === i + 1 ? "❯" : " "} ${i + 1}. ${l}`),
    "",
    "  Enter to confirm · Esc to cancel",
  ].join("\n");

test("agendo send tracks its option by LABEL when the menu renumbers itself", async ({ mock }) => {
  // If a CLI version reorders the options — or adds one — between frames, the
  // number agendo first resolved belongs to something else. Aiming at it would,
  // in this arrangement, confirm "Don't ask me again": a permanent change to the
  // user's global claude CLI behaviour that agendo must never make.
  const cfgPath = join(mock.home, ".claude-launcher", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, resumeDialogChoice: "as-is" }, null, 2));

  const AS_IS = "Resume full session as-is";
  const before = ["Resume from summary (recommended)", AS_IS, "Don't ask me again"];
  const after = ["Resume from summary (recommended)", "Don't ask me again", AS_IS];
  await mock.setTmuxState(
    scriptedPane(
      [
        ...Array(3).fill(resumeMenu(1, before)), // as-is is #2 here…
        ...Array(2).fill(resumeMenu(2, after)), // …but #2 is now "Don't ask me again"
        ...Array(2).fill(resumeMenu(3, after)), // as-is moved to #3
      ],
      RESUMED_BOX_PANE,
    ),
  );
  const r = agendo(mock.env, "send", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  const log = await mock.tmuxLog();
  // It kept walking to the label instead of confirming #2 the moment the cursor
  // reached that number.
  expect(keysSent(log)).toEqual(["Down", "Down", "Enter", "Enter"]);
});

test("agendo send refuses when the dialog's selection won't move", async ({ mock }) => {
  // The pane keeps showing the cursor on option 1, so the wanted option is never
  // selected: give up rather than confirm the wrong one, and never paste. And
  // exactly ONE arrow goes out — a pane that never shows the move must not have
  // the highlight walked down onto "Don't ask me again" and abandoned there.
  const cfgPath = join(mock.home, ".claude-launcher", "config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, resumeDialogChoice: "as-is" }, null, 2));

  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const r = agendo(mock.env, "send", "--timeout", "1s", SHORT_ID, "run the tests");
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("couldn't select");
  const log = await mock.tmuxLog();
  expect(keysSent(log)).toEqual(["Down"]); // it tried once, then stopped — no Enter
  expect(log.some((argv) => argv[0] === "set-buffer" || argv[0] === "paste-buffer")).toBe(false);
});

test("agendo send: a message containing digits never leaks into the menu", async ({ mock }) => {
  // The live footgun this feature has to avoid: pasting "2" + Enter into the
  // resume menu selects "Resume full session as-is" instead of sending anything.
  await mock.setTmuxState(scriptedPane(Array(3).fill(RESUME_DIALOG_PANE), RESUMED_BOX_PANE));
  const message = "2 or 3 tests still fail — check option 3 first";
  const r = agendo(mock.env, "send", SHORT_ID, message);
  expect(r.status).toBe(0);

  const log = await mock.tmuxLog();
  // No literal text was typed at the pane at all — the message travelled as a
  // bracketed paste, in full, and only after the dialog was confirmed.
  expect(log.some((argv) => argv[0] === "send-keys" && argv.includes("-l"))).toBe(false);
  const setBuffer = log.findIndex((argv) => argv[0] === "set-buffer");
  expect(log[setBuffer]).toEqual(["set-buffer", "-b", "cl-send", "--", message]);
  expect(setBuffer).toBeGreaterThan(keyIndexes(log, "Enter")[0]);
});

test("agendo send --force still won't paste into a menu that only LOOKS like the dialog", async ({ mock }) => {
  // A wrapped label (narrow pane) makes the detector miss — deliberately, it
  // fails safe — so readiness is "dialog" and the normal refusal applies. The
  // hazard is the documented escape hatch: --force would paste the message into
  // the menu, where its digits pick options.
  const wrapped = RESUME_DIALOG_PANE.replace("Resume full session as-is", "Resume full session\n     as-is");
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: wrapped } });
  const r = agendo(mock.env, "send", "--force", SHORT_ID, "2 tests fail");
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("resume menu");
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "set-buffer" || argv[0] === "paste-buffer")).toBe(false);
  expect(keysSent(log)).toEqual([]);
});

test("agendo unblock refuses on the resume dialog — Escape would cancel it", async ({ mock }) => {
  // `unblock` sends <esc>continue<enter>. On this dialog the Escape IS its "Esc
  // to cancel", so it would abandon the resume. Refused even with --force.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const r = agendo(mock.env, "unblock", "--force", SHORT_ID);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("resume dialog");
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "send-keys" && argv.includes("Escape"))).toBe(false);
  expect(log.some((argv) => argv[0] === "send-keys" && argv.includes("continue"))).toBe(false);
});

test("agendo send won't paste on a single glimpse of the input box", async ({ mock }) => {
  // A reloading TUI paints its box before it has finished restoring, and a paste
  // into that half-drawn screen can be discarded by the next repaint. So the box
  // has to still be there a poll later: here it flickers into view once and the
  // dialog comes back, and nothing is sent.
  await mock.setTmuxState(scriptedPane([...Array(3).fill(RESUME_DIALOG_PANE), RESUMED_BOX_PANE], RESUME_DIALOG_PANE));
  const r = agendo(mock.env, "send", "--timeout", "1s", SHORT_ID, "run the tests");
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("no input box appeared");
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "set-buffer" || argv[0] === "paste-buffer")).toBe(false);
});

test("agendo send refuses to paste when the input box never comes back", async ({ mock }) => {
  // Never assume the answer worked: if the box doesn't reappear, the message is
  // NOT pasted — a paste into a still-open menu is the exact hazard. Not even
  // --force overrides that, since forcing a paste into a menu is the footgun.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const r = agendo(mock.env, "send", "--force", "--timeout", "1s", SHORT_ID, "run the tests");
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("no input box appeared");
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "paste-buffer")).toBe(false);
  expect(log.some((argv) => argv[0] === "set-buffer")).toBe(false);
});

test("agendo send says so when a corrupt config.json cost it the resume choice", async ({ mock }) => {
  // `send` is the one command that ACTS on config.json's value — by pressing keys
  // into a live session. A corrupt file falls back to the default silently, which
  // is precisely the "say what failed to parse" case: the fallback still answers
  // the dialog (so the send goes through), but stderr names the file.
  writeFileSync(join(mock.home, ".claude-launcher", "config.json"), "{ not json");
  await mock.setTmuxState(scriptedPane(Array(3).fill(RESUME_DIALOG_PANE), RESUMED_BOX_PANE));
  const r = agendo(mock.env, "send", "--timeout", "5s", SHORT_ID, "run the tests");
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("send:");
  expect(r.stderr).toContain("config.json");
  // …and it fell back to the recommended option rather than refusing to answer.
  expect(r.stdout).toContain("Resume from summary");
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "paste-buffer")).toBe(true);
});

test("agendo send rejects a malformed --timeout, and delivers nothing", async ({ mock }) => {
  // `send` parses its own duration flag (sharing `wait`'s parseDuration but not
  // its argv parser, which is wait-specific), so the rejection needs its own pin:
  // a bad duration must fail LOUDLY under the send name rather than silently fall
  // back to the default ceiling — and must not deliver the message on the way out.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const r = agendo(mock.env, "send", "--timeout", "5min", SHORT_ID, "run the tests");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("send: --timeout needs a duration");
  const log = await mock.tmuxLog();
  expect(log.some((argv) => argv[0] === "set-buffer" || argv[0] === "paste-buffer")).toBe(false);
  expect(log.some((argv) => argv[0] === "send-keys")).toBe(false);
});

test("agendo status/list report the resume dialog as ready, not blocked", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const status = agendo(mock.env, "status", SHORT_ID);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("ready:  ready");
  expect(status.stdout).not.toContain("ready:  dialog");
  // …while still saying what the pane is actually showing.
  expect(status.stdout).toContain("resume: claude's resume dialog is open");
  const list = agendo(mock.env, "list");
  expect(list.stdout).toContain("ready");
  expect(list.stdout).not.toContain("dialog");
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

// ── idle age + the stalled qualifier ─────────────────────────────────────────
// The problem these guard: a session that fell over mid-task 22 hours ago and one
// that finished cleanly 20 seconds ago both render as `ready`, so an orchestrator
// has to fetch the last message and judge the prose to tell them apart. Idle age
// plus the ⚠stalled qualifier make it decidable — WITHOUT touching readiness,
// which stays load-bearing for send / wait / auto-resume.
//
// Fixture ages (see materializeHome): login 5m (running), crash 1h, copilot 2h,
// standalone 5h — only login has a live window.

/** The one output row for a session, so an assertion can't be satisfied by the
 *  header or by a different session's row. */
const rowFor = (stdout: string, id: string) => stdout.split("\n").find((l) => l.includes(id)) ?? "";

/** Write a minimal extra Claude transcript into the fixture HOME, so a test can
 *  place a session at an arbitrary cwd that materializeHome doesn't cover. */
async function writeSessionAt(home: string, id: string, cwd: string, title: string) {
  const dir = join(home, ".claude", "projects", `extra-${id}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({ type: "summary", cwd, gitBranch: "main", timestamp: "2026-06-20T10:00:00.000Z" }),
      JSON.stringify({ type: "ai-title", aiTitle: title, timestamp: "2026-06-20T10:00:01.000Z" }),
      "",
    ].join("\n"),
  );
}

test("agendo list surfaces idle age, and --json carries it as seconds per session", async ({ mock }) => {
  const plain = agendo(mock.env, "list");
  expect(plain.status).toBe(0);
  // The age sits on the session's OWN row, after its readiness — not merely
  // somewhere in the output.
  expect(rowFor(plain.stdout, SHORT_ID)).toMatch(/ready\s+.*\s\d+[smhd] ago\s/);

  const r = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const login = rows.find((x) => x.shortId === SHORT_ID);
  // Machine-readable: seconds AND the ISO timestamp, not a humanized string.
  expect(login.idleSeconds).toBeGreaterThanOrEqual(240); // ~5 minutes
  expect(login.idleSeconds).toBeLessThan(3600);
  expect(Number.isFinite(new Date(login.lastUsed).getTime())).toBe(true);
  // It's per-session, not one clock for the listing: standalone is far older.
  const standalone = rows.find((x) => x.shortId === STANDALONE_SHORT_ID);
  expect(standalone.idleSeconds).toBeGreaterThan(login.idleSeconds);
});

test("⚠stalled trips past the threshold and not before, leaving readiness alone", async ({ mock }) => {
  // The login session is live with a ready pane and last did something 5m ago.
  const under = agendo(mock.env, "list", "--stalled-after", "1h");
  expect(under.status).toBe(0);
  expect(under.stdout).toContain("ready");
  expect(under.stdout).not.toContain("⚠stalled");

  const over = agendo(mock.env, "list", "--stalled-after", "1m");
  expect(over.status).toBe(0);
  // …and it is a QUALIFIER riding alongside an UNCHANGED readiness column: both
  // appear on the same row, readiness still reading exactly "ready".
  expect(rowFor(over.stdout, SHORT_ID)).toMatch(/●\s+ready\s+.*⚠stalled/);
});

test("a busy session is never stalled, and neither is one that isn't running", async ({ mock }) => {
  // Mid-generation pane: demonstrably alive and working, so no threshold — not
  // even 1ms — may flag it, however old its transcript mtime is.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const plain = agendo(mock.env, "list", "--stalled-after", "1ms");
  expect(plain.status).toBe(0);
  expect(plain.stdout).toContain("busy");
  expect(plain.stdout).not.toContain("⚠stalled");

  const r = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1ms").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const login = rows.find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("busy"); // readiness value itself is unchanged
  expect(login.stalled).toBe(false);
  expect(login.idleSeconds).toBeGreaterThan(1); // …despite being well past 1ms
  // A session with no live window is "not running", never "stalled" — otherwise
  // every session on disk would be permanently stalled as it ages.
  const crash = rows.find((x) => x.shortId === CRASH_SHORT_ID);
  expect(crash.running).toBe(false);
  expect(crash.stalled).toBe(false);
  expect(crash.idleSeconds).toBeGreaterThan(login.idleSeconds);
  // The threshold each verdict was judged against travels with the row, EXACTLY
  // — a consumer re-deriving the comparison must not disagree with `stalled`.
  expect(login.stalledAfterSeconds).toBe(0.001);
});

test("a session whose pane can't be read is never stalled (no evidence, no verdict)", async ({ mock }) => {
  // The tmux session exists, but there is no readable pane behind it — a window we
  // can't capture. We can't see that it ISN'T working, so the flag must stay off
  // however long it's been. (Restored-but-unopened placeholder tabs take a
  // different route to the same answer: reconciliation drops them from the live
  // set, so they arrive as `running: false` and are never candidates at all.)
  await mock.setTmuxState({ ...tmuxState, panes: [], captures: {} });
  const r = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1ms").done;
  expect(r.code).toBe(0);
  const login = (JSON.parse(r.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.running).toBe(true);
  expect(login.readiness).toBeNull();
  expect(login.stalled).toBe(false);
});

test("a session parked on claude's resume dialog is never stalled, however old it looks", async ({ mock }) => {
  // The one case where a big idle age means the OPPOSITE of stalled. The pane
  // reads `ready` (send answers the dialog rather than pasting into it) and the
  // transcript mtime is the PREVIOUS run's, because this run hasn't started — it
  // is waiting on an answer, which `send` can now give it automatically. Marking
  // it stalled would point an orchestrator at the one session that needs no
  // rescue. The signal is `wait --json`'s own `resumeDialog`, not a second guess.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });

  const r = agendo(mock.env, "status", SHORT_ID, "--stalled-after", "1ms");
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("⚠ stalled");
  expect(r.stdout).toContain("resume: claude's resume dialog is open"); // says why instead
  expect(r.stdout).toContain("ready:  ready"); // readiness itself is untouched

  const plain = agendo(mock.env, "list", "--stalled-after", "1ms");
  expect(plain.status).toBe(0);
  expect(rowFor(plain.stdout, SHORT_ID)).not.toContain("⚠stalled");

  const j = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1ms").done;
  expect(j.code).toBe(0);
  const login = (JSON.parse(j.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.resumeDialog).toBe(true); // carried, so a consumer needn't re-infer it
  expect(login.stalled).toBe(false);
  expect(login.idleSeconds).toBeGreaterThan(1); // …despite being far past the threshold
});

// Claude's feedback survey, reconstructed (not a verbatim capture — no SGR
// escapes, unlike e2e/fixtures/*.ansi): numbered options directly above a LIVE
// input box. Today this classifies as `ready` and nothing in `isDialog` comes
// close to matching it — its signatures are a confirm/cancel footer or a `❯ 1.`
// selection cursor, and this menu has neither. That is the point of keeping it:
// the obvious way to teach agendo about surveys is to widen the numbered-menu
// match to `N:` forms, and that change would silently reclassify this pane as
// `dialog` — blocking `send`, and (via the settled-state rule `wait` and the
// stall qualifier share) changing what counts as stalled. A forward guard, then,
// on a real screen shape — not a claim that anything mishandles it now.
// (The already-dismissed `❯ 1.`-above-an-input-box case is master's, covered in
// e2e/detection.spec.ts.)
const SURVEY_PANE = [
  "● Done — all 402 tests pass.",
  "",
  "  How is Claude Code going?",
  "",
  "  1: Bad    2: Fine    3: Good    0: Dismiss",
  "",
  "───────────────────────────────────────────────",
  "❯ ",
  "───────────────────────────────────────────────",
  "  ⏵⏵ auto mode on",
].join("\n");

test("the feedback survey above a live input box is ready — not a dialog, and stallable", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: SURVEY_PANE } });

  const r = agendo(mock.env, "status", SHORT_ID, "--stalled-after", "1ms");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("ready:  ready");
  expect(r.stdout).not.toContain("resume:"); // not claude's resume dialog either
  // …and because it IS settled, the qualifier applies normally: a survey left up
  // for hours is exactly a session nobody came back to.
  expect(r.stdout).toContain("⚠ stalled");

  const j = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1ms").done;
  expect(j.code).toBe(0);
  const login = (JSON.parse(j.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("ready");
  expect(login.resumeDialog).toBe(false);
});

test("the stall threshold is configurable in config.json, and the flag still wins", async ({ mock }) => {
  // Same fixture config (org/project/team must survive — the ADO paths need it)
  // plus a one-minute threshold, so the 5-minute-idle login session trips it with
  // no flag at all.
  await writeFile(
    join(mock.home, ".claude-launcher", "config.json"),
    JSON.stringify({ org: "acme", project: "Widgets", team: "Team A", stalledAfterMinutes: 1 }, null, 2),
  );
  const configured = agendo(mock.env, "list");
  expect(configured.status).toBe(0);
  expect(configured.stdout).toContain("⚠stalled");

  // An explicit --stalled-after overrides the configured value.
  const flagged = agendo(mock.env, "list", "--stalled-after", "6h");
  expect(flagged.status).toBe(0);
  expect(flagged.stdout).not.toContain("⚠stalled");
});

test("scoping picks WHICH sessions are listed, never what their idle/stall verdict says", async ({ mock }) => {
  // The two features meet in `list`: --path/--repo choose the rows, --stalled-after
  // judges them. The failure mode is computing one against the wrong set — e.g.
  // resolving the threshold per scope, or judging before filtering and printing a
  // verdict for a row that was then dropped. A scoped row must be byte-identical
  // to the same row unscoped.
  // Plain path. Deliberately NOT a byte-identity check: the readiness column is
  // width-fitted across the rows that survive the scope (a `limited 17:00` row
  // dropping out narrows it), so identical text is not a property scoping has.
  // The VERDICT is: the marker is there either way. (Which rows survive is
  // master's own plain-path scope test; only one session is live here.)
  const unscoped = agendo(mock.env, "list", "--stalled-after", "1m");
  expect(unscoped.status).toBe(0);
  const scoped = agendo(mock.env, "list", "--repo", "appweb", "--stalled-after", "1m");
  expect(scoped.status).toBe(0);
  expect(rowFor(unscoped.stdout, SHORT_ID)).toContain("⚠stalled");
  expect(rowFor(scoped.stdout, SHORT_ID)).toContain("⚠stalled");

  // Same in --json, and the threshold each row was judged against travels with it
  // unchanged by the scope. Run SEQUENTIALLY: idleSeconds is floored whole
  // seconds off a live clock, so two concurrent runs can straddle a second
  // boundary in either order.
  const all = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1m").done;
  const one = await agendoAsync(mock.env, "list", "--all", "--json", "--repo", "appweb", "--stalled-after", "1m").done;
  const pick = (out: string) => (JSON.parse(out) as any[]).find((x) => x.shortId === SHORT_ID);
  const a = pick(all.stdout);
  const b = pick(one.stdout);
  expect(a.stalled).toBe(true); // the verdict is a real one, not "false either way"
  expect(b.stalled).toBe(a.stalled);
  expect(b.stalledAfterSeconds).toBe(60); // the flag's own threshold, not the 4h default
  expect(b.stalledAfterSeconds).toBe(a.stalledAfterSeconds);
  // …and the scope really did drop the other repo's sessions, so the comparison
  // above isn't vacuously between two identical listings.
  expect((JSON.parse(one.stdout) as any[]).some((x) => x.shortId === COP_SHORT_ID)).toBe(false);
  expect((JSON.parse(all.stdout) as any[]).some((x) => x.shortId === COP_SHORT_ID)).toBe(true);

  // …and `status` under a scope still reports both, rather than dropping the
  // qualifier on the scoped path.
  const st = agendo(mock.env, "status", SHORT_ID, "--repo", "appweb", "--stalled-after", "1m");
  expect(st.status).toBe(0);
  expect(st.stdout).toMatch(/idle:\s+\d+[smhd] /);
  expect(st.stdout).toContain("⚠ stalled");
});

test("a corrupt config.json is reported, not silently swapped for the default threshold", async ({ mock }) => {
  // `stalledAfterMinutes` lives in config.json, so a file that won't parse means
  // the printed verdict was judged against 4h rather than whatever the user set —
  // and the marker's absence (or presence) then looks like a bug in the feature.
  // Both no-model paths must say so: the plain list returns before the enriched
  // path's flush, and status reads config outside its resume-dialog branch.
  writeFileSync(join(mock.home, ".claude-launcher", "config.json"), "{ not json");

  const list = agendo(mock.env, "list");
  expect(list.status).toBe(0);
  expect(list.stderr).toContain("config.json");

  // The resume-dialog pane, because that is the case that reads config TWICE —
  // once for the threshold, once for the resume choice it prints. Both reads
  // queue the same complaint, and `takeWarnings` only dedupes within one
  // undrained batch, so a drain between them says it twice.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const status = agendo(mock.env, "status", SHORT_ID);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("resume: claude's resume dialog is open");
  expect(status.stderr.match(/config\.json/g)?.length).toBe(1);

  // …and the message is only worth printing if the fallback it announces is
  // real: rows must be judged against the shipped 4h default, not against
  // whatever the unreadable file might have said.
  const j = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(j.code).toBe(0);
  expect((JSON.parse(j.stdout) as any[])[0].stalledAfterSeconds).toBe(4 * 3600);
});

test("agendo status reports idle age and, past the threshold, the stall verdict", async ({ mock }) => {
  const r = agendo(mock.env, "status", SHORT_ID);
  expect(r.status).toBe(0);
  // Both forms: compact for humans, raw seconds for machines.
  expect(r.stdout).toMatch(/idle:\s+\d+[smhd] \(\d+s since its last recorded activity\)/);
  expect(r.stdout).not.toContain("⚠ stalled"); // 5m idle, 4h default threshold

  const stalled = agendo(mock.env, "status", SHORT_ID, "--stalled-after", "1m");
  expect(stalled.status).toBe(0);
  expect(stalled.stdout).toContain("⚠ stalled");
  expect(stalled.stdout).toContain("threshold 1m");
  // Honest about what it can and cannot know.
  expect(stalled.stdout).toContain(`cannot tell "finished" from`);
  // The readiness line is untouched by the qualifier.
  expect(stalled.stdout).toContain("ready:");

  // The threshold is quoted back EXACTLY as configured. It has to be one the
  // 5-minute-idle session actually trips (or the line never prints), and one
  // that spans two units: a single-unit rendering would report 90s as "1m".
  const odd = agendo(mock.env, "status", SHORT_ID, "--stalled-after", "90s");
  expect(odd.status).toBe(0);
  expect(odd.stdout).toContain("threshold 1m30s");
});

test("agendo status rejects an unknown dashed argument instead of reading it as an id", async ({ mock }) => {
  // Previously any dashed junk fell through to the session-id slot and failed
  // with a baffling `No session found for "--stalled-after=1h"`. The inline GNU
  // form isn't supported here (list's flags don't take it either), so it must
  // name itself as the problem.
  const r = agendo(mock.env, "status", "--stalled-after=1h", SHORT_ID);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`unknown argument "--stalled-after=1h"`);
  expect(r.stderr).not.toContain("No session found");
});

test("unpushed work is read from .git refs — no `git` process, in status and --json", async ({ mock }) => {
  // The login session lives in a LINKED WORKTREE on feature/login: no configured
  // upstream and no origin/feature/login ref. Work that exists nowhere but this
  // checkout — which, next to "idle for hours", is the orchestrator's real
  // "unfinished work here" — but the wording stays hedged, because a branch
  // tracking a differently-named remote looks the same from here. (appweb's
  // config does carry a `[branch "master"]` section: loose section matching would
  // turn this honest "unknown" into a confident wrong answer.)
  const login = agendo(mock.env, "status", SHORT_ID);
  expect(login.status).toBe(0);
  expect(login.stdout).toContain("HEAD on feature/login");
  expect(login.stdout).toContain("no origin/feature/login ref and no configured upstream");
  expect(login.stdout).not.toContain("origin/master");
  expect(login.stdout).toContain("no fetch"); // says where the answer came from

  // The standalone checkout is on main, tracking a CONFIGURED origin/main whose
  // ref is PACKED (the packed-refs fallback) — and matching it.
  const standalone = agendo(mock.env, "status", STANDALONE_SHORT_ID);
  expect(standalone.status).toBe(0);
  expect(standalone.stdout).toContain("HEAD on main — matches origin/main");

  const r = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  expect(rows.find((x) => x.shortId === SHORT_ID).git).toEqual({
    branch: "feature/login",
    upstream: "origin/feature/login",
    upstreamConfigured: false,
    hasRemoteRef: false,
    unpushed: true,
  });
  expect(rows.find((x) => x.shortId === STANDALONE_SHORT_ID).git).toEqual({
    branch: "main",
    upstream: "origin/main",
    upstreamConfigured: true,
    hasRemoteRef: true,
    unpushed: false,
  });
  // Both of these sessions point at a worktree that is GONE (the routine
  // post-merge state) while its parent repo is a complete checkout on master.
  // That must read as null — "unknown" — and must NOT walk up and report the
  // parent's own master as this session's branch, which would be the most
  // misleading answer available.
  expect(rows.find((x) => x.shortId === COP_SHORT_ID).git).toBeNull();
  expect(rows.find((x) => x.shortId === CRASH_SHORT_ID).git).toBeNull();

  // Not one git invocation for ANY of the above — including the --json path
  // (the fake-bin shims log every call).
  expect((await mock.callLog()).some((l) => l.startsWith("git "))).toBe(false);
});

test("the rescan path never reaches the git-ref reader at all", async ({ mock }) => {
  // The no-`git`-spawn guard in launcher.spec only catches someone RE-IMPLEMENTING
  // this with a subprocess. The likelier regression is moving `branchSync` itself
  // into the index build — no spawn, but a handful of per-session reads on a 2s
  // timer across the whole session corpus, which is the CPU regression the parse
  // cache exists to prevent. A static import check is what actually pins that.
  //
  // Checked in the REVERSE direction — "who imports gitrefs" rather than "does
  // sessions.ts mention it". Whitelisting the importers is the only form of this
  // that holds: spot-checking sessions.ts/model.ts passes happily while the
  // reader sits one hop away in repos.ts or restore.ts, which those two DO import,
  // putting it back on the 2s timer with the guard still green.
  const ALLOWED = new Set(["index.tsx"]);
  const srcDir = join(REPO_ROOT, "src");
  const importers: string[] = [];
  for (const rel of await readdir(srcDir, { recursive: true })) {
    if (!/\.tsx?$/.test(rel)) continue;
    const src = await readFile(join(srcDir, rel), "utf-8");
    if (/from\s+"[^"]*gitrefs\.ts"/.test(src)) importers.push(rel);
  }
  expect(importers.length).toBeGreaterThan(0); // the reader is wired up at all
  expect(
    importers.filter((f) => !ALLOWED.has(f)),
    "only the one-shot CLI entrypoint may import src/gitrefs.ts — anything reachable from the rescan timer puts per-session ref reads back on it",
  ).toEqual([]);
});

test("a branch whose tip has moved past its tracking ref reads as unpushed", async ({ mock }) => {
  // Same standalone checkout, one commit further on than the packed origin/main.
  await writeFile(
    join(mock.home, "repos", "standalone", ".git", "refs", "heads", "main"),
    "4444444444444444444444444444444444444444\n",
  );
  const r = agendo(mock.env, "status", STANDALONE_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("differs from origin/main: unpushed or diverged");
});

test("a branch tracking a differently-NAMED remote and branch counts as pushed", async ({ mock }) => {
  // A fork, or a renamed remote: main's upstream is `upstream/renamed-main`, and
  // the work IS pushed there — while origin/main sits at an older tip. Assuming
  // origin/<same name> would call this fully-pushed work unpushed, which is the
  // false "unfinished work here" signal the whole feature exists to avoid.
  const gitDir = join(mock.home, "repos", "standalone", ".git");
  const tip = "4444444444444444444444444444444444444444\n";
  await writeFile(join(gitDir, "refs", "heads", "main"), tip);
  await mkdir(join(gitDir, "refs", "remotes", "upstream"), { recursive: true });
  await writeFile(join(gitDir, "refs", "remotes", "upstream", "renamed-main"), tip);
  await writeFile(
    join(gitDir, "config"),
    ['[branch "main"]', "\tremote = upstream", "\tmerge = refs/heads/renamed-main", ""].join("\n"),
  );

  const r = agendo(mock.env, "status", STANDALONE_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("HEAD on main — matches upstream/renamed-main");
  expect(r.stdout).not.toContain("unpushed");
});

test("a branch tracking its BASE branch still counts as pushed once its own remote ref matches", async ({ mock }) => {
  // What `git worktree add -b x` produces: the branch's configured upstream is
  // the base branch it forked from, not its own name. Once the work is pushed,
  // comparing only against that configured upstream would report the branch as
  // permanently "unpushed" — the exact false signal, in agendo's own workflow.
  await writeFile(
    join(mock.home, "repos", "standalone", ".git", "config"),
    ['[branch "main"]', "\tremote = origin", "\tmerge = refs/heads/master", ""].join("\n"),
  );
  const r = agendo(mock.env, "status", STANDALONE_SHORT_ID);
  expect(r.status).toBe(0);
  // origin/master doesn't exist here; origin/main does and matches the local tip.
  expect(r.stdout).toContain("HEAD on main — matches origin/main");
});

test("unpushed work is found from a session started in a SUBDIRECTORY of the checkout", async ({ mock }) => {
  // `cd src && claude` records the subdirectory verbatim as the session cwd, so
  // the ref lookup has to walk up to the checkout — otherwise the signal is
  // silently absent for every such session.
  const sub = join(mock.home, "repos", "standalone", "src");
  await mkdir(sub, { recursive: true });
  await writeSessionAt(mock.home, "sub-dir-session", sub, "Work started in a subdir");

  const r = agendo(mock.env, "status", shortIdOf("sub-dir-session"));
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("HEAD on main — matches origin/main");
});

test("a session outside any repo stays silent, even when $HOME itself is a checkout", async ({ mock }) => {
  // chezmoi / yadm / a bare dotfiles repo all make $HOME a checkout, and then an
  // unbounded walk-up resolves EVERY cwd that isn't in a repo to $HOME. The
  // answer wouldn't be "unknown", it would be a confident line about the user's
  // dotfiles — reported as this session's unpushed work. repos.ts stops at $HOME
  // for the same reason; the ref reader has to as well.
  await mkdir(join(mock.home, ".git", "refs", "heads"), { recursive: true });
  await writeFile(join(mock.home, ".git", "HEAD"), "ref: refs/heads/dotfiles\n");
  await writeFile(join(mock.home, ".git", "refs", "heads", "dotfiles"), "9999999999999999999999999999999999999999\n");
  const loose = join(mock.home, "scratch");
  await mkdir(loose, { recursive: true });
  await writeSessionAt(mock.home, "loose-session", loose, "Notes, not a repo");

  const r = agendo(mock.env, "status", shortIdOf("loose-session"));
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("work:");
  expect(r.stdout).not.toContain("dotfiles");

  const j = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(j.code).toBe(0);
  expect((JSON.parse(j.stdout) as any[]).find((x) => x.shortId === shortIdOf("loose-session")).git).toBeNull();
});

// ── `--path` / `--repo` scope selectors (list / status / wait) ───────────────
// `agendo list` reports every session on the machine, which forces an
// orchestrator watching one repo to post-filter the JSON itself. These selectors
// do it in the CLI instead. The fixture home has two repo roots holding sessions
// (appweb: login + crash, applib: the copilot experiment); the tests below seed a
// THIRD whose name has `appweb` as a strict string prefix — the boundary case a
// naive startsWith gets wrong in both directions.

const LEGACY_SESSION_ID = "9f3c1a7e-2b44-4d61-9c8f-5e7a0d1b6c22";
const LEGACY_SHORT_ID = shortIdOf(LEGACY_SESSION_ID);

/**
 * Write an extra idle Claude transcript into the fixture home, so a scope test
 * can place a session at an arbitrary cwd without touching the shared fixtures
 * (whose session set several other specs assert on exactly).
 */
async function seedSession(home: string, id: string, cwd: string, title: string): Promise<void> {
  const dir = join(home, ".claude", "projects", `scope-${id}`);
  await mkdir(dir, { recursive: true });
  const lines = [
    { type: "summary", cwd, gitBranch: "feature/legacy", timestamp: "2026-06-20T09:00:00.000Z" },
    { type: "ai-title", aiTitle: title, timestamp: "2026-06-20T09:00:01.000Z" },
    { type: "user", message: { role: "user", content: "port the old form" }, cwd, gitBranch: "feature/legacy", timestamp: "2026-06-20T09:00:05.000Z" },
  ];
  await writeFile(join(dir, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

/** Seed the `appweb-legacy` neighbour repo and return the two roots' paths. */
async function seedLegacyNeighbour(home: string) {
  const appweb = join(home, "repos", "appweb");
  const legacy = join(home, "repos", "appweb-legacy");
  await mkdir(join(legacy, ".git"), { recursive: true });
  await seedSession(home, LEGACY_SESSION_ID, join(legacy, ".claude", "worktrees", "port"), "Port the legacy form");
  return { appweb, legacy };
}

/** Short ids of `agendo list --all --json …`, the scoped listing under test. */
async function scopedIds(env: Record<string, string>, ...args: string[]): Promise<string[]> {
  const r = await agendoAsync(env, "list", "--all", "--json", ...args).done;
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { shortId: string }[]).map((x) => x.shortId);
}

test("agendo list --path scopes by cwd, and /repo never matches /repo-other", async ({ mock }) => {
  const { appweb, legacy } = await seedLegacyNeighbour(mock.home);

  // No selector → the sessions of all three repo roots, unfiltered.
  const everything = await scopedIds(mock.env);
  expect(everything).toEqual(expect.arrayContaining([SHORT_ID, CRASH_SHORT_ID, COP_SHORT_ID, LEGACY_SHORT_ID]));

  // --path appweb → its own sessions only. appweb-legacy is excluded even though
  // its path starts with appweb's: the match is segment-aware, not a prefix.
  const ids = await scopedIds(mock.env, "--path", appweb);
  expect(ids).toContain(SHORT_ID);
  expect(ids).toContain(CRASH_SHORT_ID);
  expect(ids).not.toContain(LEGACY_SHORT_ID); // the boundary case
  expect(ids).not.toContain(COP_SHORT_ID); // applib

  // …and the other direction: the neighbour scopes to itself alone.
  expect(await scopedIds(mock.env, "--path", legacy)).toEqual([LEGACY_SHORT_ID]);

  // Scoping is a pure narrowing — nothing appears that the unscoped list lacked.
  expect(everything).toEqual(expect.arrayContaining(ids));

  // A trailing slash and a `..` detour name the same scope (paths are
  // normalized). Built by concatenation, not path.join — join() would collapse
  // the `..` here in the test process and never send it to the CLI at all.
  const drifted = await scopedIds(mock.env, "--path", `${appweb}/../appweb//`);
  expect(drifted.sort()).toEqual([...ids].sort());
});

test("agendo list --repo attributes worktree sessions to their parent repo", async ({ mock }) => {
  await seedLegacyNeighbour(mock.home);

  // The login and crash sessions live in `<appweb>/.claude/worktrees/…`, never in
  // appweb itself — `repoRootForCwd` resolves a worktree back up to the repo it
  // belongs to, so --repo must find them there.
  const ids = await scopedIds(mock.env, "--repo", "appweb");
  expect(ids).toContain(SHORT_ID);
  expect(ids).toContain(CRASH_SHORT_ID);
  expect(ids).not.toContain(LEGACY_SHORT_ID); // same boundary, on the repo axis
  expect(ids).not.toContain(COP_SHORT_ID);

  // The neighbour is reachable by its own name, worktree session and all.
  expect(await scopedIds(mock.env, "--repo", "appweb-legacy")).toEqual([LEGACY_SHORT_ID]);

  // Copilot sessions scope like any other — this fixture matches through its
  // checkout. (The other half of the matcher, Copilot's recorded `repository`
  // remote standing in for a checkout that isn't there, is pinned on the shared
  // `sessionInScope` in detection.spec.ts's forWorkItem suite.)
  expect(await scopedIds(mock.env, "--repo", "applib")).toContain(COP_SHORT_ID);

  // Both axes together AND: appweb sessions that are also under the crash worktree.
  const crashWt = join(mock.home, "repos", "appweb", ".claude", "worktrees", "fix-crash-102");
  expect(await scopedIds(mock.env, "--repo", "appweb", "--path", crashWt)).toEqual([CRASH_SHORT_ID]);
});

test("agendo list --path/--repo scope the default running list too", async ({ mock }) => {
  // Same two-running-sessions setup as the `[dir]` positional test, proving the
  // flags reach the plain (model-free, running-only) listing as well as --json.
  const appweb = join(mock.home, "repos", "appweb");
  const applib = join(mock.home, "repos", "applib");
  const loginTarget = sessionName("claude", LOGIN_SESSION_ID);
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

  const byPath = agendo(mock.env, "list", "--path", appweb);
  expect(byPath.status).toBe(0);
  expect(byPath.stdout).toContain("Implement login form");
  expect(byPath.stdout).not.toContain("Experiment spike");

  const byRepo = agendo(mock.env, "list", "--repo", "applib");
  expect(byRepo.status).toBe(0);
  expect(byRepo.stdout).toContain("Experiment spike");
  expect(byRepo.stdout).not.toContain("Implement login form");
});

test("agendo status resolves the id only inside the requested scope", async ({ mock }) => {
  const appweb = join(mock.home, "repos", "appweb");

  // In scope → the normal status report (flags in any position around the id).
  const ok = agendo(mock.env, "status", "--repo", "appweb", SHORT_ID, "--full");
  expect(ok.status).toBe(0);
  expect(ok.stdout).toContain("Implement login form");

  const byPath = agendo(mock.env, "status", SHORT_ID, "--path", appweb);
  expect(byPath.status).toBe(0);
  expect(byPath.stdout).toContain("Implement login form");

  // Out of scope → refused, and the message names the scope that excluded it,
  // so a wrong --repo doesn't read as "that session is gone".
  const wrong = agendo(mock.env, "status", SHORT_ID, "--repo", "applib");
  expect(wrong.status).toBe(1);
  expect(wrong.stderr).toContain("No session found");
  expect(wrong.stderr).toContain("--repo applib");
});

test("agendo wait selects its targets by --path / --repo", async ({ mock }) => {
  // The default fixture has exactly one running session (login, under appweb).
  const inScope = agendo(mock.env, "wait", "--path", join(mock.home, "repos", "appweb"), "--timeout", "5s");
  expect(inScope.status).toBe(0);
  expect(inScope.stdout).toContain(SHORT_ID);
  expect(inScope.stdout).toContain("ready");

  // A repo whose sessions are all idle selects nothing to wait on, rather than
  // silently falling back to every session on the machine.
  const empty = agendo(mock.env, "wait", "--repo", "applib", "--timeout", "5s");
  expect(empty.status).not.toBe(0);
  expect(empty.stderr).toContain("no running sessions matched");
  expect(empty.stderr).toContain("--repo applib"); // the scope that emptied it
});

test("agendo wait applies the scope to --all and to explicit ids too", async ({ mock }) => {
  // The whole point of a scoping flag is that nothing quietly overrides it. Both
  // of these would silently wait on the wrong (larger) set if a selector took
  // precedence over the scope instead of narrowing within it.
  const allOutOfScope = agendo(mock.env, "wait", "--all", "--repo", "applib", "--timeout", "5s");
  expect(allOutOfScope.status).not.toBe(0);
  expect(allOutOfScope.stderr).toContain("no running sessions matched");

  const allInScope = agendo(mock.env, "wait", "--all", "--repo", "appweb", "--timeout", "5s");
  expect(allInScope.status).toBe(0);
  expect(allInScope.stdout).toContain(SHORT_ID);

  // An explicit id outside the scope is refused, matching `status`'s contract.
  const wrongId = agendo(mock.env, "wait", SHORT_ID, "--repo", "applib", "--timeout", "5s");
  expect(wrongId.status).not.toBe(0);
  expect(wrongId.stderr).toContain("no session found");
  expect(wrongId.stderr).toContain("--repo applib");

  // …and the pre-existing precedence between the OTHER two selectors is
  // untouched by folding them into one branch: --all still overrides --prefix.
  const allBeatsPrefix = agendo(mock.env, "wait", "--all", "--prefix", "nothing-matches-this", "--timeout", "5s");
  expect(allBeatsPrefix.status).toBe(0);
  expect(allBeatsPrefix.stdout).toContain(SHORT_ID);
});

test("the wait scope composes with --any and the --json wake payload", async ({ mock }) => {
  // `wait` owns its argv tail in wait.ts, so the scope has to compose with the
  // notification surface that lives there rather than sitting beside it: the
  // payload must describe the SCOPED target set, not every session on the box.
  const r = agendo(mock.env, "wait", "--all", "--any", "--json", "--repo", "appweb", "--timeout", "5s");
  expect(r.status).toBe(0);
  const payload = JSON.parse(r.stdout) as { woke: string; mode: string; sessions: { shortId: string }[] };
  expect(payload.woke).toBe("satisfied");
  expect(payload.mode).toBe("any");
  expect(payload.sessions.map((s) => s.shortId)).toEqual([SHORT_ID]);

  // Out of scope there is nothing to wait on, and a setup failure prints NO
  // payload even under --json — the contract #25 defined, kept under a scope.
  const empty = agendo(mock.env, "wait", "--all", "--any", "--json", "--repo", "applib", "--timeout", "5s");
  expect(empty.status).not.toBe(0);
  expect(empty.stdout.trim()).toBe("");
  expect(empty.stderr).toContain("--repo applib");
});

test("agendo list --pr/--issue queries are scoped too", async ({ mock }) => {
  // The query modes resolve sessions through the backend's associations rather
  // than the session index, so they take a separate code path — the scope has to
  // reach it as well, or `--pr N --repo X` would answer for the wrong repo.
  const inScope = await agendoAsync(mock.env, "list", "--pr", "5001", "--json", "--repo", "appweb").done;
  expect(inScope.code).toBe(0);
  expect((JSON.parse(inScope.stdout) as { shortId: string }[]).map((r) => r.shortId)).toEqual([SHORT_ID]);

  const outOfScope = await agendoAsync(mock.env, "list", "--pr", "5001", "--json", "--repo", "applib").done;
  expect(outOfScope.code).toBe(0);
  expect(JSON.parse(outOfScope.stdout)).toEqual([]);
});

test("agendo status under a scope declines the no-transcript-yet fallback", async ({ mock }) => {
  // A just-launched session has a live window but no transcript, and `status`
  // answers for it from the window alone. That window carries no cwd we can hold
  // against a scope, so under one we must decline rather than report on a
  // session that may well belong to another repo.
  const orphan = "cl-bg-abc123def456";
  await mock.setTmuxState({ ...tmuxState, sessions: [...tmuxState.sessions, orphan] });

  const unscoped = agendo(mock.env, "status", "abc123def456");
  expect(unscoped.status).toBe(0);
  expect(unscoped.stdout).toContain("may still be starting");

  const scoped = agendo(mock.env, "status", "abc123def456", "--repo", "appweb");
  expect(scoped.status).toBe(1);
  expect(scoped.stderr).toContain("No session found");
});

test("status/wait reject a mistyped scope flag instead of acting unscoped", async ({ mock }) => {
  // `--repo=appweb` and `--rep` are the realistic typos. Taking either as the id
  // (status) or as a bogus id (wait) would report unscoped, or blame the user for
  // a session that doesn't exist, instead of naming the actual mistake.
  for (const bad of ["--repo=appweb", "--rep"]) {
    const st = agendo(mock.env, "status", SHORT_ID, bad);
    expect(st.status).toBe(1);
    expect(st.stderr).toContain(`unknown argument "${bad}"`);

    const wt = agendo(mock.env, "wait", "--all", bad, "--timeout", "5s");
    expect(wt.status).toBe(1);
    expect(wt.stderr).toContain(`unknown argument "${bad}"`);
  }
});

test("agendo list refuses a [dir] positional and --path that disagree", async ({ mock }) => {
  const appweb = join(mock.home, "repos", "appweb");
  const applib = join(mock.home, "repos", "applib");
  // Both orders must fail, and with the SAME message — the mistake is naming the
  // path scope twice, not where in the argv the second one landed.
  for (const argv of [[appweb, "--path", applib], ["--path", applib, appweb]]) {
    const r = agendo(mock.env, "list", ...argv);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("path scope was given twice");
  }
});

test("an empty scoped listing says WHAT emptied it", async ({ mock }) => {
  // "No sessions." on its own reads as "nothing is running"; under a mistyped
  // --repo the truth is "nothing matched", and only the scope tells them apart.
  const r = await agendoAsync(mock.env, "list", "--all", "--repo", "no-such-repo").done;
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("No sessions in scope (--repo no-such-repo)");
});

test("a whitespace-only scope value is rejected, not treated as no scope", async ({ mock }) => {
  // `--repo "$UNSET_VAR "` must not quietly widen back to every session.
  const r = agendo(mock.env, "list", "--all", "--repo", "   ");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("needs a value");
});

test("a scope flag with no value is an error, not a silent unfiltered listing", async ({ mock }) => {
  for (const argv of [["list", "--repo"], ["list", "--path", "--json"], ["wait", "--path"], ["status", SHORT_ID, "--repo"]]) {
    const r = agendo(mock.env, ...argv);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("needs a value");
  }
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

test("a session parked at its usage cap is never stalled — it waits on a quota, not on us", async ({ mock }) => {
  // `limited` is stopped-but-not-DONE. The cap lifts by itself (auto-resume, or
  // `unblock`), and the row beside this already says when — so flagging it
  // stalled would point an orchestrator at the one session that needs no rescue,
  // and would put the marker in direct contradiction with `wait`, which refuses
  // to call a capped target settled and wakes with `woke: "blocked"` instead.
  // Both read the same predicate in tmux.ts, so there is only one answer.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });

  // 1ms: the threshold is not what's holding the flag back — the readiness is.
  const r = agendo(mock.env, "status", SHORT_ID, "--stalled-after", "1ms");
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("⚠ stalled");
  expect(r.stdout).toContain("ready:  limited"); // readiness itself is untouched
  expect(r.stdout).toContain("usage limit reached"); // …and still says why it stopped

  const plain = agendo(mock.env, "list", "--stalled-after", "1ms");
  expect(plain.status).toBe(0);
  expect(rowFor(plain.stdout, SHORT_ID)).toContain("limited");
  expect(rowFor(plain.stdout, SHORT_ID)).not.toContain("⚠stalled");

  const j = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1ms").done;
  expect(j.code).toBe(0);
  const login = (JSON.parse(j.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("limited");
  expect(login.stalled).toBe(false);
  expect(login.idleSeconds).toBeGreaterThan(1); // …despite being well past the threshold
  // It's the SETTLED test that spared it, not the resume-dialog exclusion — this
  // pane is a usage-limit notice, not claude's resume prompt.
  expect(login.resumeDialog).toBe(false);
});

// REAL captured limit panes (provenance in e2e/detection.spec.ts): raw
// `capture-pane -p -e` output from a live limited Claude Code session, SGR
// escapes intact, so `list` classifies and parses exactly what tmux would feed
// it. Both forms matter here:
//   - the esc-revealed TEXT notice, which states "resets 5pm (Atlantic/Reykjavik)";
//   - the numbered DIALOG with that notice scrolled off, which states no time at
//     all — and `list` must never press Escape to uncover it.
const fixturePane = (name: string) => readFileSync(join(REPO_ROOT, "e2e", "fixtures", name), "utf-8");
const REAL_LIMIT_PANE_WITH_TIME = fixturePane("limit-esc-revealed.ansi");
const REAL_LIMIT_PANE_NO_TIME = fixturePane("limit-dialog-menu.ansi")
  .split("\n")
  .filter((l) => !/hit your session limit/i.test(stripAnsi(l)))
  .join("\n");

/**
 * CLI env with the clock pinned, so the assertions don't depend on the CI box:
 * TZ=UTC (Atlantic/Reykjavik is UTC+0 year-round, so the fixture's "5pm" is
 * 17:00 UTC), and an explicit POSIX locale to choose 24h vs 12h.
 */
const withClock = (env: Record<string, string>, locale: string) => ({ ...env, TZ: "UTC", LC_ALL: locale });

test("agendo list shows when a limited session's limit resets (locale-formatted + ISO in --json)", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: REAL_LIMIT_PANE_WITH_TIME } });

  // 24-hour locale: the reset time rides next to the readiness word, and the
  // column is widened to fit it (two spaces before the kind cell, as elsewhere).
  const gb = agendo(withClock(mock.env, "en_GB.UTF-8"), "list");
  expect(gb.status).toBe(0);
  expect(gb.stdout).toMatch(/limited 17:00 {2}\S/);

  // Same instant, 12-hour locale — Intl picks the format, we never hand-roll it.
  const us = agendo(withClock(mock.env, "en_US.UTF-8"), "list");
  expect(us.status).toBe(0);
  expect(us.stdout).toMatch(/limited 5:00[\s ]PM {2}\S/);

  // --json carries the machine-readable instant instead: ISO 8601, UTC, no
  // localized text anywhere (other agents consume this).
  const r = await agendoAsync(withClock(mock.env, "en_US.UTF-8"), "list", "--all", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const login = rows.find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("limited");
  expect(login.limitResetAt).toMatch(/^\d{4}-\d{2}-\d{2}T17:00:00\.000Z$/);
  expect(Number.isNaN(Date.parse(login.limitResetAt))).toBe(false);
  expect(r.stdout).not.toMatch(/\d:\d{2}[\s ](AM|PM)/); // no localized clock in JSON
  // A session that isn't limited reports null, not a stale/placeholder value.
  const crash = rows.find((x) => x.shortId === CRASH_SHORT_ID);
  expect(crash.limitResetAt).toBeNull();
});

test("agendo list/status show how far a compacting session has got", async ({ mock }) => {
  // Compaction is blocking but PROGRESSING, and the pane says by how much — the
  // difference between "wait" and "stuck" for anyone reading the list. Same shape
  // as the limited row's reset time: appended to the readiness word, and carried
  // machine-readable in --json.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: COMPACTING_PANE } });

  const list = agendo(mock.env, "list");
  expect(list.status).toBe(0);
  expect(list.stdout).toMatch(/compacting 42% {2}\S/); // and the column stays aligned

  const status = agendo(mock.env, "status", SHORT_ID);
  expect(status.status).toBe(0);
  expect(status.stdout).toContain("compacting 42%");

  const r = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];
  const login = rows.find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("compacting");
  expect(login.compactionPercent).toBe(42);
  // A session that isn't compacting reports null, not a stale/placeholder value.
  expect(rows.find((x) => x.shortId === CRASH_SHORT_ID).compactionPercent).toBeNull();
});

test("a compacting pane with no progress bar yet reads plain 'compacting'", async ({ mock }) => {
  // The bar appears a beat after the verb line. Printing " 0%" there would be a
  // claim the screen has not made — the same rule the limited row follows when its
  // reset time is unreadable.
  const noBar = COMPACTING_PANE.split("\n").filter((l) => !l.includes("▰")).join("\n");
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: noBar } });

  const list = agendo(mock.env, "list");
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("compacting");
  expect(list.stdout).not.toMatch(/compacting\s+\d+%/);

  const r = await agendoAsync(mock.env, "list", "--all", "--json").done;
  const login = (JSON.parse(r.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("compacting");
  expect(login.compactionPercent).toBeNull();
});

test("agendo list renders a limited session with no parseable reset time as plain 'limited'", async ({ mock }) => {
  // The numbered dialog hides the reset time behind an Escape. `list` is strictly
  // read-only, so it reports what's on screen: "limited", no placeholder, no crash.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: REAL_LIMIT_PANE_NO_TIME } });

  const list = agendo(withClock(mock.env, "en_GB.UTF-8"), "list");
  expect(list.status).toBe(0);
  expect(list.stdout).toContain("limited");
  // Nothing but column padding follows the word — no time, no dash, no "unknown".
  expect(list.stdout).not.toMatch(/limited \S/);

  const r = await agendoAsync(withClock(mock.env, "en_GB.UTF-8"), "list", "--json").done;
  expect(r.code).toBe(0);
  const login = (JSON.parse(r.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("limited");
  expect(login.limitResetAt).toBeNull();

  // Strictly read-only: no keystroke was sent to reveal the timestamp.
  const tmux = await mock.tmuxLog();
  expect(tmux.some((argv) => argv[0] === "send-keys")).toBe(false);
});

test("agendo list leaves a session that isn't limited untouched", async ({ mock }) => {
  // Default fixture pane: idle/ready. The readiness column keeps its plain word
  // and its usual width — the reset-time suffix is limited-only.
  const r = agendo(withClock(mock.env, "en_GB.UTF-8"), "list");
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/ready {7}\S/); // "ready" padded to the standard 10, + the 2-space gap
  expect(r.stdout).not.toContain("limited");

  const j = await agendoAsync(withClock(mock.env, "en_GB.UTF-8"), "list", "--json").done;
  expect(j.code).toBe(0);
  const login = (JSON.parse(j.stdout) as any[]).find((x) => x.shortId === SHORT_ID);
  expect(login.readiness).toBe("ready");
  expect(login.limitResetAt).toBeNull();
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

// ── `agendo close` ───────────────────────────────────────────────────────────
// Ends a session by killing its tmux window and NOTHING else. Every test below
// runs against the fake tmux, which models real target resolution (window before
// session, exact → prefix → fnmatch unless pinned with `=`) and actually deletes
// what it matched — so a mistargeted kill shows up as the wrong entry vanishing.

/** Every kill argv the CLI issued, in order — whichever verb it used. */
const killsIn = (tmux: string[][]) =>
  tmux.filter((argv) => argv[0] === "kill-window" || argv[0] === "kill-session");

test("agendo close ends a running session and leaves worktree, branch and commits alone", async ({ mock }) => {
  // A worktree with uncommitted work in it, so "we didn't touch the filesystem"
  // is asserted against something real rather than an absent directory.
  const worktree = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, "WORK.txt"), "uncommitted work");

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`closed ${RUNNING_TARGET}`);
  expect(r.stdout).toContain("untouched");

  // Exactly one kill, `=`-pinned. This agent runs as its own detached tmux
  // session (the outside-tmux launch path), so the session is what's ended.
  const tmux = await mock.tmuxLog();
  expect(killsIn(tmux)).toEqual([["kill-session", "-t", `=${RUNNING_TARGET}`]]);
  // …and it really went: the target is no longer live.
  const after = await mock.getTmuxState();
  expect(after.sessions).not.toContain(RUNNING_TARGET);
  expect(agendo(mock.env, "list").stdout).toContain("No running sessions.");

  // THE GUARANTEE: nothing on disk was removed. No git ran at all (so certainly
  // no `worktree remove`), the worktree and its uncommitted file are still
  // there, and the transcript survives — so `resume` can bring the session back.
  const calls = await mock.callLog();
  expect(calls.some((l) => l.startsWith("git ") && l.includes("worktree"))).toBe(false);
  expect(existsSync(join(worktree, "WORK.txt"))).toBe(true);
  expect(existsSync(join(mock.home, ".claude", "projects", "appweb-login", `${LOGIN_SESSION_ID}.jsonl`))).toBe(true);
});

test("agendo close targets tmux by EXACT name — a prefix-colliding session survives (T1)", async ({ mock }) => {
  // Two live agent sessions whose names collide by prefix: `cl-claude-<crash>` ⊂
  // `cl-claude-<crash>x`. Per man tmux a target-session is matched exact → start
  // of name → fnmatch, "unless the session name is prefixed with an `=`" — so the
  // pin is what guarantees the shorter name can never resolve onto the longer
  // neighbour (which is what an unpinned target does the moment the exact one
  // dies between our listing and the kill).
  const canonical = `cl-claude-${CRASH_SHORT_ID}`;
  const neighbour = `${canonical}x`;
  await mock.setTmuxState({
    sessions: [canonical, neighbour],
    windows: [],
    panes: [
      { session: canonical, window: canonical, cwd: "/run/crash", placeholder: false },
      { session: neighbour, window: neighbour, cwd: "/run/other", placeholder: false },
    ],
    captures: {
      [canonical]: tmuxState.captures[RUNNING_TARGET],
      [neighbour]: tmuxState.captures[RUNNING_TARGET],
    },
  });

  const r = agendo(mock.env, "close", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`closed ${canonical}`);

  const tmux = await mock.tmuxLog();
  expect(killsIn(tmux)).toEqual([["kill-session", "-t", `=${canonical}`]]);
  // The right one died; the prefix-colliding neighbour is untouched.
  const after = await mock.getTmuxState();
  expect(after.sessions).toEqual([neighbour]);
  expect(after.panes.some((p: { session: string }) => p.session === neighbour)).toBe(true);
});

test("agendo close addresses a launcher TAB by session:index, for both the read and the kill", async ({ mock }) => {
  // A session running as a tab in the `agendo` host session, mid-turn.
  //
  // What this pins is the TARGET FORM, on both the read and the kill. A bare
  // `-t <window name>` is resolved inside ONE session only — the caller's current
  // one, or an arbitrary one when there is no client (man tmux: "if no current
  // session is available, the most recently used is chosen") — so addressed that
  // way from outside tmux, the pane read comes back empty (classifying "unknown",
  // which close treats as safe to kill) and the kill quietly hits nothing, with
  // `tmuxQuiet` swallowing the error. The stub has no notion of a current session
  // and resolves names globally, so it can't reproduce that miss; the argv
  // assertions below are what hold the `session:index` form in place.
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 3, name: RUNNING_TARGET },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: BUSY_PANE },
  });

  const busy = agendo(mock.env, "close", SHORT_ID);
  // Exit 2 is the REFUSAL code throughout close ("I could, but I won't"), as
  // distinct from 1 for an error/typo. Agents branch on it, so it's pinned
  // exactly here and at every other guard rather than as "non-zero".
  expect(busy.status).toBe(2);
  expect(busy.stderr).toContain("busy"); // the read reached the tab's real pane
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  // The pane was read through the tab's unambiguous, `=`-pinned location.
  expect((await mock.tmuxLog()).some((a) => a[0] === "capture-pane" && a.includes("=agendo:3"))).toBe(true);

  const forced = agendo(mock.env, "close", "-f", SHORT_ID);
  expect(forced.status).toBe(0);
  // The kill goes to the same location — not the bare window name.
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:3"]]);
  // Only the agent tab went: the host session and its menu window are untouched.
  const after = await mock.getTmuxState();
  expect(after.windows.map((w: { name: string }) => w.name)).toEqual(["launcher"]);
  expect(after.sessions).toEqual(["agendo"]);
});

test("agendo close won't kill a window that moved out from under the index it resolved", async ({ mock }) => {
  // Window indices are not stable handles: with `renumber-windows on` every index
  // above a closing window shifts down, and agent tabs exit on their own all the
  // time. Between resolving `agendo:3` and killing it, that index can come to mean
  // a different window — including the launcher's own menu. So the name at the
  // location is re-read immediately before the kill. `windowAt` is the stub's way
  // of expressing that mid-command divergence: the window list still places the
  // tab at agendo:3, but asking what's *at* agendo:3 now answers something else.
  // The command must refuse, kill nothing, and say why.
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [{ session: "agendo", index: 3, name: RUNNING_TARGET }],
    panes: [{ session: "agendo", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false }],
    captures: { [RUNNING_TARGET]: tmuxState.captures[RUNNING_TARGET] },
    // The window at agendo:3 is reported as something else entirely.
    windowAt: { "agendo:3": "someone-elses-shell" },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(1); // an error, not a refusal — nothing was killed
  expect(r.stderr).toContain("no longer it");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  expect((await mock.getTmuxState()).windows).toHaveLength(1); // nothing died
});

test("agendo close reports failure when tmux can't place the target", async ({ mock }) => {
  // tmux listed the pane a moment ago but can put it in neither a window nor a
  // session — so no kill was issued. Every tmux write here is fire-and-forget
  // (tmuxQuiet drops the exit status), so this is the case where "we asked" must
  // not be reported as "it's gone".
  await mock.setTmuxState({
    sessions: [],
    windows: [],
    panes: [{ session: "ghost", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false }],
    captures: { [RUNNING_TARGET]: tmuxState.captures[RUNNING_TARGET] },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Could not close");
  expect(r.stdout).not.toContain("closed");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
});

test("agendo close refuses when two launchers hold a window of the same name", async ({ mock }) => {
  // tmux allows duplicate window names and agendo produces them: a global
  // launcher and a path-scoped one can each hold a tab for the same session.
  // Reading the wrong one is harmless, killing it is not — and killing "the first
  // one tmux lists" would destroy a live agent in the other launcher.
  await mock.setTmuxState({
    sessions: ["agendo", "agendo-appweb"],
    windows: [
      { session: "agendo", index: 1, name: RUNNING_TARGET },
      { session: "agendo-appweb", index: 4, name: RUNNING_TARGET },
    ],
    panes: [
      { session: "agendo", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
      { session: "agendo-appweb", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: tmuxState.captures[RUNNING_TARGET] },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(2); // refusal
  expect(r.stderr).toContain("2 live windows are named");
  expect(r.stderr).toContain("agendo:1");
  expect(r.stderr).toContain("agendo-appweb:4");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  expect((await mock.getTmuxState()).windows).toHaveLength(2); // both still there
});

test("agendo close works on a session too new to have a transcript", async ({ mock }) => {
  // `agendo launch` prints the session id before the agent has written any log,
  // so the session index can't see it yet — but its window is named after that
  // very short id. Closing a launch that went wrong in its first seconds is the
  // flow this command exists for, so it must not fail with "No session found".
  //
  // Its restore tab was already written by `agendo launch`, under the CANONICAL
  // name (cl-claude-<id>) while the live window is in the launch namespace
  // (cl-bg-<id>) — same session, different prefix — so the tab must be matched by
  // the id it embeds or the closed session comes straight back as a placeholder.
  const sid = "abcdef123456";
  const fresh = `cl-bg-${sid}`;
  const restoreFile = join(mock.home, ".agendo", "restore", "agendo.json");
  await mkdir(join(mock.home, ".agendo", "restore"), { recursive: true });
  await writeFile(
    restoreFile,
    JSON.stringify({ tabs: [{ name: `cl-claude-${sid}`, cwd: "/run/fresh", title: "brand new", argv: ["claude", "--resume", sid] }] }, null, 2),
  );
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 5, name: fresh },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: fresh, cwd: "/run/fresh", placeholder: false },
    ],
    captures: { [fresh]: tmuxState.captures[RUNNING_TARGET] },
  });

  const r = agendo(mock.env, "close", sid);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(`closed ${fresh}`);
  // No `resume:` hint — there's no transcript for `resume` to find yet.
  expect(r.stdout).not.toContain("resume:");
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:5"]]);
  expect((await mock.getTmuxState()).windows.map((w: { name: string }) => w.name)).toEqual(["launcher"]);
  expect(JSON.parse(await readFile(restoreFile, "utf-8")).tabs).toEqual([]);
});

test("agendo close refuses an id-less window when two sessions share its directory", async ({ mock }) => {
  // A `cl-wi-…` window carries a WORK-ITEM id, not a session id, so it is
  // attributed to the most-recently-used session in its cwd. Give that cwd a
  // second, newer session and the attribution flips to it — while the agent
  // actually running in the window may still be the older one. Reading a pane on
  // that guess is harmless; killing it is not, so it takes --force.
  const loginCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
  await writeFile(
    join(mock.home, ".claude", "projects", "appweb-login", "second-session.jsonl"),
    [
      JSON.stringify({ type: "summary", cwd: loginCwd, gitBranch: "feature/login", timestamp: "2026-06-20T11:00:00.000Z" }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second session, same worktree" }, cwd: loginCwd, timestamp: "2026-06-20T11:00:05.000Z" }),
    ].join("\n") + "\n",
  );
  await mock.setTmuxState({
    ...tmuxState,
    sessions: ["cl-wi-101"],
    panes: [{ session: "cl-wi-101", window: "cl-wi-101", cwd: loginCwd, placeholder: false }],
    captures: { "cl-wi-101": tmuxState.captures[RUNNING_TARGET] },
  });

  const r = agendo(mock.env, "close", shortIdOf("second-session"));
  expect(r.status).toBe(2); // refusal
  expect(r.stderr).toContain("carries no session id");
  expect(r.stderr).toContain("sessions share");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);

  // --force closes that window anyway, for the caller who knows which it is.
  const forced = agendo(mock.env, "close", "-f", shortIdOf("second-session"));
  expect(forced.status).toBe(0);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-session", "-t", "=cl-wi-101"]]);
});

test("agendo close removes a dormant restore placeholder without reading its pane", async ({ mock }) => {
  // An unopened restore tab is an idle bash waiting for a keypress, not an agent:
  // there's no readiness to read and nothing in flight to lose, so it closes
  // without a pane verdict. The capture is deliberately a BUSY screen — if the
  // placeholder path ever started consulting it, this close would be refused.
  const crashTarget = `cl-claude-${CRASH_SHORT_ID}`;
  // The snapshot entry that PUT the placeholder on screen. Killing the window
  // without dropping this would bring the tab straight back on the next launcher
  // start — the close would look like it worked and quietly undo itself.
  const restoreFile = join(mock.home, ".agendo", "restore", "agendo.json");
  await mkdir(join(mock.home, ".agendo", "restore"), { recursive: true });
  await writeFile(
    restoreFile,
    JSON.stringify({ tabs: [{ name: crashTarget, cwd: "/run/crash", title: "Crash", argv: ["claude", "--resume", CRASH_SESSION_ID] }] }, null, 2),
  );
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 2, name: crashTarget },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: crashTarget, cwd: "/run/crash", placeholder: true },
    ],
    captures: { [crashTarget]: BUSY_PANE },
  });

  const r = agendo(mock.env, "close", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("unopened restore tab");
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:2"]]);
  expect((await mock.getTmuxState()).windows.map((w: { name: string }) => w.name)).toEqual(["launcher"]);
  // …and it stays closed: the tab that would respawn it is gone from the snapshot.
  expect(JSON.parse(await readFile(restoreFile, "utf-8")).tabs).toEqual([]);
});

test("agendo close also clears the closed session's leftover placeholder tab", async ({ mock }) => {
  // The session is running in a `cl-wi-…` window while an unopened restore tab
  // still squats its CANONICAL name in the same launcher — the state you get when
  // a restored tab was never woken and the session was resumed into a work-item
  // window instead. Killing only the live window leaves the closed session sitting
  // in the tab strip, one keypress from resurrecting itself.
  const loginCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
  await mock.setTmuxState({
    ...tmuxState,
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 3, name: "cl-wi-101", cwd: loginCwd },
      { session: "agendo", index: 4, name: RUNNING_TARGET, cwd: loginCwd, placeholder: true },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: "cl-wi-101", cwd: loginCwd, placeholder: false },
      { session: "agendo", window: RUNNING_TARGET, cwd: loginCwd, placeholder: true },
    ],
    captures: { "cl-wi-101": tmuxState.captures[RUNNING_TARGET] },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("closed cl-wi-101");
  // Both by location, the placeholder second — it's only chased once the real
  // window is confirmed dead.
  expect(killsIn(await mock.tmuxLog())).toEqual([
    ["kill-window", "-t", "=agendo:3"],
    ["kill-window", "-t", "=agendo:4"],
  ]);
  expect((await mock.getTmuxState()).windows.map((w: { name: string }) => w.name)).toEqual(["launcher"]);
});

test("agendo close leaves an identically-named placeholder in ANOTHER launcher alone", async ({ mock }) => {
  // Same shape, except the placeholder tab belongs to a second, path-scoped
  // launcher. Only the host session that held the killed window is in scope: we
  // don't edit the other launcher's restore snapshot, so killing its tab would
  // just make it come back on that launcher's next start — after having yanked a
  // visible tab out of someone else's strip.
  const loginCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "login");
  await mock.setTmuxState({
    ...tmuxState,
    sessions: ["agendo", "agendo-appweb"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 3, name: "cl-wi-101", cwd: loginCwd },
      { session: "agendo-appweb", index: 1, name: RUNNING_TARGET, cwd: loginCwd, placeholder: true },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: "cl-wi-101", cwd: loginCwd, placeholder: false },
      { session: "agendo-appweb", window: RUNNING_TARGET, cwd: loginCwd, placeholder: true },
    ],
    captures: { "cl-wi-101": tmuxState.captures[RUNNING_TARGET] },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(0);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:3"]]);
  // The other launcher's tab is still there.
  expect((await mock.getTmuxState()).windows.map((w: { name: string }) => w.name)).toEqual(["launcher", RUNNING_TARGET]);
});

test("agendo close refuses a busy session unless forced", async ({ mock }) => {
  // Mid-turn: killing here throws away the turn being written, so it takes an
  // explicit --force — the same bar `send` applies before typing into a pane.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(2); // refusal
  expect(r.stderr).toContain("busy"); // names the state it saw
  expect(killsIn(await mock.tmuxLog())).toEqual([]); // nothing was killed
  expect((await mock.getTmuxState()).sessions).toContain(RUNNING_TARGET);

  const forced = agendo(mock.env, "close", "--force", SHORT_ID);
  expect(forced.status).toBe(0);
  expect(forced.stdout).toContain(`closed ${RUNNING_TARGET}`);
  expect(forced.stdout).toContain(`(was "busy")`);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-session", "-t", `=${RUNNING_TARGET}`]]);
});

test("agendo close refuses when it cannot read the pane at all", async ({ mock }) => {
  // The pane read is the ONLY evidence guard 4 has, and a failed read produces
  // the same empty string a blank screen does — which classifies as "unknown"
  // and is treated as closeable. So the mid-turn session below (its capture is
  // BUSY, and would refuse if it were readable) must not be waved through just
  // because tmux couldn't answer.
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 3, name: RUNNING_TARGET },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: "/repos", placeholder: false },
      { session: "agendo", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: BUSY_PANE },
    captureFails: { "=agendo:3": true },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(2); // refusal
  expect(r.stderr).toContain("could not read");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  expect((await mock.getTmuxState()).windows).toHaveLength(2); // nothing died

  // --force closes it unread, for the caller who has decided anyway.
  const forced = agendo(mock.env, "close", SHORT_ID, "--force");
  expect(forced.status).toBe(0);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo:3"]]);
});

test("agendo close refuses a session holding an unsent draft", async ({ mock }) => {
  // Text typed but not submitted reads "queued" — closing would silently discard
  // it, so it's held to the same --force bar as a mid-turn session.
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: GHOST_PANE },
    cursors: {
      [RUNNING_TARGET]: { x: GHOST_PROMPT_CURSOR.x + "wait for the review, then commit and open the PR".length, y: 2 },
    },
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(2); // refusal
  expect(r.stderr).toContain("queued");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
});

test("agendo close refuses an unknown target and kills nothing", async ({ mock }) => {
  // A typo must never reach tmux: with no session behind the id there is nothing
  // agendo can vouch for, so it stops before any kill (a bare `tmux kill-window
  // -t no-such-session` would have fnmatched onto whatever was live).
  const r = agendo(mock.env, "close", "no-such-session");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No session found");
  expect(r.stderr).toContain("refusing to close anything");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  expect((await mock.getTmuxState()).sessions).toContain(RUNNING_TARGET);

  // Unknown flags are rejected too, rather than swallowed by a kill command.
  const bad = agendo(mock.env, "close", SHORT_ID, "--yolo");
  expect(bad.status).toBe(1);
  expect(bad.stderr).toContain("unknown flag");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
});

test("agendo close on an idle session is a no-op success", async ({ mock }) => {
  // The crash session exists on disk but has no live window — the desired end
  // state already holds, so close reports it and exits 0 (idempotent for scripts).
  const r = agendo(mock.env, "close", CRASH_SHORT_ID);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("not running");
  expect(killsIn(await mock.tmuxLog())).toEqual([]);
  expect((await mock.getTmuxState()).sessions).toContain(RUNNING_TARGET);
});

test("agendo kill / agendo stop are aliases for close", async ({ mock }) => {
  // An agent that guesses the wrong verb must not fall back to raw tmux.
  const killed = agendo(mock.env, "kill", SHORT_ID);
  expect(killed.status).toBe(0);
  expect(killed.stdout).toContain(`closed ${RUNNING_TARGET}`);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-session", "-t", `=${RUNNING_TARGET}`]]);

  // `stop` resolves the same way; the session is gone now, so it reports that.
  const stopped = agendo(mock.env, "stop", SHORT_ID);
  expect(stopped.status).toBe(0);
  expect(stopped.stdout).toContain("not running");
});

test("agendo close drops the session's restore tab from that host only", async ({ mock }) => {
  // The login session as a TAB in a PATH-SCOPED host session (`agendo-appweb`),
  // whose snapshot holds it plus another tab — while the global `agendo` launcher
  // has a snapshot of its own. Closing here must edit exactly one file: the tab of
  // the window that was killed, in the snapshot of the host that held it.
  const other = { name: "cl-claude-elsewhere", cwd: "/run/elsewhere", title: "Other", argv: ["claude", "--resume", "elsewhere"] };
  const loginTab = { name: RUNNING_TARGET, cwd: "/run/login", title: "Implement login form", argv: ["claude", "--resume", LOGIN_SESSION_ID] };
  const restoreDir = join(mock.home, ".agendo", "restore");
  await mkdir(restoreDir, { recursive: true });
  await writeFile(join(restoreDir, "agendo-appweb.json"), JSON.stringify({ tabs: [loginTab, other] }, null, 2));
  // The global launcher's own snapshot — a different launcher's tabs, off limits.
  await writeFile(join(restoreDir, "agendo.json"), JSON.stringify({ tabs: [loginTab] }, null, 2));
  await mock.setTmuxState({
    ...tmuxState,
    sessions: ["agendo-appweb"],
    windows: [{ session: "agendo-appweb", index: 1, name: RUNNING_TARGET }],
    panes: [{ session: "agendo-appweb", window: RUNNING_TARGET, cwd: "/run/login", placeholder: false }],
  });

  const r = agendo(mock.env, "close", SHORT_ID);
  expect(r.status).toBe(0);
  expect(killsIn(await mock.tmuxLog())).toEqual([["kill-window", "-t", "=agendo-appweb:1"]]);
  // This host's snapshot lost only this session's tab…
  expect(JSON.parse(await readFile(join(restoreDir, "agendo-appweb.json"), "utf-8")).tabs).toEqual([other]);
  // …and the other launcher's snapshot is untouched.
  expect(JSON.parse(await readFile(join(restoreDir, "agendo.json"), "utf-8")).tabs).toEqual([loginTab]);
});

test("a wait on a session closed underneath it ends as exited, not a hang", async ({ mock }) => {
  // The two commands an orchestrator runs against the same session, composed for
  // real: `wait` blocking on a busy session while `close` ends it. The window
  // disappearing is the ONLY thing that can wake this wait — nothing settles it —
  // so if close and wait disagreed about what a closed session looks like, this
  // would sit there until the timeout and report a spurious failure.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "200ms", "--timeout", "20s");
  await sleep(1200); // let it establish the session as live + busy first

  const closed = agendo(mock.env, "close", SHORT_ID, "--force");
  expect(closed.status).toBe(0);

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("satisfied");
  // A clear terminal verdict — "exited", not the "ready" a settled session gets
  // and not the "unknown" an unreadable pane used to produce.
  expect(out.sessions[0].state).toBe("exited");
  expect(out.sessions[0].from).toBe("busy");
  expect(out.elapsedMs).toBeLessThan(20_000);
});

test("a wait for a state the closed session never reached fails loudly", async ({ mock }) => {
  // The other half of "no false success": closing a session must not look like it
  // reached whatever the waiter was waiting FOR. `--state ready` can never hold
  // for a session killed mid-turn, so the wait has to end non-zero and say why —
  // an exit 0 here would tell an orchestrator its work finished cleanly when it
  // was actually cut off mid-turn.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { done } = agendoAsync(
    mock.env, "wait", SHORT_ID, "--state", "ready", "--json", "--interval", "200ms", "--timeout", "60s",
  );
  await sleep(1200);

  expect(agendo(mock.env, "close", SHORT_ID, "--force").status).toBe(0);

  const r = await done;
  expect(r.code).not.toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("unsatisfiable");
  expect(out.sessions[0].state).toBe("exited");
  expect(out.sessions[0].satisfied).toBe(false);
  // Woken by the close, not by burning the 60s timeout.
  expect(out.elapsedMs).toBeLessThan(30_000);
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

// ── wait as a notification primitive ─────────────────────────────────────────
// `wait` exists so an orchestrator can be TOLD a background session changed
// instead of re-polling `status` on a guessed cadence. These pin the wake
// contract: the transitions that must fire, the ones that must NOT, and the
// payload a caller reads to learn what it woke up to.

/** Parse the `--json` wake payload off stdout. */
function wakePayload(stdout: string) {
  return JSON.parse(stdout) as {
    woke: string;
    condition: string;
    mode: string;
    elapsedMs: number;
    sessions: {
      shortId: string; state: string; from: string; changed: boolean; satisfied: boolean; title: string;
      limitResetAt: string | null; resumeDialog: boolean;
    }[];
  };
}

test("agendo wait --json reports the busy → ready transition it woke on", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { child, done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "200ms", "--timeout", "20s");
  // `from` is whatever the FIRST poll saw, so flip to ready only once the process
  // has reported seeing it busy. A fixed sleep would silently decide this
  // assertion's meaning by how fast the CLI booted.
  await whenStderrMatches(child, /pending: \w+=busy/);
  await mock.setTmuxState(tmuxState); // → ready

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("satisfied");
  expect(out.mode).toBe("all");
  expect(out.sessions).toHaveLength(1);
  const [s] = out.sessions;
  // The caller learns not just the destination but the transition — which is the
  // whole reason it woke up, and what a bare `<id>\t<state>` line can't say.
  expect(s.shortId).toBe(SHORT_ID);
  expect(s.from).toBe("busy");
  expect(s.state).toBe("ready");
  expect(s.changed).toBe(true);
  expect(s.satisfied).toBe(true);
  expect(s.title).toBe("Implement login form");
});

test("agendo wait --json distinguishes a resume-dialog wake from a finished turn", async ({ mock }) => {
  // Both report state "ready" — that's the point of the feature — so without a
  // flag saying which, an orchestrator woken here reads back the PREVIOUS run's
  // final answer and believes the work is done. `--state dialog` doesn't cover
  // this either: the resume dialog deliberately isn't a question for a human.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: RESUME_DIALOG_PANE } });
  const parked = agendo(mock.env, "wait", SHORT_ID, "--json", "--interval", "150ms", "--timeout", "5s");
  expect(parked.status).toBe(0); // it IS available — waking is right
  const [p] = wakePayload(parked.stdout).sessions;
  expect(p.state).toBe("ready");
  expect(p.resumeDialog).toBe(true);

  // …and a genuinely idle session is not mislabelled by the same field.
  await mock.setTmuxState(tmuxState);
  const idle = agendo(mock.env, "wait", SHORT_ID, "--json", "--interval", "150ms", "--timeout", "5s");
  expect(idle.status).toBe(0);
  const [i] = wakePayload(idle.stdout).sessions;
  expect(i.state).toBe("ready");
  expect(i.resumeDialog).toBe(false);
});

test("agendo wait does not fire while nothing changes", async ({ mock }) => {
  // Pane sits ready the whole time and we wait for `busy`, which never happens.
  // A wake here would be spurious — the caller would burn a turn on a non-event.
  const r = agendo(mock.env, "wait", SHORT_ID, "--state", "busy", "--json", "--interval", "150ms", "--timeout", "900ms");
  expect(r.status).not.toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("timeout");
  const [s] = out.sessions;
  expect(s.state).toBe("ready");
  expect(s.changed).toBe(false);
  expect(s.satisfied).toBe(false);
});

test("agendo wait accepts --state limited", async ({ mock }) => {
  // `limited` is a real readiness that the accepted-values list used to omit,
  // making "wake me when it hits its usage cap" unreachable.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  const r = agendo(mock.env, "wait", SHORT_ID, "--state", "limited", "--interval", "150ms", "--timeout", "5s");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("limited");
});

test("agendo wait does NOT call a usage-limited session settled", async ({ mock }) => {
  // A capped session has stopped, but it is not DONE — it comes back when the
  // window reopens (auto-resume) or when someone unblocks it. Exit 0 here would
  // tell an orchestrator the work finished, while `agendo list` shows that very
  // session as "limited 17:00", i.e. back later. The two must not disagree.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  // A generous timeout: waking must come from the cap being seen, not from the
  // deadline — a wait that just times out leaves the caller blind for the whole
  // 30m an orchestrator typically asks for.
  const r = agendo(withClock(mock.env, "en_GB.UTF-8"), "wait", SHORT_ID, "--json", "--interval", "150ms", "--timeout", "10s");
  expect(r.status).not.toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("blocked");
  // Woke on the state, not the deadline — two confirming ticks at 150ms, nowhere
  // near the 10s timeout. (A wait that just times out is the blindness this
  // whole branch exists to avoid, so the margin is the assertion.)
  expect(out.elapsedMs).toBeLessThan(3_000);
  expect(out.condition).toBe("settled (not busy, limited or unknown)");
  const [s] = out.sessions;
  expect(s.state).toBe("limited");
  expect(s.satisfied).toBe(false);
  // The reset instant rides along, so the caller can back off until then without
  // a second command — the same instant `list --json` reports for that session.
  expect(s.limitResetAt).toMatch(/^\d{4}-\d{2}-\d{2}T19:20:00\.000Z$/);
  expect(r.stderr).toContain("at usage limit");
  expect(r.stderr).toContain("19:20");
});

test("agendo wait needs two consecutive limited sightings before reporting blocked", async ({ mock }) => {
  // `blocked` is terminal, and `limited` has a real transient: the Escape the TUI
  // sends to reveal the reset notice uncovers a pane that reads `limited` for a
  // tick or two while the session is being un-capped. Waking off ONE sighting
  // would report a session as blocked at the moment it recovered — the same
  // reasoning as EXIT_CONFIRM_TICKS. Sequenced off the tmux call log rather than
  // a timer, so exactly one poll sees the limit notice.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "1500ms", "--timeout", "20s");
  const log = mock.env.FAKE_TMUX_LOG!;
  for (let i = 0; i < 600; i++) {
    try {
      if (readFileSync(log, "utf-8").includes('"capture-pane"')) break;
    } catch {}
    await sleep(20);
  }
  await mock.setTmuxState(tmuxState); // → ready, before the second tick lands

  const r = await done;
  expect(r.code).toBe(0);
  expect(wakePayload(r.stdout).woke).toBe("satisfied");
});

test("agendo wait: an explicit --state is never pre-empted by the cap", async ({ mock }) => {
  // "--state exited: tell me when it is completely FINISHED" must keep polling
  // through a usage cap — the session comes back when the window reopens, and
  // waking it with `blocked` would answer a question the caller didn't ask.
  // Same for `--not limited`, which literally means "wake me when the cap clears".
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });

  const exited = agendo(mock.env, "wait", SHORT_ID, "--state", "exited", "--json", "--interval", "150ms", "--timeout", "1200ms");
  expect(exited.status).not.toBe(0);
  const outExited = wakePayload(exited.stdout);
  expect(outExited.woke).toBe("timeout"); // waited it out, NOT "blocked"
  expect(outExited.sessions[0].state).toBe("limited");

  const notLimited = agendo(mock.env, "wait", SHORT_ID, "--not", "limited", "--json", "--interval", "150ms", "--timeout", "1200ms");
  expect(notLimited.status).not.toBe(0);
  expect(wakePayload(notLimited.stdout).woke).toBe("timeout");
});

test("agendo wait --any does not report blocked while another target can still settle", async ({ mock }) => {
  // The mode rule, mirroring `unsatisfiable`: --any needs only ONE target, so a
  // capped one is no reason to wake while a live one is still working. The
  // default mode is the opposite — a single capped straggler blocks the set.
  const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
  const twoLive = {
    ...tmuxState,
    sessions: [RUNNING_TARGET, CRASH_TARGET],
    panes: [
      ...tmuxState.panes,
      { session: CRASH_TARGET, window: CRASH_TARGET, cwd: "/run/crash", placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: LIMIT_PANE, [CRASH_TARGET]: BUSY_PANE },
  };
  await mock.setTmuxState(twoLive);

  // --any: login is capped, crash is busy → must NOT wake; it settles only when
  // crash goes ready.
  const { done } = agendoAsync(mock.env, "wait", "--all", "--any", "--json", "--interval", "200ms", "--timeout", "25s");
  await sleep(1200);
  await mock.setTmuxState({ ...twoLive, captures: { [RUNNING_TARGET]: LIMIT_PANE, [CRASH_TARGET]: tmuxState.captures[RUNNING_TARGET] } });
  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("satisfied");
  expect(out.sessions.find((s) => s.shortId === CRASH_SHORT_ID)?.state).toBe("ready");
  expect(out.sessions.find((s) => s.shortId === SHORT_ID)?.state).toBe("limited");

  // Default mode over the same pair: ALL must settle, so the capped one blocks —
  // and the wake names it (with its reset time), not the busy one.
  const all = agendo(withClock(mock.env, "en_GB.UTF-8"), "wait", "--all", "--json", "--interval", "200ms", "--timeout", "10s");
  expect(all.status).not.toBe(0);
  const outAll = wakePayload(all.stdout);
  expect(outAll.woke).toBe("blocked");
  expect(outAll.elapsedMs).toBeLessThan(5_000);
  const line = all.stderr.split("\n").find((l) => l.includes("at usage limit"));
  expect(line).toContain(SHORT_ID);
  expect(line).not.toContain(CRASH_SHORT_ID);
});

test("agendo wait --not busy counts a capped session as satisfied", async ({ mock }) => {
  // Only the DEFAULT predicate rejects `limited`. An explicit predicate is
  // honoured verbatim — `--state limited` (above) and `--not busy` both mean the
  // caller has said what success is, so the cap satisfies it and exits 0.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_PANE } });
  const r = agendo(mock.env, "wait", SHORT_ID, "--not", "busy", "--json", "--interval", "150ms", "--timeout", "5s");
  expect(r.status).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("satisfied");
  expect(out.condition).toBe("≠ busy");
  expect(out.sessions[0].satisfied).toBe(true);
});

test("agendo wait wakes when a session's window closes, instead of timing out", async ({ mock }) => {
  // The commonest orchestrator wait: "tell me when the background session is
  // DONE". A finished agent closes its window, leaving no pane to capture — which
  // used to read `unknown` forever and report a spurious timeout.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "200ms", "--timeout", "20s");
  await sleep(1200);
  await mock.setTmuxState({ ...tmuxState, sessions: [], panes: [], captures: {} });

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("satisfied");
  expect(out.sessions[0].state).toBe("exited");
  expect(out.sessions[0].changed).toBe(true);
});

test("agendo wait needs two consecutive missed sightings before declaring a session exited", async ({ mock }) => {
  // Every tmux read maps a non-zero exit to an empty result, so ONE unlucky tick
  // (server busy, fork failure, restart) empties the live set for ALL targets. If
  // that alone meant `exited`, the default predicate would be satisfied and `wait`
  // would exit 0 reporting "done" for a session still mid-turn — and because
  // `exited` is terminal, nothing later could correct it. So an absence must
  // repeat before it's believed.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { child, done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "400ms", "--timeout", "30s");
  // Take the window away only once the process has REPORTED a live sighting, so
  // every poll after this point is genuinely a miss.
  //
  // A fixed head start instead raced the child's FIRST POLL. One poll is four
  // separate fake-tmux process spawns, and `liveWindows` is built solely from the
  // `list-panes` pass — so a wipe landing after the startup liveness read but
  // before that pass makes poll #1 a miss. The run then needs two polls, not
  // three, and the >1400ms floor this used to assert could not be met, going red
  // for a wait that had behaved exactly as designed. (A wipe landing even
  // earlier, before `runWait`'s own pre-loop liveness read, fails differently:
  // "not running (no live window)" — so the window that produced the red build
  // was specifically inside poll #1's read burst.)
  await whenStderrMatches(child, /pending: \w+=busy/);
  await mock.setTmuxState({ ...tmuxState, sessions: [], panes: [], captures: {} });

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.sessions[0].state).toBe("exited");
  // The rule itself, COUNTED rather than timed: the run reported at least one
  // `unknown` poll — a miss it declined to believe — before the `exited` verdict.
  // Zero is precisely what a single-miss bug produces: the first absence would
  // satisfy the predicate and return, so no `unknown` line is ever printed (the
  // earlier `busy` ones still are). A duration could never tell those apart,
  // because how long the run takes depends on how fast it booted and how many
  // live sightings preceded the wipe, not on how many misses it required.
  const states = pendingStates(r.stderr);
  expect(states.filter((s) => s === "unknown").length).toBeGreaterThanOrEqual(1);
  expect(states.at(-1)).toBe("unknown");
  expect(states).toContain("busy"); // …and the sighting before the misses was live
});

test("agendo wait counts a repeated id once, so one missed sighting still can't confirm exit", async ({ mock }) => {
  // The miss counter is keyed by session id, so the same session listed twice
  // used to bump it twice per tick and reach the two-miss threshold on the FIRST
  // absence — under `--any` that satisfied the predicate and returned exit 0
  // reporting `exited` for a session that had merely been missed once. That is
  // the very failure the threshold exists to prevent, reintroduced through the
  // target list, and a script composing ids (`wait $A $B`, both resolving here)
  // hits it without doing anything unusual.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { child, done } = agendoAsync(
    mock.env, "wait", SHORT_ID, LOGIN_SESSION_ID, "--any", "--json", "--interval", "400ms", "--timeout", "30s",
  );
  await whenStderrMatches(child, /pending: \w+=busy/);
  await mock.setTmuxState({ ...tmuxState, sessions: [], panes: [], captures: {} });

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  // One target, not two — and the caller isn't handed the same session twice
  // with contradictory states to reconcile.
  expect(out.sessions).toHaveLength(1);
  expect(out.sessions[0].state).toBe("exited");
  // …and the absence still had to repeat before it was believed.
  expect(pendingStates(r.stderr).filter((s) => s === "unknown").length).toBeGreaterThanOrEqual(1);
});

test("agendo wait gives up early on a --state an exited session can never reach", async ({ mock }) => {
  // Nothing can change after the window is gone, so burning the full timeout is
  // pointless — wake now with a reason the caller can act on.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--state", "ready", "--json", "--interval", "200ms", "--timeout", "60s");
  await sleep(1200);
  await mock.setTmuxState({ ...tmuxState, sessions: [], panes: [], captures: {} });

  const r = await done;
  expect(r.code).not.toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("unsatisfiable");
  // Well inside the 60s timeout: it short-circuited rather than waiting it out.
  expect(out.elapsedMs).toBeLessThan(30_000);
});

test("agendo wait --any wakes on the first session to settle; the default waits for all", async ({ mock }) => {
  // Two live sessions: login is ready, crash is stuck busy. An orchestrator
  // watching both must not have the stuck one mask the settled one.
  const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
  const twoLive = {
    ...tmuxState,
    sessions: [RUNNING_TARGET, CRASH_TARGET],
    panes: [
      ...tmuxState.panes,
      { session: CRASH_TARGET, window: CRASH_TARGET, cwd: "/run/crash", placeholder: false },
    ],
    captures: { ...tmuxState.captures, [CRASH_TARGET]: BUSY_PANE },
  };
  await mock.setTmuxState(twoLive);

  const any = agendo(mock.env, "wait", "--all", "--any", "--json", "--interval", "150ms", "--timeout", "5s");
  expect(any.status).toBe(0);
  const out = wakePayload(any.stdout);
  expect(out.woke).toBe("satisfied");
  expect(out.mode).toBe("any");
  // Both are reported, so the caller can see WHICH one woke it.
  expect(out.sessions).toHaveLength(2);
  expect(out.sessions.filter((s) => s.satisfied).map((s) => s.shortId)).toEqual([SHORT_ID]);
  expect(out.sessions.find((s) => s.shortId === CRASH_SHORT_ID)?.state).toBe("busy");

  // Without --any the stuck session holds the wait open until the timeout.
  const all = agendo(mock.env, "wait", "--all", "--interval", "150ms", "--timeout", "900ms");
  expect(all.status).not.toBe(0);
  expect(all.stderr).toContain("timed out");
});

test("agendo wait gives up when ONE of several targets exits under a state it can't reach", async ({ mock }) => {
  // Waiting for ALL targets to hit `ready`: once one of them exits it can never
  // get there, so the predicate is unreachable even though another session is
  // still working. Polling on to the timeout here would reintroduce exactly the
  // stall the `exited` state exists to remove — and note this can't be caught by
  // the DEFAULT predicate, which `exited` satisfies.
  const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
  const twoLive = {
    ...tmuxState,
    sessions: [RUNNING_TARGET, CRASH_TARGET],
    panes: [
      ...tmuxState.panes,
      { session: CRASH_TARGET, window: CRASH_TARGET, cwd: "/run/crash", placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: BUSY_PANE, [CRASH_TARGET]: BUSY_PANE },
  };
  await mock.setTmuxState(twoLive);

  const { done } = agendoAsync(
    mock.env, "wait", "--all", "--state", "ready", "--json", "--interval", "200ms", "--timeout", "60s",
  );
  await sleep(1200);
  // Drop ONLY the login session's window; the crash session keeps running busy.
  await mock.setTmuxState({
    ...twoLive,
    sessions: [CRASH_TARGET],
    panes: [{ session: CRASH_TARGET, window: CRASH_TARGET, cwd: "/run/crash", placeholder: false }],
    captures: { [CRASH_TARGET]: BUSY_PANE },
  });

  const r = await done;
  expect(r.code).not.toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("unsatisfiable");
  expect(out.elapsedMs).toBeLessThan(30_000); // nowhere near the 60s timeout
  expect(out.sessions.find((s) => s.shortId === SHORT_ID)?.state).toBe("exited");
  expect(out.sessions.find((s) => s.shortId === CRASH_SHORT_ID)?.state).toBe("busy");
  // The give-up line names only the dead session, not every still-pending one.
  const gaveUp = r.stderr.split("\n").find((l) => l.includes("gave up"));
  expect(gaveUp).toContain(SHORT_ID);
  expect(gaveUp).not.toContain(CRASH_SHORT_ID);
});

test("agendo wait --any keeps waiting when one target exits but another can still settle", async ({ mock }) => {
  // The mirror of the case above: --any only needs ONE target, so a dead one is
  // not a reason to give up while a live one could still reach the state.
  const CRASH_TARGET = sessionName("claude", CRASH_SESSION_ID);
  const twoLive = {
    ...tmuxState,
    sessions: [RUNNING_TARGET, CRASH_TARGET],
    panes: [
      ...tmuxState.panes,
      { session: CRASH_TARGET, window: CRASH_TARGET, cwd: "/run/crash", placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: BUSY_PANE, [CRASH_TARGET]: BUSY_PANE },
  };
  await mock.setTmuxState(twoLive);

  const { done } = agendoAsync(
    mock.env, "wait", "--all", "--any", "--state", "ready", "--json", "--interval", "200ms", "--timeout", "25s",
  );
  // Login exits (can never be `ready`) while crash is still busy — must NOT wake.
  await sleep(1000);
  const loginGone = {
    ...twoLive,
    sessions: [CRASH_TARGET],
    panes: [{ session: CRASH_TARGET, window: CRASH_TARGET, cwd: "/run/crash", placeholder: false }],
    captures: { [CRASH_TARGET]: BUSY_PANE },
  };
  await mock.setTmuxState(loginGone);
  // …then the survivor settles, which is the wake it was waiting for.
  await sleep(1000);
  await mock.setTmuxState({ ...loginGone, captures: { [CRASH_TARGET]: tmuxState.captures[RUNNING_TARGET] } });

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.woke).toBe("satisfied");
  expect(out.sessions.find((s) => s.shortId === CRASH_SHORT_ID)?.state).toBe("ready");
  expect(out.sessions.find((s) => s.shortId === SHORT_ID)?.state).toBe("exited");
});

test("agendo wait prints nothing on stdout when it fails (non-JSON)", async ({ mock }) => {
  // The pre-existing contract: `<id>\t<state>` lines mean "it settled". Emitting
  // them on a timeout too would make scripts that test for non-empty stdout read
  // a failed wait as success.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const timedOut = agendo(mock.env, "wait", SHORT_ID, "--interval", "150ms", "--timeout", "600ms");
  expect(timedOut.status).not.toBe(0);
  expect(timedOut.stdout.trim()).toBe("");
  expect(timedOut.stderr).toContain("timed out");

  // …while a successful wait still prints them.
  await mock.setTmuxState(tmuxState); // pane back to ready
  const settled = agendo(mock.env, "wait", SHORT_ID, "--interval", "150ms", "--timeout", "5s");
  expect(settled.status).toBe(0);
  expect(settled.stdout).toContain(`${SHORT_ID}\tready`);
});

test("agendo wait --repo only watches sessions in that repo", async ({ mock }) => {
  // The login session's worktree resolves back to the `appweb` repo root, so a
  // watcher scoped to a different repo must not fire for it.
  const other = agendo(mock.env, "wait", "--repo", "applib", "--interval", "150ms", "--timeout", "3s");
  expect(other.status).not.toBe(0);
  expect(other.stderr).toContain("no running sessions matched");

  const mine = agendo(mock.env, "wait", "--repo", "appweb", "--json", "--interval", "150ms", "--timeout", "5s");
  expect(mine.status).toBe(0);
  const out = wakePayload(mine.stdout);
  expect(out.sessions.map((s) => s.shortId)).toEqual([SHORT_ID]);
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

// ── `launch` agent-flag forwarding ───────────────────────────────────────────
// `agendo launch` forwards a small allowlist of agent flags (--model,
// --fallback-model) into the NEW session's argv, and rejects anything else
// dashed. Every case runs with --no-worktree so no git worktree is created (the
// fake git would mkdir one inside the real checkout), and the fake tmux records
// the full `new-session … -- <agent argv>` we'd have spawned.

/** The agent argv of the last `new-session`/`new-window` (everything after `--`). */
function spawnedAgentArgv(tmux: string[][]): string[] | undefined {
  const call = [...tmux].reverse().find((argv) => argv[0] === "new-session" || argv[0] === "new-window");
  if (!call) return undefined;
  const sep = call.indexOf("--", 1);
  return sep >= 0 ? call.slice(sep + 1) : undefined;
}

test("agendo launch forwards --model into the new claude's argv", async ({ mock }) => {
  const r = agendo(mock.env, "launch", "--no-worktree", "--model", "opus", "do the thing");
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("launched background session");

  const argv = spawnedAgentArgv(await mock.tmuxLog())!;
  expect(argv[0]).toBe("claude");
  // The flag pair is forwarded verbatim, adjacent, alongside the usual autonomy
  // flags and the prompt.
  expect(argv.join(" ")).toContain("--model opus");
  expect(argv).toContain("--permission-mode"); // background autonomy still applied
  expect(argv).toContain("do the thing");
});

test("agendo launch forwards --model to copilot too, and keeps multi-word values intact", async ({ mock }) => {
  // Both agents take `--model <name>` with identical syntax, so no translation.
  // The value is one argv token — tmux execs the argv directly (no shell), so a
  // value with spaces survives without quoting.
  const r = agendo(mock.env, "launch", "--no-worktree", "--copilot", "--model", "claude sonnet 4.5", "spike it");
  expect(r.status).toBe(0);

  const argv = spawnedAgentArgv(await mock.tmuxLog())!;
  expect(argv[0]).toBe("copilot");
  const at = argv.indexOf("--model");
  expect(at).toBeGreaterThan(0);
  expect(argv[at + 1]).toBe("claude sonnet 4.5"); // still a single, unsplit token
  expect(argv).toContain("--autopilot");
});

test("agendo launch rejects a forwarded flag the chosen agent doesn't support", async ({ mock }) => {
  // --fallback-model is Claude-only; copilot has no equivalent, so it must fail
  // rather than hand the copilot binary a flag it doesn't know. The agent can be
  // named after the flag, so the check runs on the fully parsed argv.
  const r = agendo(mock.env, "launch", "--no-worktree", "--fallback-model", "sonnet", "--copilot", "spike it");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("--fallback-model isn't supported by --agent copilot");
  expect(spawnedAgentArgv(await mock.tmuxLog())).toBeUndefined(); // nothing spawned

  // With claude (the default) the same flag is accepted and forwarded.
  const ok = agendo(mock.env, "launch", "--no-worktree", "--fallback-model", "sonnet", "spike it");
  expect(ok.status).toBe(0);
  expect(spawnedAgentArgv(await mock.tmuxLog())!.join(" ")).toContain("--fallback-model sonnet");
});

test("agendo launch accepts the GNU --flag=value form for forwarded flags", async ({ mock }) => {
  // Both agent CLIs take `--model=opus`, so the habit must not hit the
  // unknown-flag error. It normalizes to the same two-token pair on the way out.
  const r = agendo(mock.env, "launch", "--no-worktree", "--model=opus", "--agent=copilot", "do the thing");
  expect(r.status).toBe(0);

  const argv = spawnedAgentArgv(await mock.tmuxLog())!;
  expect(argv[0]).toBe("copilot"); // `--agent=copilot` parsed too
  expect(argv.join(" ")).toContain("--model opus");
  expect(argv).not.toContain("--model=opus");

  // An inline value may itself start with dashes — unlike the two-token form,
  // there's nothing ambiguous about it.
  const dashed = agendo(mock.env, "launch", "--no-worktree", "--model=--weird", "do it");
  expect(dashed.status).toBe(0);
  expect(spawnedAgentArgv(await mock.tmuxLog())!.join(" ")).toContain("--model --weird");
});

test("agendo launch fails when a forwarded flag has no value", async ({ mock }) => {
  const missing = agendo(mock.env, "launch", "--no-worktree", "--model");
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("--model needs a value");

  // The inline form with an empty value is just as wrong.
  const empty = agendo(mock.env, "launch", "--no-worktree", "--model=", "do it");
  expect(empty.status).toBe(1);
  expect(empty.stderr).toContain("--model needs a value");

  // Another flag in the value slot is a mistake too, not a model named "--attach".
  const swallowed = agendo(mock.env, "launch", "--no-worktree", "--model", "--attach", "do it");
  expect(swallowed.status).toBe(1);
  expect(swallowed.stderr).toContain("--model needs a value");
  expect(spawnedAgentArgv(await mock.tmuxLog())).toBeUndefined();
});

test("agendo launch rejects unknown dashed flags instead of folding them into the prompt", async ({ mock }) => {
  // A typo'd flag used to become prompt text ("--modle opus do the thing"); now
  // it's a clean error naming what may be forwarded.
  const r = agendo(mock.env, "launch", "--no-worktree", "--modle", "opus", "do the thing");
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('unknown flag "--modle"');
  expect(r.stderr).toContain("--model"); // lists the forwardable flags
  expect(spawnedAgentArgv(await mock.tmuxLog())).toBeUndefined();

  // `--` remains the escape hatch for prompt text that legitimately starts with
  // dashes: everything after it is prompt, never parsed as flags.
  const escaped = agendo(mock.env, "launch", "--no-worktree", "--", "--modle", "is", "a", "typo");
  expect(escaped.status).toBe(0);
  const argv = spawnedAgentArgv(await mock.tmuxLog())!;
  expect(argv).toContain("--modle is a typo");
  expect(argv).not.toContain("--model");
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

// ── full entity URLs + `agendo open` ─────────────────────────────────────────
// Bare "PR 5001 / WI 101" identifiers force any consumer (a human, or an agent
// reporting back to one) to hand-assemble a link, which is exactly where the
// wrong ADO host/path shape creeps in. These pin the full URLs through the CLI,
// built by the provider's canonical builders (unit-pinned in provider.spec.ts)
// off the mock server's ADO_BASE_URL and the fixture project name ("Widgets").

/** The URLs the ADO fixtures must produce, given the mock server's base URL. */
const adoUrls = (baseUrl: string) => ({
  pr5001: `${baseUrl}/Widgets/_git/appweb/pullrequest/5001`,
  wi101: `${baseUrl}/_workitems/edit/101`,
  wi102: `${baseUrl}/_workitems/edit/102`,
});

test("agendo list --json carries full prUrl / workItemUrl per session", async ({ mock }) => {
  const U = adoUrls(mock.ado.baseUrl);
  const r = await agendoAsync(mock.env, "list", "--all", "--json").done;
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.stdout) as any[];

  const login = rows.find((x) => x.shortId === SHORT_ID);
  // Flattened top-level fields, and the nested objects agree with them.
  expect(login.prUrl).toBe(U.pr5001);
  expect(login.workItemUrl).toBe(U.wi101);
  expect(login.pr.url).toBe(U.pr5001);
  expect(login.workItem.url).toBe(U.wi101);

  // The crash session resolves only a work item — its PR fields are null, not a
  // half-built URL a consumer might paste.
  const crash = rows.find((x) => x.shortId === CRASH_SHORT_ID);
  expect(crash.workItemUrl).toBe(U.wi102);
  expect(crash.prUrl).toBeNull();

  // A session with nothing linked reports null for both.
  const standalone = rows.find((x) => x.shortId === STANDALONE_SHORT_ID);
  expect(standalone).toBeTruthy();
  expect(standalone.prUrl).toBeNull();
  expect(standalone.workItemUrl).toBeNull();
  expect(standalone.pr).toBeNull();
  expect(standalone.workItem).toBeNull();
});

test("the link fields and the idle/stall fields are SIBLINGS on the row, and stay out of the table", async ({ mock }) => {
  // Two features landed on the same row from opposite directions. The failure
  // that would look fine in a spot check is one nesting inside the other — the
  // stall fields hidden under `pr`, or the URLs tucked into `git` — which no
  // consumer of either feature would find.
  const U = adoUrls(mock.ado.baseUrl);
  const r = await agendoAsync(mock.env, "list", "--all", "--json", "--stalled-after", "1m").done;
  expect(r.code).toBe(0);
  const login = (JSON.parse(r.stdout) as any[]).find((x) => x.shortId === SHORT_ID);

  // One flat row: every field of both features is a direct key on it.
  for (const k of ["idleSeconds", "stalled", "stalledAfterSeconds", "git", "resumeDialog", "limitResetAt", "prUrl", "workItemUrl"]) {
    expect(Object.hasOwn(login, k), `${k} must be a top-level row field`).toBe(true);
  }
  expect(login.prUrl).toBe(U.pr5001);
  expect(login.stalled).toBe(true);
  // …and neither feature's data hides inside the other's object.
  expect(Object.hasOwn(login.pr, "stalled")).toBe(false);
  expect(login.git === null || !Object.hasOwn(login.git, "prUrl")).toBe(true);

  // The human table keeps the short forms (`!5001`, `#101`): a full URL in a
  // fixed-width row would push the title — and the ⚠stalled marker beside it —
  // off the end. URLs are for --json, `status --urls` and `open`.
  const table = await agendoAsync(mock.env, "list", "--all", "--stalled-after", "1m").done;
  expect(table.code).toBe(0);
  expect(table.stdout).not.toContain("http");
  expect(rowFor(table.stdout, SHORT_ID)).toContain("!5001");
  expect(rowFor(table.stdout, SHORT_ID)).toContain("⚠stalled");
});

test("agendo status --urls prints the linked PR + work-item URLs", async ({ mock }) => {
  const U = adoUrls(mock.ado.baseUrl);
  const r = await agendoAsync(mock.env, "status", SHORT_ID, "--urls").done;
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`pr:     !5001   ${U.pr5001}`);
  expect(r.stdout).toContain(`wi:     #101    ${U.wi101}`);

  // Default `status` stays link-free (and backend-free) — the URLs are opt-in.
  const plain = agendo(mock.env, "status", SHORT_ID);
  expect(plain.status).toBe(0);
  expect(plain.stdout).not.toContain(U.pr5001);
});

test("agendo status --urls on an unlinked session says so instead of inventing a link", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "status", STANDALONE_SHORT_ID, "--urls").done;
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("no linked PR or work item");
  expect(r.stdout).not.toContain("_workitems/edit");
});

test("agendo open launches the browser at the session's PR and prints both URLs", async ({ mock }) => {
  const U = adoUrls(mock.ado.baseUrl);
  const r = await agendoAsync(mock.env, "open", SHORT_ID).done;
  expect(r.code).toBe(0);
  // Both links are printed — the URL is the deliverable, the browser is a bonus.
  expect(r.stdout).toContain(U.pr5001);
  expect(r.stdout).toContain(U.wi101);
  expect(r.stdout).toContain("opened PR !5001");
  // …and it went through the real opener path (the fake xdg-open records it).
  expect(await mock.callLog()).toContain(`xdg-open ${U.pr5001}`);
});

test("agendo open --work-item opens the work item instead of the PR", async ({ mock }) => {
  const U = adoUrls(mock.ado.baseUrl);
  const r = await agendoAsync(mock.env, "open", SHORT_ID, "--work-item").done;
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("opened work item #101");
  const log = await mock.callLog();
  expect(log).toContain(`xdg-open ${U.wi101}`);
  expect(log).not.toContain(`xdg-open ${U.pr5001}`);
});

test("agendo open --print emits the URLs without launching anything", async ({ mock }) => {
  const U = adoUrls(mock.ado.baseUrl);
  const r = await agendoAsync(mock.env, "open", SHORT_ID, "--print").done;
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(U.pr5001);
  expect(r.stdout).toContain(U.wi101);
  expect((await mock.callLog()).some((l) => l.startsWith("xdg-open"))).toBe(false);
});

test("agendo open on a session with no linked entity fails cleanly (no stack trace)", async ({ mock }) => {
  const r = await agendoAsync(mock.env, "open", STANDALONE_SHORT_ID).done;
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no linked pull request or work item");
  // A clean message, not a crash: no thrown-error noise, and no browser attempt.
  expect(r.stderr).not.toContain("at ");
  expect(r.stderr).not.toContain("TypeError");
  expect((await mock.callLog()).some((l) => l.startsWith("xdg-open"))).toBe(false);
});

test("agendo open --pr on a work-item-only session names what IS available", async ({ mock }) => {
  // The crash session resolves a work item but no PR; asking for the PR must be a
  // clear message pointing at the other flag, not a silent open of the wrong thing.
  const r = await agendoAsync(mock.env, "open", CRASH_SHORT_ID, "--pr").done;
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no linked pull request");
  expect(r.stderr).toContain("work item #102");
  expect((await mock.callLog()).some((l) => l.startsWith("xdg-open"))).toBe(false);
});

test("agendo open degrades gracefully where no browser exists (headless)", async ({ mock }) => {
  // AGENDO_BROWSER points the opener at a binary that isn't there — the same
  // ENOENT a headless container hits with no xdg-open installed. It must neither
  // hang nor crash: the URL is still printed, the failure is a stderr warning.
  const U = adoUrls(mock.ado.baseUrl);
  const env = { ...mock.env, AGENDO_BROWSER: "/nonexistent/no-such-opener" };
  const r = await agendoAsync(env, "open", SHORT_ID).done;
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(U.pr5001);
  expect(r.stderr).toContain("Couldn't launch a browser");
  expect(r.stderr).toContain("the URL above is still valid");
});

test("agendo open --print survives a reader that closes the pipe early", async ({ mock }) => {
  // `agendo open <id> --print | head -1` is a natural way to grab just the PR
  // link. head exits after the first line, so the remaining writes hit EPIPE —
  // that must stay a clean exit, not an unhandled rejection with a stack trace.
  const U = adoUrls(mock.ado.baseUrl);
  // Async spawn: the mock ADO server is in-process, so a blocking spawnSync
  // would freeze the event loop and the CLI's fetches could never be answered.
  const script = `bun run ${JSON.stringify(join(REPO_ROOT, "src", "index.tsx"))} open ${SHORT_ID} --print | head -1`;
  const child = spawn("bash", ["-c", script], { cwd: REPO_ROOT, env: mock.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const r = await new Promise<{ stdout: string; stderr: string }>((res) =>
    child.on("close", () => res({ stdout, stderr })),
  );
  expect(r.stdout).toContain(U.pr5001);
  expect(r.stderr).not.toContain("EPIPE");
  expect(r.stderr).not.toContain("broken pipe");
});

test("agendo open resolves the id only inside the requested scope", async ({ mock }) => {
  // Same selectors, same meaning as `status --path/--repo`: they narrow the set
  // the id resolves against. Opening the wrong repo's PR in a browser is worse
  // than printing the wrong status, so the guard has to hold here too.
  const U = adoUrls(mock.ado.baseUrl);
  const inScope = await agendoAsync(mock.env, "open", SHORT_ID, "--print", "--repo", "appweb").done;
  expect(inScope.code).toBe(0);
  expect(inScope.stdout).toContain(U.pr5001);

  const byPath = await agendoAsync(
    mock.env, "open", SHORT_ID, "--print", "--path", join(mock.home, "repos", "appweb"),
  ).done;
  expect(byPath.code).toBe(0);
  expect(byPath.stdout).toContain(U.pr5001);

  // Out of scope → refused, naming the scope that excluded it, and nothing opened.
  const wrong = await agendoAsync(mock.env, "open", SHORT_ID, "--repo", "applib").done;
  expect(wrong.code).toBe(1);
  expect(wrong.stderr).toContain("No session found");
  expect(wrong.stderr).toContain("--repo applib");
  expect((await mock.callLog()).some((l) => l.startsWith("xdg-open"))).toBe(false);

  // A scope flag with no value is an error, not a silently unscoped open.
  const noValue = agendo(mock.env, "open", SHORT_ID, "--repo");
  expect(noValue.status).toBe(1);
  expect(noValue.stderr).toContain("--repo");
});

test("agendo open on an unknown id / with no id fails cleanly", async ({ mock }) => {
  const unknown = await agendoAsync(mock.env, "open", "no-such-session").done;
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("No session found");

  // No id → one actionable usage line. The program prefix is SELF_CMD, which
  // deliberately adapts to how agendo was invoked (the bare name when it's
  // installed on PATH, `bunx`/`npx agendo` under a package runner, else the
  // literal argv — see src/launch.ts), so pinning a literal "agendo" here only
  // holds on machines that happen to have it installed. What IS the contract:
  // a single `usage:` line, behind a genuinely re-invokable prefix, naming the
  // subcommand form and every flag it takes.
  const noId = agendo(mock.env, "open");
  expect(noId.status).toBe(1);
  // stripAnsiText: the mock env forces color, so bun wraps console.error output
  // in SGR codes — harmless for `toContain`, fatal for an anchored match.
  const usage = stripAnsiText(noId.stderr).trim();
  expect(usage.split("\n")).toHaveLength(1); // a usage line, never a stack trace
  expect(usage).toMatch(
    /^usage: (agendo|bunx agendo|npx agendo|.+\bindex\.tsx) open <id> \[--pr \| --work-item\] \[--print\] \[--path <dir>\] \[--repo <name>\]$/,
  );

  const badFlag = agendo(mock.env, "open", SHORT_ID, "--nope");
  expect(badFlag.status).toBe(1);
  expect(badFlag.stderr).toContain('unknown argument "--nope"');

  // Two conflicting entity selectors is a mistake, not a silent last-one-wins.
  const both = agendo(mock.env, "open", SHORT_ID, "--pr", "--work-item");
  expect(both.status).toBe(1);
  expect(both.stderr).toContain("only one of");
});

test("agendo open (GitHub) resolves the issue/PR links from the GitHub builders", async ({ mock }) => {
  await seedGitHubList(mock);
  const r = await agendoAsync(mock.env, "open", SHORT_ID, "--print").done;
  expect(r.code).toBe(0);
  // Provider vocab follows the backend: '#' PR prefix and "issue", not "wi".
  expect(r.stdout).toContain("https://github.com/ada/appweb/pull/401");
  expect(r.stdout).toContain("https://github.com/ada/appweb/issues/301");
  expect(r.stdout).toContain("#401");
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

test("--help documents orchestrator mode but --llm does NOT hand it to agents", async ({ mock }) => {
  // Humans get the full documentation.
  const help = agendo(mock.env, "--help");
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("--orchestrator, -O");
  expect(help.stdout).toContain("ORCHESTRATOR MODE");
  expect(help.stdout).toContain("--unattended");

  // Agents do not. `repoRootForCwd` walks a worktree back up to its parent repo,
  // so an agent sandboxed in a worktree that learned this flag from the guide
  // could start a session in the human's MAIN checkout — one instructed to merge
  // branches there. The guide is read by every launched session, so advertising
  // the flag there is a self-service escalation path; keep it human-initiated.
  const llm = agendo(mock.env, "--llm");
  expect(llm.status).toBe(0);
  expect(llm.stdout).not.toContain("--orchestrator");
  expect(llm.stdout).not.toContain("--unattended");
  // The guide still works for its actual purpose.
  expect(llm.stdout).toContain("launch");
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
  // Autonomy flags are NOT applied by default. An orchestrator acts on the user's
  // main checkout (merging branches into it) and spawns further sessions, so
  // auto-approving it hands all of that over unreviewed. Ordinary background
  // sessions keep their autonomy — they're sandboxed in a throwaway worktree.
  expect(spawned!).not.toContain("--permission-mode");

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

test("--unattended is the explicit opt-in that restores an orchestrator's autonomy", async ({ mock }) => {
  // The safe default must stay reachable-past: unattended orchestration is a real
  // use (leave it running overnight), it just has to be asked for by name.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "--unattended", "Run it overnight");
  expect(r.status).toBe(0);
  const tmux = await mock.tmuxLog();
  const spawned = tmux.find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  expect(spawned).toBeTruthy();
  expect(spawned!).toContain("--permission-mode");
  // Still an orchestrator, not a plain autonomous session.
  expect(appendedPrompt(spawned!)).toContain("ORCHESTRATOR MODE");
});

test("--unattended without --orchestrator is refused rather than silently ignored", async ({ mock }) => {
  // A plain background session is already unattended, so accepting the flag here
  // would read as "that changed something" when it changed nothing.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--unattended", "Do a thing");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("--unattended only applies with --orchestrator");
  expect((await mock.tmuxLog()).some((argv) => argv[0] === "new-session")).toBe(false);
});

test("--orchestrator rejects an inline value instead of guessing at it", async ({ mock }) => {
  // It's a boolean flag: `--orchestrator=false` reads as "off" to a human, but a
  // bare presence check would turn orchestrator mode ON. Refuse, never guess.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator=false", "Do a thing");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("--orchestrator takes no value");
  expect((await mock.tmuxLog()).some((argv) => argv[0] === "new-session")).toBe(false);
});

test("-O=<value> is refused too, rather than sliding into the prompt", async ({ mock }) => {
  // Single-dash args fall through to positionals (they never reach the
  // unknown-flag guard, which only inspects `--`-prefixed ones), so without an
  // explicit check `-O=false` would launch a plain session whose prompt starts
  // with "-O=false" — no error, no orchestrator, no clue why.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "-O=false", "Do a thing");
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("--orchestrator takes no value");
  expect((await mock.tmuxLog()).some((argv) => argv[0] === "new-session")).toBe(false);
});

test("--orchestrator and --model compose: both are carried, neither is mistaken for the other", async ({ mock }) => {
  // Regression guard for the rebase that merged orchestrator mode with the
  // forwarded-agent-flags feature: `orchestrator` (boolean) and `forwardArgv`
  // (string[]) are adjacent options, and a transposed union would either drop
  // --model or land an array in the boolean slot — turning every --model launch
  // into an orchestrator. Assert both directions.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "--orchestrator", "--model", "opus", "Coordinate it");
  expect(r.status).toBe(0);
  const tmux = await mock.tmuxLog();
  const spawned = tmux.find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  expect(spawned).toBeTruthy();
  // The orchestrator framing is there…
  expect(appendedPrompt(spawned!)).toContain("ORCHESTRATOR MODE");
  // …and the forwarded flag survived alongside it, as an adjacent pair.
  expect(spawned!.join(" ")).toContain("--model opus");
  expect(spawned!).toContain("Coordinate it");
});

test("a plain --model launch is NOT silently promoted to an orchestrator", async ({ mock }) => {
  // The inverse of the above: the hazard is asymmetric, so check the common path.
  const r = agendo(mock.env, "launch", "--no-worktree", "--model", "opus", "just implement it");
  expect(r.status).toBe(0);
  const argv = spawnedAgentArgv(await mock.tmuxLog())!;
  expect(appendedPrompt(argv)).not.toContain("ORCHESTRATOR MODE");
  // And it kept ordinary background autonomy — orchestrator-only prompting must
  // not leak onto every launch that happens to pass a forwarded flag.
  expect(argv).toContain("--permission-mode");
});

test("-O survives the unknown-flag guard and really launches an orchestrator", async ({ mock }) => {
  // Single-dash args fall through to positionals, so a dropped `-O` branch would
  // silently fold the flag into the prompt and launch an ordinary session.
  const r = agendoIn(mockRepo(mock.home), mock.env, "launch", "-O", "Coordinate the rewrite");
  expect(r.status).toBe(0);
  const tmux = await mock.tmuxLog();
  const spawned = tmux.find((argv) => argv[0] === "new-session" && argv.includes("claude"));
  expect(appendedPrompt(spawned!)).toContain("ORCHESTRATOR MODE");
  // And it didn't end up as prompt text.
  expect(spawned!).toContain("Coordinate the rewrite");
  expect(spawned!).not.toContain("-O Coordinate the rewrite");
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
