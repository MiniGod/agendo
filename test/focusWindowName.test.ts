// `focus` by window name (src/cli/focus/windowName.ts): an id-bearing name is
// its short id, an id-less one (`cl-wi-`, `cl-pr-`, `cl-bg-codex-`) is whichever
// session its live window is attributed to. e2e/focus.spec.ts drives the real
// attribution end to end; this pins the lookup over it.
import { describe, expect, test } from "bun:test";
import { sessionsForToken } from "../src/cli/focus/windowName.ts";
import { sessionName, type LiveTarget } from "../src/runtime/tmux/index.ts";
import type { AgentSession } from "../src/shared/types.ts";

const session = (id: string, source: AgentSession["source"] = "claude") => ({ id, source, cwd: "/w" }) as AgentSession;
const A = session("aaaa1111-2222-3333-4444-555566667777");
const B = session("bbbb1111-2222-3333-4444-555566667777", "codex");
const ALL = [A, B];

/** `liveWindows` as `refreshLiveTmux` returns it: canonical session name → the window it runs in. */
const attributed = (...pairs: [AgentSession, string][]) => () =>
  new Map<string, LiveTarget>(pairs.map(([s, name]) => [sessionName(s), { name, target: `=agendo:=${name}` }]));

/** An `attributed` that fails the test if it is read: ids and id-bearing names never need tmux. */
const noTmux = (): Map<string, LiveTarget> => {
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

  test("an id-less window name is the session its live window is attributed to", () => {
    const live = attributed([A, "cl-pr-acme-appweb-5"], [B, "cl-bg-codex-x1"]);
    expect(sessionsForToken(ALL, "cl-pr-acme-appweb-5", live)).toEqual([A]);
    expect(sessionsForToken(ALL, "cl-bg-codex-x1", live)).toEqual([B]);
  });

  test("the name must match exactly: no prefix of a longer window", () => {
    expect(sessionsForToken(ALL, "cl-pr-5", attributed([A, "cl-pr-50"]))).toEqual([]);
  });

  test("a window attributed to nobody, or to a session not on disk, resolves to nothing", () => {
    expect(sessionsForToken(ALL, "cl-wi-102", attributed())).toEqual([]);
    expect(sessionsForToken([A], "cl-wi-102", attributed([B, "cl-wi-102"]))).toEqual([]);
  });

  test("two sessions in same-named windows (in two hosts) give both, for focus to choose between", () => {
    expect(sessionsForToken(ALL, "cl-wi-102", attributed([A, "cl-wi-102"], [B, "cl-wi-102"]))).toEqual([A, B]);
  });
});
