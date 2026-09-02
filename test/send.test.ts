// `agendo send` (src/cli/send.ts): the steps of the dispatch, each on its own.
// The e2e suite drives the command end to end over both routes; what it never
// reaches is the call with no id, the socket that fails on a session with no
// window, the "socket disabled by" suffix, and a dialog whose option is
// missing. `process.exit` is stubbed to throw so a refusal is an assertion.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureReachable, noInputBoxMessage, pasteWhy, queuedLine, refuseDialog, refuseLimited, refuseMenuSuspect,
  refusePaneNotReady, refuseUnreachable, runSend, sendContext, sendPayload, socketFailed, socketState,
  usageExit, type PaneRead, type SendContext,
} from "../src/cli/send.ts";
import type { PeerSession } from "../src/peer.ts";

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const realExit = process.exit;
const realError = console.error;
const realLog = console.log;
const realWrite = process.stdout.write;
let errors: string[];
let logs: string[];
let out: string[];

beforeEach(() => {
  errors = [];
  logs = [];
  out = [];
  process.exit = ((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  console.log = (...args: unknown[]) => void logs.push(args.join(" "));
});

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
  console.log = realLog;
  process.stdout.write = realWrite;
});

/** Capture what `printJson` writes, calling its completion callback. */
function captureStdout(): void {
  process.stdout.write = ((chunk: unknown, cb?: unknown) => {
    out.push(String(chunk));
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stdout.write;
}

/** The exit code a step ended with, or null when it returned. */
async function exitCode(fn: () => Promise<unknown>): Promise<number | null | undefined> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

const target = { name: "cl-wi-7", target: "cl-wi-7" };
const peer: PeerSession = { pid: 42, sessionId: "abcdef12-3456-7890-abcd-ef1234567890", cwd: "/w", socketPath: "/s", status: "busy", kind: "interactive", peerProtocol: 1 };
const on = { enabled: true, source: "env" as const };
const off = { enabled: false, source: "config" as const };
const ctxWith = (o: Partial<Omit<SendContext, "say" | "finish">> = {}): SendContext =>
  sendContext({ token: "ab", sid: "ab", target, socket: on, peer: null, json: false, ...o });
const pane = (readiness: PaneRead["readiness"], raw = "", dialogAnswered = false): PaneRead => ({ raw, cursor: null, readiness, dialogAnswered });

describe("the two voices", () => {
  test("no id or no prompt is a usage error before anything is looked up", async () => {
    expect(await exitCode(async () => usageExit())).toBe(1);
    expect(await exitCode(() => runSend(undefined, "hi", false, 0, false))).toBe(1);
    expect(await exitCode(() => runSend("ab", "", false, 0, false))).toBe(1);
    expect(errors).toHaveLength(3);
    expect(errors[0]).toMatch(/^usage: .* send <id> "<prompt>" \[--force\] \[--json\] \[--timeout <dur>\]$/);
  });

  test("progress lines are spoken unless --json owns stdout", () => {
    ctxWith().say("▸ hello");
    ctxWith({ json: true }).say("▸ quiet");
    expect(logs).toEqual(["▸ hello"]);
  });

  test("finish exits with the code, and under --json writes the payload first", async () => {
    expect(await exitCode(() => ctxWith().finish({ ok: true, route: "pane" }, 0))).toBe(0);
    expect(out).toEqual([]);
    captureStdout();
    expect(await exitCode(() => ctxWith({ json: true, peer, socket: off }).finish({ ok: false, route: null, reason: "limited", extra: { state: "limited" } }, 2))).toBe(2);
    expect(JSON.parse(out.join(""))).toEqual({
      ok: false,
      route: null,
      queued: false,
      id: "ab",
      sessionId: peer.sessionId,
      target: "cl-wi-7",
      pid: 42,
      socket: { enabled: false, disabledBy: "config" },
      reason: "limited",
      state: "limited",
    });
  });

  test("the payload names the route, and says nothing about a peer or window it did not find", () => {
    expect(sendPayload({ sid: "ab", peer: null, target: null, socket: on }, { ok: true, route: "socket" })).toEqual({
      ok: true,
      route: "socket",
      queued: true,
      id: "ab",
      sessionId: null,
      target: null,
      pid: null,
      socket: { enabled: true, disabledBy: null },
    });
  });
});

describe("reaching the session", () => {
  test("a window or a peer is enough; neither, with the socket on, is not running", async () => {
    expect(await exitCode(() => ensureReachable(ctxWith()))).toBeNull();
    expect(await exitCode(() => ensureReachable(ctxWith({ target: null, peer })))).toBeNull();
    expect(await exitCode(() => ensureReachable(ctxWith({ target: null })))).toBe(1);
    expect(errors[0]).toBe("Session ab is not running (no live tmux window and no messaging socket).");
    expect(errors[1]).toMatch(/resume/);
  });

  test("a live peer behind a disabled socket is told how to re-enable it, never to resume", async () => {
    expect(await exitCode(() => refuseUnreachable(ctxWith({ target: null, socket: off }), peer))).toBe(1);
    expect(errors[0]).toBe('Session ab IS running (pid 42), but unreachable: it has no tmux window, and the messaging socket is disabled ("peerSocket": false in config.json).');
    expect(errors[1]).toMatch(/Do NOT resume it/);
    errors = [];
    await exitCode(() => refuseUnreachable(ctxWith({ target: null, socket: { enabled: false, source: "env" } }), peer));
    expect(errors[0]).toMatch(/disabled \(AGENDO_PEER_SOCKET\)\.$/);
  });
});

describe("the dialog step", () => {
  test("a step-1 refusal names its reason and flags the dialog", async () => {
    captureStdout();
    expect(await exitCode(() => refuseDialog(ctxWith({ json: true }), "resume-dialog-unanswerable", "Not sending: no option"))).toBe(2);
    expect(errors).toEqual(["Not sending: no option"]);
    expect(JSON.parse(out.join(""))).toMatchObject({ ok: false, route: null, reason: "resume-dialog-unanswerable", resumeDialog: true });
  });

  test("the no-input-box message rounds the wait to seconds and says to retry", () => {
    const m = noInputBoxMessage("ab", 12_400);
    expect(m).toMatch(/^Not sending: answered claude's resume dialog but no input box appeared within 12s — /);
    expect(m).toMatch(/WAIT AND RETRY/);
    expect(m).toMatch(/status ab`\.$/);
  });
});

describe("the gates", () => {
  test("a session at its usage limit is refused after the dialog step, unless forced", async () => {
    expect(await exitCode(() => refuseLimited(ctxWith(), pane("ready"), false))).toBeNull();
    expect(await exitCode(() => refuseLimited(ctxWith(), pane("limited"), true))).toBeNull();
    expect(await exitCode(() => refuseLimited(ctxWith(), pane("limited", "", true), false))).toBe(2);
    expect(errors[0]).toMatch(/^Not sending: session is at its usage limit\. Wait for the reset, `.* unblock ab`, or pass --force\.$/);
  });

  test("a pane that is not ready is refused with its tail, unless forced", async () => {
    expect(await exitCode(() => refusePaneNotReady(ctxWith(), pane("ready"), false))).toBeNull();
    expect(await exitCode(() => refusePaneNotReady(ctxWith(), pane("busy"), true))).toBeNull();
    expect(await exitCode(() => refusePaneNotReady(ctxWith(), pane("busy", "one\n\n  two \x1b[1mthree\x1b[0m\n"), false))).toBe(2);
    expect(errors).toEqual([
      expect.stringMatching(/^Not sending: session looks "busy", not ready\. Re-check with `.* status ab`, or pass --force\.$/),
      "\n  current screen (tail):",
      "    one",
      "      two three",
    ]);
  });

  test("a screen that does not look like a resume menu passes the suspect gate", async () => {
    expect(await exitCode(() => refuseMenuSuspect(ctxWith(), pane("ready", "> \n")))).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("the socket route", () => {
  test("the state is the pane's where there is one, else the receiver's, else running", () => {
    expect(socketState(pane("compacting"), peer)).toBe("compacting");
    expect(socketState(pane(null), peer)).toBe("busy");
    expect(socketState(pane(null), { status: undefined })).toBe("running");
  });

  test("the queued line names where it went and warns unless the session is idle in either spelling", () => {
    expect(queuedLine(target, peer, "ready")).toBe("▸ queued via socket to cl-wi-7");
    expect(queuedLine(null, peer, "idle")).toBe("▸ queued via socket to pid 42");
    expect(queuedLine(null, peer, "busy")).toBe('▸ queued via socket to pid 42 (session is "busy"; it will be delivered when it next reads input)');
  });

  test("a socket that fails falls back to the pane when there is one, and is an error when there is not", async () => {
    expect(await socketFailed(ctxWith(), new Error("ECONNREFUSED"))).toBe(true);
    expect(errors).toEqual(["▸ session socket unusable (ECONNREFUSED); falling back to the tmux pane."]);
    errors = [];
    expect(await exitCode(() => socketFailed(ctxWith({ target: null, peer }), new Error("EPIPE")))).toBe(1);
    expect(errors).toEqual(["Failed to reach the session socket (EPIPE), and it has no tmux window to type into."]);
  });
});

describe("the pane route", () => {
  test("the paste line says why the pane, where it is not obvious", () => {
    expect(pasteWhy(true, on)).toBe(" (socket fallback)");
    expect(pasteWhy(false, on)).toBe("");
    expect(pasteWhy(false, off)).toBe(" (socket disabled by config)");
    expect(pasteWhy(false, { enabled: false, source: "env" })).toBe(" (socket disabled by AGENDO_PEER_SOCKET)");
  });
});
