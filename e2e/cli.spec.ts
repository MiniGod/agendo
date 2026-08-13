// Coverage for the `agendo` CLI (src/index.tsx subcommands): --help, --llm, list,
// status, send. These don't render the TUI, so they run the entrypoint directly
// as a child process against the same mocked environment (fake az/tmux/git,
// fixture $HOME). The fake tmux serves a stored pane capture for the running
// session, so readiness classification is real — including the compacting state.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { COPILOT_SESSION_ID, CRASH_SESSION_ID, LOGIN_SESSION_ID, RUNNING_TARGET, tmuxState, sessionName } from "./harness/fixtures.ts";
import { stripAnsi as stripAnsiText } from "../src/tmux.ts";

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
  return spawnSync("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], {
    cwd: REPO_ROOT,
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
