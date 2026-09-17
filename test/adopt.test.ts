// Window adoption's decision core (src/app/model/adopt.ts): which panes of the
// launcher's host session get taken over, and how. Pure — the pane listing,
// claude's process records and the session index come in as data — and pinned
// here rather than in the e2e suite because the cases that matter are the
// REFUSALS: two records for one pane, a dead pane, a cwd that does not line up,
// the menu's own pane. A fixture-driven run can only ever show the happy path
// working; the point of every rule below is what it declines to do, because an
// adopted window is one `agendo close` will kill.
import { describe, expect, test } from "bun:test";
import {
  adoptedTags, adoptionShape, hasAdoptionCandidate, planAdoptions, type AdoptionInputs,
} from "../src/app/model/index.ts";
import type { LivePane } from "../src/runtime/tmux/index.ts";
import type { ClaudeProcessRecord } from "../src/sessions/records.ts";
import type { AgentSession } from "../src/shared/types.ts";

const HOST = "agendo";
const CWD = "/home/dev/repo";
const SID = "0e6e2941-73bb-4f49-ab40-c921bc6959f5";
/** `sessionName` of SID: `cl-claude-` + the first 12 alphanumerics. */
const CANON = "cl-claude-0e6e294173bb";

function pane(over: Partial<LivePane> = {}): LivePane {
  return {
    session: HOST, window: "bash", windowIndex: "3", paneId: "%7", cwd: CWD,
    dead: false, placeholder: false, paneTarget: "", ...over,
  };
}
function record(over: Partial<ClaudeProcessRecord> = {}): ClaudeProcessRecord {
  return { pid: 4242, sessionId: SID, cwd: CWD, tmux: { session: HOST, pane: "%7" }, configDir: "/home/dev/.claude", ...over };
}
function session(over: Partial<AgentSession> = {}): AgentSession {
  return { id: SID, source: "claude", cwd: CWD, title: "hand-typed", lastUsed: new Date(1_000), branch: "feat/x", ...over };
}
/** The menu window's pane, as every host session has one. */
const MENU = pane({ window: "launcher", windowIndex: "0", paneId: "%1", cwd: "/home/dev" });

function inputs(over: Partial<AdoptionInputs> = {}): AdoptionInputs {
  return { host: HOST, panes: [MENU, pane()], records: [record()], sessions: [session()], live: new Set(), ...over };
}

describe("adoptionShape: which panes are shaped for adoption at all", () => {
  test("an unmanaged window with a single pane is adopted as a WINDOW", () => {
    expect(adoptionShape(pane(), HOST, 1)).toBe("window");
  });

  test("an unmanaged window the user split is adopted per PANE — the window is not all ours", () => {
    expect(adoptionShape(pane(), HOST, 2)).toBe("pane");
  });

  test("a pane split beside the launcher menu is adopted as a pane, the way the global orchestrator lives", () => {
    expect(adoptionShape(pane({ window: "launcher" }), HOST, 2)).toBe("pane");
  });

  test("the menu window with nothing split into it is only the menu", () => {
    expect(adoptionShape(pane({ window: "launcher" }), HOST, 1)).toBeNull();
  });

  // The window's name and tag already say what runs in it; re-stamping a live
  // launched window is what openTarget refuses to do, and this pass does not
  // get to overrule that on its own.
  test("a managed window with a single pane is never touched", () => {
    expect(adoptionShape(pane({ window: "cl-claude-abc" }), HOST, 1)).toBeNull();
    expect(adoptionShape(pane({ window: "cl-wi-101" }), HOST, 1)).toBeNull();
  });

  test("a second pane the user split into a managed window is adopted as a pane", () => {
    expect(adoptionShape(pane({ window: "cl-claude-abc" }), HOST, 2)).toBe("pane");
  });

  test("the pane this agendo runs in is never a candidate, whatever its window is called", () => {
    expect(adoptionShape(pane({ paneId: "%1" }), HOST, 1, "%1")).toBeNull();
    expect(adoptionShape(pane({ window: "launcher", paneId: "%1" }), HOST, 2, "%1")).toBeNull();
  });

  test("a restore placeholder, a dead pane and an already-stamped pane are out", () => {
    expect(adoptionShape(pane({ placeholder: true }), HOST, 1)).toBeNull();
    expect(adoptionShape(pane({ dead: true }), HOST, 1)).toBeNull();
    expect(adoptionShape(pane({ paneTarget: "cl-bg-orch" }), HOST, 1)).toBeNull();
  });

  test("scoped to the host session: another tmux session's panes are not agendo's to rename", () => {
    expect(adoptionShape(pane({ session: "work" }), HOST, 1)).toBeNull();
  });
});

describe("hasAdoptionCandidate: the gate that keeps the records read off the common path", () => {
  test("a host of nothing but the menu and launched windows has no candidate", () => {
    const panes = [MENU, pane({ window: "cl-claude-abc", paneId: "%2" }), pane({ window: "cl-wi-101", paneId: "%3" })];
    expect(hasAdoptionCandidate(HOST, panes)).toBe(false);
  });

  test("one hand-opened window is a candidate, even before any record exists", () => {
    expect(hasAdoptionCandidate(HOST, [MENU, pane()])).toBe(true);
  });

  test("a menu split by hand is a candidate — its second pane might be a claude", () => {
    expect(hasAdoptionCandidate(HOST, [MENU, pane({ window: "launcher", windowIndex: "0", paneId: "%9" })], "%1")).toBe(true);
  });

  test("the menu alone is not, whether or not agendo knows which pane it runs in", () => {
    expect(hasAdoptionCandidate(HOST, [MENU], "%1")).toBe(false);
    expect(hasAdoptionCandidate(HOST, [MENU])).toBe(false);
  });
});

