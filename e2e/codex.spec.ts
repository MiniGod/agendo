// `agendo send` and `agendo wait` against a codex pane.
//
// Send runs against the fake tmux's simulated codex (state.codexSim, see
// e2e/fakebin/tmux): a real codex 0.163 capture whose input box and run-state
// are redrawn from what has been pasted and pressed, with knobs for the races
// that lost messages — a paste codex takes several reads to show, an Enter it
// swallows, a completion popup that eats the Enter, a message held in the box
// while codex starts up. Every race is counted in pane reads rather than
// milliseconds, so each one replays the same way on every run.
//
// Wait runs against the real 0.163 captures (e2e/fixtures/codex163-*.ansi),
// which the classifier read as "unknown" before this: a hint row under the
// status bar, so `wait` never settled.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import { REPO_ROOT } from "./harness/mockEnv.ts";
import { CODEX_SESSION_ID, RUNNING_TARGET, sessionName, tmuxState } from "./harness/fixtures.ts";
import { windowTarget } from "../src/runtime/tmux/index.ts";

const CODEX_TARGET = sessionName("codex", CODEX_SESSION_ID);
const CODEX_SHORT = CODEX_TARGET.replace(/^cl-codex-/, "");
// How agendo addresses the window, which is what a `captureQueue` is keyed by.
const CODEX_LOCATION = windowTarget(RUNNING_TARGET, CODEX_TARGET);
const fixture = (name: string) => readFileSync(join(REPO_ROOT, "e2e", "fixtures", name), "utf-8");

function agendoAsync(env: Record<string, string>, ...args: string[]) {
  const child = spawn("bun", ["run", join(REPO_ROOT, "src", "index.tsx"), ...args], { cwd: REPO_ROOT, env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((res) =>
    child.on("close", (code) => res({ code, stdout, stderr })),
  );
}

/** The fixture tmux state plus one live codex window, showing `screen`. */
function withCodexWindow(extra: Record<string, unknown>) {
  return {
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: CODEX_TARGET }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: CODEX_TARGET, cwd: "/run/codex", placeholder: false }],
    ...extra,
  };
}

interface Sim {
  submitted: string[];
  events: string[];
  box: string;
}

type Mock = { env: Record<string, string>; setTmuxState(s: unknown): Promise<void>; tmuxLog(): Promise<string[][]> };

/** Put a simulated codex in the codex window (see the fake's `codexSim`). */
async function simulate(mock: Mock, knobs: Record<string, unknown> = {}) {
  await mock.setTmuxState(withCodexWindow({ codexSim: { [CODEX_TARGET]: { template: fixture("codex163-idle.ansi"), ...knobs } } }));
}

const readSim = (mock: Mock): Sim => JSON.parse(readFileSync(mock.env.FAKE_TMUX_STATE, "utf-8")).codexSim[CODEX_TARGET];

/** The keystroke-bearing tmux calls against the codex window, in order. */
async function keystrokes(mock: Mock): Promise<string[]> {
  return (await mock.tmuxLog()).flatMap((argv) => {
    if (argv[0] === "paste-buffer") return ["paste"];
    if (argv[0] === "send-keys" && argv.at(-1) === "Enter") return ["enter"];
    if (argv[0] === "capture-pane" && argv.some((a) => a.includes(CODEX_TARGET))) return ["read"];
    return [];
  });
}

const sendJson = (stdout: string) => JSON.parse(stdout) as Record<string, unknown>;

