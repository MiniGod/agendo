// Coverage for the `agendo` CLI (src/index.tsx subcommands): --help, --llm, list,
// status, send. These don't render the TUI, so they run the entrypoint directly
// as a child process against the same mocked environment (fake az/tmux/git,
// fixture $HOME). The fake tmux serves a stored pane capture for the running
// session, so readiness classification is real — including the compacting state.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { BUSY_PANE, COPILOT_SESSION_ID, CRASH_SESSION_ID, LOGIN_SESSION_ID, RUNNING_TARGET, STANDALONE_SESSION_ID, tmuxState, sessionName } from "./harness/fixtures.ts";
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
  expect(r.stdout).toContain(`sent to ${RUNNING_TARGET}`);
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
  expect(r.stdout).toContain(`sent to ${RUNNING_TARGET}`);

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
      resumeDialog: boolean;
    }[];
  };
}

test("agendo wait --json reports the busy → ready transition it woke on", async ({ mock }) => {
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } });
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "200ms", "--timeout", "20s");
  await sleep(1200);
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
  const { done } = agendoAsync(mock.env, "wait", SHORT_ID, "--json", "--interval", "800ms", "--timeout", "30s");
  await sleep(400); // first poll has already seen it alive and busy
  await mock.setTmuxState({ ...tmuxState, sessions: [], panes: [], captures: {} });

  const r = await done;
  expect(r.code).toBe(0);
  const out = wakePayload(r.stdout);
  expect(out.sessions[0].state).toBe("exited");
  // Two polls at 800ms apart had to miss it. A single-miss verdict would have
  // woken around the first one, well under this bound.
  expect(out.elapsedMs).toBeGreaterThan(1_400);
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
