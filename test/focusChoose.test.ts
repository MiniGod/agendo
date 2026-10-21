// The choices `agendo focus` makes that the e2e suite only ever sees one side
// of: which of several linked sessions it brings forward, which attached tmux
// client it moves, and how its argv is read. All pure, so each case is a row.
import { describe, expect, test } from "bun:test";
import { parseFocusArgs, pickSession, type FocusCandidate } from "../src/cli/focus/choose.ts";
import { asPaneTarget, parseClients, parseWindowIdentity, pickClient, scopedWindowTarget } from "../src/runtime/tmux/clients.ts";
import type { AgentSession } from "../src/shared/types.ts";

function cand(id: string, state: FocusCandidate["state"], minutesAgo: number): FocusCandidate {
  return { s: { id, lastUsed: new Date(Date.UTC(2026, 0, 1) - minutesAgo * 60_000) } as AgentSession, state };
}

describe("pickSession", () => {
  test("nothing to choose from", () => expect(pickSession([])).toBeNull());

  test("a running session beats a more recent paused or idle one", () => {
    const got = pickSession([cand("idle", "idle", 1), cand("paused", "paused", 2), cand("run", "running", 50)]);
    expect(got?.s.id).toBe("run");
  });

  test("the most recently active of several running sessions", () => {
    const got = pickSession([cand("old", "running", 30), cand("new", "running", 5), cand("mid", "running", 10)]);
    expect(got?.s.id).toBe("new");
  });

  test("with none running, the most recent of the rest, paused or idle alike", () => {
    expect(pickSession([cand("p", "paused", 20), cand("i", "idle", 3)])?.s.id).toBe("i");
    expect(pickSession([cand("p", "paused", 2), cand("i", "idle", 3)])?.s.id).toBe("p");
  });

  test("a tie keeps the first listed", () => {
    expect(pickSession([cand("a", "idle", 5), cand("b", "idle", 5)])?.s.id).toBe("a");
  });
});

describe("parseClients / pickClient", () => {
  const line = (activity: string, name: string, pid: string, session = "agendo", control = "0") =>
    [activity, name, pid, session, control].join("\t");

  test("parses list-clients lines and drops malformed and control-mode ones", () => {
    const got = parseClients([
      line("100", "/dev/pts/1", "11"),
      line("x", "/dev/pts/2", "12"),
      line("100", "", "13"),
      line("100", "/dev/pts/4", "pid"),
      line("999", "/dev/pts/5", "15", "agendo", "1"),
      "garbage",
    ]);
    expect(got).toEqual([{ name: "/dev/pts/1", pid: 11, activity: 100, session: "agendo" }]);
  });

  test("the client with the latest input wins; ties keep tmux's order", () => {
    const clients = parseClients([line("100", "/dev/pts/1", "1"), line("300", "/dev/pts/2", "2"), line("300", "/dev/pts/3", "3")]);
    expect(pickClient(clients)?.name).toBe("/dev/pts/2");
  });

  test("no client attached", () => expect(pickClient([])).toBeNull());
});

describe("parseFocusArgs", () => {
  test("the three forms", () => {
    expect(parseFocusArgs(["--pr", "5001"])).toEqual({ ok: true, target: { kind: "pr", id: 5001 } });
    expect(parseFocusArgs(["--work-item", "102"])).toEqual({ ok: true, target: { kind: "workItem", id: 102 } });
    expect(parseFocusArgs(["--issue", "7"])).toEqual({ ok: true, target: { kind: "workItem", id: 7 } });
    expect(parseFocusArgs(["abc123"])).toEqual({ ok: true, target: { kind: "session", token: "abc123" } });
  });

  test("--repo narrows a PR or work item, before or after it", () => {
    expect(parseFocusArgs(["--pr", "5", "--repo", "acme/appweb"])).toEqual({ ok: true, target: { kind: "pr", id: 5, repo: "acme/appweb" } });
    expect(parseFocusArgs(["--repo", "appweb", "--work-item", "102"])).toEqual({ ok: true, target: { kind: "workItem", id: 102, repo: "appweb" } });
  });

  const REFUSED: string[][] = [
    [],
    ["--pr"],
    ["--pr", "x"],
    ["--pr", "0"],
    ["--pr", "-1"],
    ["--work-item", "1.5"],
    ["--pr", "1", "--work-item", "2"],
    ["--pr", "1", "abc"],
    ["abc", "def"],
    ["--attach"],
    ["--pr=1"],
    ["a;b"],
    ["--repo", "appweb"],
    ["abc", "--repo", "appweb"],
    ["--pr", "5", "--repo"],
    ["--pr", "5", "--repo", "../x"],
    ["--pr", "5", "--repo", "a/b/c"],
    ["--pr", "5", "--repo", "a", "--repo", "b"],
  ];
  for (const argv of REFUSED) {
    test(`refuses ${JSON.stringify(argv)}`, () => expect(parseFocusArgs(argv).ok).toBe(false));
  }
});

describe("window identity", () => {
  test("a bare exact session target gains the colon a target-pane needs", () => {
    expect(asPaneTarget("=agendo")).toBe("=agendo:");
    expect(asPaneTarget("=agendo:=cl-claude-x")).toBe("=agendo:=cl-claude-x");
    expect(asPaneTarget("%12")).toBe("%12");
  });

  test("the switch target is scoped to the session the window was found in", () => {
    expect(scopedWindowTarget({ windowId: "@12", session: "agendo" })).toBe("=agendo:@12");
  });

  test("only an @N window id is accepted back", () => {
    expect(parseWindowIdentity("@12\tagendo\n")).toEqual({ windowId: "@12", session: "agendo" });
    expect(parseWindowIdentity("")).toBeNull();
    expect(parseWindowIdentity("12\tagendo")).toBeNull();
    expect(parseWindowIdentity("@12\t")).toBeNull();
    expect(parseWindowIdentity("@1;kill-server\tagendo")).toBeNull();
  });
});
