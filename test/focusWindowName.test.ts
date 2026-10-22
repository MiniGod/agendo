// `focus` by window name (src/cli/focus/windowName.ts): an id-bearing name is
// its short id, an id-less one (`cl-wi-`, `cl-pr-`, `cl-bg-codex-`) goes by the
// session id its LIVE window is tagged with — never by cwd, never through a
// placeholder. e2e/focus.spec.ts drives one tagged window end to end; this pins
// the cases a fixture would need a server's worth of windows for.
import { describe, expect, test } from "bun:test";
import { sessionsForToken } from "../src/cli/focus/windowName.ts";
import type { ManagedTarget } from "../src/runtime/tmux/index.ts";
import type { AgentSession } from "../src/shared/types.ts";

const session = (id: string, cwd = "/w") => ({ id, source: "claude", cwd }) as AgentSession;
const A = session("aaaa1111-2222-3333-4444-555566667777");
const B = session("bbbb1111-2222-3333-4444-555566667777");
const ALL = [A, B];

const win = (name: string, sessionId: string | undefined, placeholder = false): ManagedTarget =>
  ({ name, target: `=agendo:=${name}`, cwd: "/w", placeholder, ...(sessionId ? { tags: { sessionId } } : {}) });

/** A `managed` that fails the test if it is read: ids and id-bearing names never need tmux. */
const noTmux = (): ManagedTarget[] => {
  throw new Error("read tmux for a token that names its session outright");
};

describe("sessionsForToken", () => {
  test("a session id or short id resolves without reading tmux", () => {
    expect(sessionsForToken(ALL, A.id, noTmux)).toEqual([A]);
    expect(sessionsForToken(ALL, "bbbb11112222", noTmux)).toEqual([B]);
    expect(sessionsForToken(ALL, "nope", noTmux)).toEqual([]);
  });

  test("an id-bearing window name is its short id, whatever the kind prefix", () => {
    for (const name of ["cl-claude-aaaa11112222", "cl-copilot-aaaa11112222", "cl-codex-aaaa11112222", "cl-bg-aaaa11112222", "cl-new-aaaa11112222"]) {
      expect(sessionsForToken(ALL, name, noTmux), name).toEqual([A]);
    }
    expect(sessionsForToken(ALL, "cl-bg-cccc11112222", noTmux)).toEqual([]);
  });

  test("an id-less window name goes by the live window's session tag", () => {
    const managed = () => [win("cl-wi-102", B.id), win("cl-pr-acme-appweb-5", A.id), win("cl-bg-codex-x1", A.id)];
    expect(sessionsForToken(ALL, "cl-wi-102", managed)).toEqual([B]);
    expect(sessionsForToken(ALL, "cl-pr-acme-appweb-5", managed)).toEqual([A]);
    expect(sessionsForToken(ALL, "cl-bg-codex-x1", managed)).toEqual([A]);
  });

  test("the name must match exactly: no prefix of a longer window", () => {
    expect(sessionsForToken(ALL, "cl-pr-5", () => [win("cl-pr-50", A.id)])).toEqual([]);
  });

  test("an untagged window, a placeholder, or a tag naming no known session resolves to nothing", () => {
    expect(sessionsForToken(ALL, "cl-wi-102", () => [win("cl-wi-102", undefined)])).toEqual([]);
    expect(sessionsForToken(ALL, "cl-wi-102", () => [win("cl-wi-102", A.id, true)])).toEqual([]);
    expect(sessionsForToken(ALL, "cl-wi-102", () => [win("cl-wi-102", "gone-session")])).toEqual([]);
  });

  test("two live windows of one name tagged differently give both, for focus to choose between", () => {
    const managed = () => [win("cl-wi-102", A.id), win("cl-wi-102", B.id), win("cl-wi-102", B.id)];
    expect(sessionsForToken(ALL, "cl-wi-102", managed)).toEqual([A, B]);
  });
});
