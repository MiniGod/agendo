// `agendo close` (src/cli/close.ts): the guards and the reports, each on its
// own. The e2e suite drives the command end to end against a fixture tmux and
// reaches every guard that a real session can trip; what it never does is call
// the command with no id, point it at an unmanaged window, or make tmux
// renumber a window between the listing and the kill. Those arms are here,
// with `process.exit` stubbed to throw so a refusal is an assertion, not the
// end of the test run.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closedSuffix, closeTargetOf, killFailure, liveHandle, refuseManyWindows, refuseNoSession, refuseUnmanaged,
  refuseUnread, reportClosed, reportNotRunning, runClose, unsafeCloseReason, usageExit,
} from "../src/cli/close.ts";
import type { PaneSnapshot } from "../src/tmux.ts";
import type { AgentSession } from "../src/types.ts";

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const realExit = process.exit;
const realError = console.error;
const realLog = console.log;
let errors: string[];
let logs: string[];

beforeEach(() => {
  errors = [];
  logs = [];
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
});

/** The exit code a refusal ended with, or null when the call returned. */
function exitCode(fn: () => void): number | null | undefined {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

const session = { source: "claude", id: "abcdef12-3456-7890-abcd-ef1234567890", cwd: "/w" } as AgentSession;
const canon = "cl-claude-abcdef123456";
const pane: PaneSnapshot = { raw: "", cursor: null } as unknown as PaneSnapshot;

describe("resolution", () => {
  test("no id is a usage error, before anything is looked up; an id nothing answers to refuses to close anything", async () => {
    expect(exitCode(() => usageExit("kill"))).toBe(1);
    expect(errors[0]).toMatch(/^usage: .* kill <id> \[--force\]$/);
    await expect(runClose(undefined, false, "stop")).rejects.toEqual(new Exit(1));
    expect(errors[1]).toMatch(/^usage: .* stop <id> \[--force\]$/);
    expect(exitCode(() => refuseNoSession("zzz"))).toBe(1);
    expect(errors[2]).toBe('No session found for "zzz" — refusing to close anything.');
  });

  test("an indexed session is looked up by its canonical name, live or not", () => {
    const live = { name: "cl-wi-7", target: "cl-wi-7" };
    expect(liveHandle(session, "abcdef123456", new Map([[canon, live]]))).toEqual({ live, canon });
    expect(liveHandle(session, "abcdef123456", new Map())).toEqual({ live: undefined, canon });
  });

  test("the live window wins; a placeholder squatting the name is closeable by it; nothing else is", () => {
    const live = { name: "cl-wi-7", target: "cl-wi-7" };
    expect(closeTargetOf(live, canon, new Set([canon]))).toEqual({ placeholder: false, target: "cl-wi-7" });
    expect(closeTargetOf(null, canon, new Set([canon]))).toEqual({ placeholder: true, target: canon });
    expect(closeTargetOf(undefined, canon, new Set())).toEqual({ placeholder: false, target: undefined });
  });

  test("not running is a success, with a resume hint only for an indexed session", () => {
    reportNotRunning({ s: session, label: "abcdef123456" });
    reportNotRunning({ s: undefined, label: "12" });
    expect(logs).toEqual([
      "○ session abcdef123456 is not running — nothing to close.",
      expect.stringMatching(/^ {2}resume: {2}.* resume abcdef123456 {3}\(its worktree, branch and commits are intact\)$/),
      "○ session 12 is not running — nothing to close.",
    ]);
  });
});

describe("guards", () => {
  test("only a managed cl- window may be closed", () => {
    expect(exitCode(() => refuseUnmanaged("cl-wi-7"))).toBeNull();
    expect(exitCode(() => refuseUnmanaged("bash"))).toBe(1);
    expect(errors).toEqual(['Refusing to close "bash": not a managed agendo window.']);
  });

  test("two windows of one name are refused rather than guessed, unless forced", () => {
    expect(exitCode(() => refuseManyWindows(["a:1"], "cl-wi-7", "ab", false))).toBeNull();
    expect(exitCode(() => refuseManyWindows(["a:1", "b:2"], "cl-wi-7", "ab", true))).toBeNull();
    expect(exitCode(() => refuseManyWindows(["a:1", "b:2"], "cl-wi-7", "ab", false))).toBe(2);
    expect(errors[0]).toBe(
      "Not closing: 2 live windows are named cl-wi-7 (a:1, b:2) — agendo can't tell which one is ab. Close the one you mean from its launcher, or pass --force.",
    );
  });

  test("a pane that could not be read is refused; a placeholder has no pane to read; --force closes unread", () => {
    expect(exitCode(() => refuseUnread(pane, false, false, "cl-wi-7", "s:1"))).toBeNull();
    expect(exitCode(() => refuseUnread(null, true, false, "cl-wi-7", "s:1"))).toBeNull();
    expect(exitCode(() => refuseUnread(null, false, true, "cl-wi-7", "s:1"))).toBeNull();
    expect(exitCode(() => refuseUnread(null, false, false, "cl-wi-7", "s:1"))).toBe(2);
    expect(errors[0]).toBe(
      "Not closing: tmux could not read cl-wi-7's pane (s:1), so agendo can't tell whether work is in flight. Re-run to try again, or pass --force to close it unread.",
    );
  });

  test("work in flight: an unsafe state, or an idle main agent with subagents still running", () => {
    expect(unsafeCloseReason("busy", 0)).toBe('session looks "busy"');
    expect(unsafeCloseReason("dialog", 2)).toBe('session looks "dialog"');
    expect(unsafeCloseReason("ready", 1)).toBe("session is idle but 1 background agent is still running");
    expect(unsafeCloseReason("ready", 2)).toBe("session is idle but 2 background agents are still running");
    expect(unsafeCloseReason("ready", 0)).toBeNull();
    expect(unsafeCloseReason("unknown", 0)).toBeNull();
  });
});

describe("the kill and its report", () => {
  test("a kill that landed is silent; one tmux cannot place, or that moved, or that survived, says which", () => {
    expect(killFailure("window", true, "cl-wi-7", "s:1")).toBeNull();
    expect(killFailure("pane", true, "cl-wi-7", null)).toBeNull();
    expect(killFailure("none", true, "cl-wi-7", null)).toBe(
      "Could not close cl-wi-7: tmux can no longer place it in any session. Nothing else was changed.",
    );
    expect(killFailure("moved", false, "cl-wi-7", "s:1")).toBe(
      "Not closing cl-wi-7: the window at s:1 is no longer it (tmux renumbered while we looked). Nothing was killed — re-run to pick it up at its new index.",
    );
    expect(killFailure("session", false, "cl-wi-7", null)).toBe("Could not close cl-wi-7: tmux still reports it live. Nothing else was changed.");
  });

  test("the closed line says what the target was, when it was not simply idle", () => {
    expect(closedSuffix(true, "busy")).toBe(" (unopened restore tab)");
    expect(closedSuffix(false, "ready")).toBe("");
    expect(closedSuffix(false, null)).toBe("");
    expect(closedSuffix(false, "limited")).toBe(' (was "limited")');
  });

  test("an indexed session reports its worktree and how to resume; an unindexed one only what was kept", () => {
    reportClosed("cl-wi-7", { s: session, label: "abcdef123456" }, false, "ready");
    expect(logs).toEqual([
      "▸ closed cl-wi-7",
      "  kept:    worktree, branch and commits are untouched in /w",
      expect.stringMatching(/^ {2}resume: {2}.* resume abcdef123456$/),
    ]);
    logs = [];
    reportClosed(canon, { s: undefined, label: "abcdef123456" }, true, null);
    expect(logs).toEqual([`▸ closed ${canon} (unopened restore tab)`, "  kept:    worktree, branch and commits are untouched"]);
  });
});