test.describe("agendo send to codex", () => {
  test("confirms the message was taken and the turn started", async ({ mock }) => {
    await simulate(mock);
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code, r.stderr).toBe(0);
    expect(sendJson(r.stdout)).toMatchObject({ ok: true, route: "pane", state: "ready", enters: 1, turnStarted: true });
    expect(readSim(mock).submitted).toEqual(["run the tests"]);
  });

  test("a slow paste: Enter waits until the text is in the box", async ({ mock }) => {
    // Six reads to show the paste. The old fire-and-forget Enter landed on the
    // still-empty box and was lost, leaving the message sitting in it unsent.
    await simulate(mock, { ingestReads: 6 });
    const r = await agendoAsync(mock.env, "send", CODEX_SHORT, "run the tests");
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("codex took it");
    const sim = readSim(mock);
    expect(sim.submitted).toEqual(["run the tests"]);
    expect(sim.events).not.toContain("enter-lost");
    const keys = await keystrokes(mock);
    const paste = keys.indexOf("paste");
    const enter = keys.indexOf("enter");
    expect(keys.slice(paste, enter).filter((k) => k === "read").length).toBeGreaterThanOrEqual(6);
  });

  test("a swallowed Enter is pressed again, and the message is typed only once", async ({ mock }) => {
    await simulate(mock, { dropEnters: 1 });
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code, r.stderr).toBe(0);
    expect(sendJson(r.stdout)).toMatchObject({ ok: true, enters: 2 });
    const keys = await keystrokes(mock);
    expect(keys.filter((k) => k === "paste")).toHaveLength(1);
    expect(readSim(mock).submitted).toEqual(["run the tests"]);
  });

  test("an Enter that never takes fails, and says the message is still in the box", async ({ mock }) => {
    await simulate(mock, { dropEnters: 99 });
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code).toBe(1);
    expect(sendJson(r.stdout)).toMatchObject({ ok: false, route: "pane", reason: "not-submitted", enters: 4, composer: "run the tests" });
    expect(r.stderr).toContain("It is still there, unsent");
    const keys = await keystrokes(mock);
    expect(keys.filter((k) => k === "paste")).toHaveLength(1);
    expect(readSim(mock).submitted).toEqual([]);
  });

  test("a paste that never shows is never submitted blind", async ({ mock }) => {
    await simulate(mock, { ingestReads: -1 });
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code).toBe(1);
    expect(sendJson(r.stdout)).toMatchObject({ ok: false, reason: "not-ingested", enters: 0 });
    expect(r.stderr).toContain("Enter was NOT pressed");
    expect(await keystrokes(mock)).not.toContain("enter");
  });

  test("a message ending in an @-mention can't have its Enter eaten by the popup", async ({ mock }) => {
    // The sim's popup takes Enter on a box that ENDS in `@token` as "accept this
    // completion". The trailing space closes it, and codex submits as normal.
    await simulate(mock, { popup: true });
    const r = await agendoAsync(mock.env, "send", CODEX_SHORT, "look at @README");
    expect(r.code, r.stderr).toBe(0);
    expect(readSim(mock).submitted).toEqual(["look at @README"]);
    const buffer = (await mock.tmuxLog()).find((argv) => argv[0] === "set-buffer")!;
    expect(buffer.at(-1)).toBe("look at @README ");
  });

  test("a message held for codex's startup counts as taken, and Enter is not pressed again", async ({ mock }) => {
    // While its MCP servers boot, codex keeps a submitted message IN the box
    // under `Waiting for startup`. Read as "still there", that got three more
    // Enters and a false "not submitted".
    await simulate(mock, { holdReads: 30 });
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code, r.stderr).toBe(0);
    expect(sendJson(r.stdout)).toMatchObject({ ok: true, enters: 1, held: true, turnStarted: null });
    expect((await keystrokes(mock)).filter((k) => k === "enter")).toHaveLength(1);
    expect(readSim(mock).events).toContain("held");
  });

  test("a message that mentions a dialog's key hint is delivered like any other", async ({ mock }) => {
    // Codex draws no rule under its box, so the whole-pane dialog check took the
    // message's own words for a dialog's footer, and the paste never read back.
    await simulate(mock);
    const text = "When the installer prints Press Enter to continue, press it";
    const r = await agendoAsync(mock.env, "send", CODEX_SHORT, text);
    expect(r.code, r.stderr).toBe(0);
    expect(readSim(mock).submitted).toEqual([text]);
  });

  test("a message of several lines is read back across the box's rows", async ({ mock }) => {
    await simulate(mock);
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "first line\nsecond line\nthird line");
    expect(r.code, r.stderr).toBe(0);
    expect(sendJson(r.stdout)).toMatchObject({ ok: true, enters: 1 });
    expect(readSim(mock).submitted).toEqual(["first line\nsecond line\nthird line"]);
  });

  test("codex rewriting the message stops delivery, with nothing submitted", async ({ mock }) => {
    await simulate(mock, { rewrite: "run the tests in @README.md " });
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code).toBe(1);
    expect(sendJson(r.stdout)).toMatchObject({ ok: false, reason: "draft-rewritten", enters: 1, composer: "run the tests in @README.md" });
    expect(r.stderr).toContain("codex changed the message");
    expect(readSim(mock).submitted).toEqual([]);
  });

  test("a screen it can't read after Enter stops the keys, and says it can't tell", async ({ mock }) => {
    await simulate(mock, { afterEnter: fixture("codex163-trust.ansi") });
    const r = await agendoAsync(mock.env, "send", "--json", CODEX_SHORT, "run the tests");
    expect(r.code).toBe(1);
    expect(sendJson(r.stdout)).toMatchObject({ ok: false, reason: "lost-sight", enters: 1, composer: null });
    expect(r.stderr).toContain("could no longer be read");
    expect((await keystrokes(mock)).filter((k) => k === "enter")).toHaveLength(1);
  });

  test("a wait started right after send sees the turn, not the gap before it", async ({ mock }) => {
    // Codex empties the box while its bar still says Ready. send now holds until
    // the bar changes, so the wait that follows starts on a busy pane and settles
    // when the turn ends, rather than returning on that first Ready.
    await simulate(mock, { lagReads: 3, busyReads: 12 });
    const sent = await agendoAsync(mock.env, "send", CODEX_SHORT, "run the tests");
    expect(sent.code, sent.stderr).toBe(0);
    const r = await agendoAsync(mock.env, "wait", CODEX_SHORT, "--json", "--interval", "100ms", "--timeout", "20s");
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { woke: string; sessions: { state: string; from: string }[] };
    expect(out.woke).toBe("satisfied");
    expect(out.sessions[0]).toMatchObject({ from: "busy", state: "ready" });
  });
});

