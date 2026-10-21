// The choices `agendo focus` makes that the e2e suite only ever sees one side
// of: which of several linked sessions it brings forward, which attached tmux
// client it moves, and how its argv is read. All pure, so each case is a row.
import { describe, expect, test } from "bun:test";
import { launcherForCwd, parseFocusArgs, pickSession, type FocusCandidate } from "../src/cli/focus/choose.ts";
import { asPaneTarget, parseClients, parseWindowIdentity, pickClient, pickClientFor, scopedWindowTarget } from "../src/runtime/tmux/clients.ts";
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

describe("launcherForCwd", () => {
  const sessions = [
    { session: "agendo", root: null },
    { session: "agendo-agendo", root: "/home/me/git/agendo" },
    { session: "agendo-mc-applications", root: "/home/me/git/mc-applications/" },
    { session: "agendo-mc-sub", root: "/home/me/git/mc-applications/sub" },
  ];

  test("the launcher whose root holds the directory, at the root or under it", () => {
    expect(launcherForCwd("/home/me/git/mc-applications", sessions)).toBe("agendo-mc-applications");
    expect(launcherForCwd("/home/me/git/mc-applications/.claude/worktrees/x", sessions)).toBe("agendo-mc-applications");
  });

  test("the deepest root wins when roots nest", () => {
    expect(launcherForCwd("/home/me/git/mc-applications/sub/pkg", sessions)).toBe("agendo-mc-sub");
  });

  test("a sibling sharing a name prefix is not under the root; nothing matches → undefined", () => {
    expect(launcherForCwd("/home/me/git/agendo-old", sessions)).toBeUndefined();
    expect(launcherForCwd("/tmp/x", sessions)).toBeUndefined();
    expect(launcherForCwd("/tmp/x", [])).toBeUndefined();
  });
});

describe("pickClientFor", () => {
  // Four terminals, one per tmux session; pts/21 is the one typed into all day.
  const layout = [
    { name: "/dev/pts/1", pid: 1, activity: 100, session: "agendo-tv-launcher" },
    { name: "/dev/pts/24", pid: 24, activity: 200, session: "agendo-pc-to-phone-audio" },
    { name: "/dev/pts/21", pid: 21, activity: 900, session: "agendo-agendo" },
    { name: "/dev/pts/6", pid: 6, activity: 300, session: "agendo-mc-applications" },
  ];

  test("the client already on the target's tmux session, though another was typed into more recently", () => {
    expect(pickClientFor(layout, "agendo-mc-applications")?.name).toBe("/dev/pts/6");
  });

  test("no client on the target's session: the most recently active overall", () => {
    expect(pickClientFor(layout, "agendo-somewhere-else")?.name).toBe("/dev/pts/21");
    expect(pickClientFor(layout, undefined)?.name).toBe("/dev/pts/21");
  });

  test("several clients on the target's session: the most recently active of them", () => {
    const more = [...layout, { name: "/dev/pts/8", pid: 8, activity: 500, session: "agendo-mc-applications" }];
    expect(pickClientFor(more, "agendo-mc-applications")?.name).toBe("/dev/pts/8");
  });

  test("no client attached", () => expect(pickClientFor([], "agendo")).toBeNull());
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