describe("planAdoptions: the happy path", () => {
  test("a hand-opened window whose record names an on-disk session in its cwd is adopted as a window", () => {
    expect(planAdoptions(inputs())).toEqual([
      { shape: "window", paneId: "%7", window: "bash", name: CANON, session: session() },
    ]);
  });

  test("the record's pane id is what ties it to the pane — not the cwd, not recency", () => {
    // Two hand-opened windows in ONE directory, each with its own record. The
    // cwd heuristic could not tell them apart; the pane ids can.
    const other = "11111111-2222-4333-8444-555555555555";
    const r = planAdoptions(inputs({
      panes: [MENU, pane({ paneId: "%7", windowIndex: "3" }), pane({ paneId: "%8", windowIndex: "4" })],
      records: [record({ pid: 1, tmux: { session: HOST, pane: "%7" } }), record({ pid: 2, sessionId: other, tmux: { session: HOST, pane: "%8" } })],
      sessions: [session(), session({ id: other, lastUsed: new Date(9_000) })],
    }));
    expect(r.map((p) => [p.paneId, p.session.id])).toEqual([["%7", SID], ["%8", other]]);
  });

  test("a pane in a split window is adopted as a pane under its canonical name", () => {
    const r = planAdoptions(inputs({ panes: [MENU, pane({ paneId: "%6", cwd: "/elsewhere" }), pane()] }));
    expect(r).toEqual([{ shape: "pane", paneId: "%7", window: "bash", name: CANON, session: session() }]);
  });
});

describe("planAdoptions: what is NEVER adopted", () => {
  test("the launcher menu's own pane, even with a record pointing at it", () => {
    // A record claiming the menu's pane is bogus by construction (the menu is
    // agendo, not claude) — and adopting it would let `close` kill the menu.
    const r = planAdoptions(inputs({ panes: [MENU], records: [record({ tmux: { session: HOST, pane: "%1" }, cwd: "/home/dev" })], selfPane: "%1" }));
    expect(r).toEqual([]);
  });

  test("a plain shell, an editor, a log tail: no record names their pane", () => {
    expect(planAdoptions(inputs({ records: [] }))).toEqual([]);
    expect(planAdoptions(inputs({ records: [record({ tmux: { session: HOST, pane: "%99" } })] }))).toEqual([]);
  });

  test("an already-managed single-pane window, whatever its record says", () => {
    expect(planAdoptions(inputs({ panes: [MENU, pane({ window: "cl-claude-abc" })] }))).toEqual([]);
    expect(planAdoptions(inputs({ panes: [MENU, pane({ window: "cl-wi-101" })] }))).toEqual([]);
  });

  test("a restore placeholder window", () => {
    expect(planAdoptions(inputs({ panes: [MENU, pane({ window: "cl-claude-paused", placeholder: true })] }))).toEqual([]);
  });

  test("a pane already stamped as a pane-hosted session (the global orchestrator)", () => {
    expect(planAdoptions(inputs({ panes: [MENU, pane({ window: "launcher", paneTarget: "cl-bg-orch" })] }))).toEqual([]);
  });

  test("a pane in another tmux session — even one whose record says so", () => {
    const r = planAdoptions(inputs({
      panes: [MENU, pane({ session: "work" })],
      records: [record({ tmux: { session: "work", pane: "%7" } })],
    }));
    expect(r).toEqual([]);
  });

  test("a record whose session name is not the host: pane ids collide across tmux servers", () => {
    expect(planAdoptions(inputs({ records: [record({ tmux: { session: "other-server-session", pane: "%7" } })] }))).toEqual([]);
  });

  test("a record written outside tmux", () => {
    expect(planAdoptions(inputs({ records: [record({ tmux: undefined })] }))).toEqual([]);
  });

  test("a record whose cwd is not the pane's", () => {
    expect(planAdoptions(inputs({ records: [record({ cwd: "/home/dev/other" })] }))).toEqual([]);
  });

  test("a session that is not on disk yet — nothing to attribute until it is", () => {
    expect(planAdoptions(inputs({ sessions: [] }))).toEqual([]);
  });

  test("a session on disk under another agent's id, or in another directory", () => {
    expect(planAdoptions(inputs({ sessions: [session({ source: "codex" })] }))).toEqual([]);
    expect(planAdoptions(inputs({ sessions: [session({ cwd: "/home/dev/other" })] }))).toEqual([]);
  });

  test("a session already running somewhere agendo can see", () => {
    expect(planAdoptions(inputs({ live: new Set([CANON]) }))).toEqual([]);
  });

  test("two live records claiming one pane: an ambiguity, not a tie to break", () => {
    const r = planAdoptions(inputs({ records: [record({ pid: 1 }), record({ pid: 2, sessionId: "other" })] }));
    expect(r).toEqual([]);
  });

  test("one session claimed by two panes: neither is trusted", () => {
    const r = planAdoptions(inputs({
      panes: [MENU, pane({ paneId: "%7" }), pane({ paneId: "%8", windowIndex: "4" })],
      records: [record({ pid: 1, tmux: { session: HOST, pane: "%7" } }), record({ pid: 2, tmux: { session: HOST, pane: "%8" } })],
    }));
    expect(r).toEqual([]);
  });

  test("cwd comparison is normalized, so a trailing slash is not a mismatch", () => {
    expect(planAdoptions(inputs({ records: [record({ cwd: `${CWD}/` })] }))).toHaveLength(1);
  });
});

describe("adoptedTags", () => {
  test("stamps the full session id, the source and the branch, and marks the window ADOPTED", () => {
    expect(adoptedTags(session())).toEqual({ sessionId: SID, source: "claude", branch: "feat/x", acquired: "adopted" });
  });
});
