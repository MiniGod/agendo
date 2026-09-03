// `agendo resume` (src/cli/resume.ts): the resolution and the refusals, each on
// its own. The e2e suite resumes real idle and running sessions against a
// fixture tmux; what it never does is call the command with no id, name a
// session that does not exist, or find the session already live outside agendo
// (a second claude on the same transcript). Those arms are here, with
// `process.exit` stubbed to throw so a refusal is an assertion.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { findSession, refuseRunningElsewhere, requireSession, requireToken } from "../src/cli/resume.ts";
import type { PeerSession } from "../src/peer.ts";
import type { AgentSession } from "../src/types.ts";

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const realExit = process.exit;
const realError = console.error;
let errors: string[];

beforeEach(() => {
  errors = [];
  process.exit = ((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
});

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
});

const exitCode = (f: () => unknown): number | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
  throw new Error("did not exit");
};

const session = (id: string, source: AgentSession["source"] = "claude"): AgentSession =>
  ({ id, source, cwd: "/w", title: id, lastUsed: new Date(0) }) as AgentSession;

const peer = (over: Partial<PeerSession> = {}): PeerSession =>
  ({ pid: 4242, sessionId: "s", cwd: "/w", socketPath: "/s", ...over }) as PeerSession;

describe("findSession", () => {
  const all = [session("01234567-aaaa-bbbb-cccc-0123456789ab"), session("fedcba98-1111-2222-3333-fedcba987654", "codex")];

  test("matches the full id, the short id, and the window name", () => {
    expect(findSession(all, "01234567-aaaa-bbbb-cccc-0123456789ab")?.id).toBe(all[0].id);
    expect(findSession(all, "01234567aaaa")?.id).toBe(all[0].id);
    expect(findSession(all, "cl-claude-01234567aaaa")?.id).toBe(all[0].id);
    expect(findSession(all, "cl-codex-fedcba981111")?.id).toBe(all[1].id);
  });

  test("an unknown token, or a window name for another agent's short id, finds nothing", () => {
    expect(findSession(all, "deadbeef")).toBeUndefined();
    expect(findSession(all, "cl-wi-99")).toBeUndefined();
  });
});

describe("the refusals", () => {
  test("no id at all is usage, exit 1", () => {
    expect(requireToken("abc")).toBe("abc");
    expect(exitCode(() => requireToken(undefined))).toBe(1);
    expect(errors[0]).toMatch(/^usage: .* resume <id> \[--attach\]$/);
  });

  test("a token nothing answers to points at list --all, exit 1", () => {
    const all = [session("01234567-aaaa-bbbb-cccc-0123456789ab")];
    expect(requireSession(all, "01234567aaaa")).toBe(all[0]);
    expect(exitCode(() => requireSession(all, "nope"))).toBe(1);
    expect(errors[0]).toBe('No session found for "nope".');
    expect(errors[1]).toContain("list --all");
  });

  test("a session live outside agendo says where, and how to message it, exit 2", () => {
    const s = session("01234567-aaaa-bbbb-cccc-0123456789ab");
    expect(exitCode(() => refuseRunningElsewhere(s, peer({ tmux: "work:3", status: "idle" })))).toBe(2);
    expect(errors[0]).toBe("Session 01234567aaaa is already running outside agendo (pid 4242 in tmux work:3, idle).");
    expect(errors[1]).toMatch(/send 01234567aaaa "<prompt>"/);
    errors = [];
    expect(exitCode(() => refuseRunningElsewhere(s, peer()))).toBe(2);
    expect(errors[0]).toBe("Session 01234567aaaa is already running outside agendo (pid 4242, no tmux pane, running).");
  });
});