test.describe("agendo wait on codex 0.163", () => {
  test("settles when a turn ends, through the tail where only the bar says Working", async ({ mock }) => {
    const queue = ["codex163-busy.ansi", "codex163-busy.ansi", "codex163-busy-tail.ansi", "codex163-busy-tail.ansi"].map(fixture);
    await mock.setTmuxState(withCodexWindow({
      captures: { ...tmuxState.captures, [CODEX_TARGET]: fixture("codex163-done.ansi") },
      captureQueue: { [CODEX_LOCATION]: queue },
    }));
    const r = await agendoAsync(mock.env, "wait", CODEX_SHORT, "--json", "--interval", "100ms", "--timeout", "20s");
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { woke: string; sessions: { state: string; from: string }[] };
    expect(out.woke).toBe("satisfied");
    expect(out.sessions[0]).toMatchObject({ from: "busy", state: "ready" });
  });

  test("wakes for codex's folder-trust prompt", async ({ mock }) => {
    await mock.setTmuxState(withCodexWindow({ captures: { ...tmuxState.captures, [CODEX_TARGET]: fixture("codex163-trust.ansi") } }));
    const r = await agendoAsync(mock.env, "wait", CODEX_SHORT, "--json", "--interval", "100ms", "--timeout", "20s");
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { woke: string; sessions: { state: string }[] };
    expect(out.woke).toBe("satisfied");
    expect(out.sessions[0].state).toBe("dialog");
  });
});
