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
  return { sessionId: SID, cwd: CWD, tmux: { session: HOST, pane: "%7" }, ...over };
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
    const panes = [
      MENU, pane({ window: "cl-claude-abc", windowIndex: "1", paneId: "%2" }), pane({ window: "cl-wi-101", windowIndex: "2", paneId: "%3" }),
    ];
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
      { shape: "window", paneId: "%7", name: CANON, session: session(), placeholderPane: undefined },
    ]);
  });

  test("the record's pane id is what ties it to the pane — not the cwd, not recency", () => {
    // Two hand-opened windows in ONE directory, each with its own record. The
    // cwd heuristic could not tell them apart; the pane ids can. Both windows
    // carry the SAME name — tmux's automatic-rename calls each after its
    // command — and each is still one window of its own, adopted as a window.
    const other = "11111111-2222-4333-8444-555555555555";
    const r = planAdoptions(inputs({
      panes: [MENU, pane({ window: "claude", paneId: "%7", windowIndex: "3" }), pane({ window: "claude", paneId: "%8", windowIndex: "4" })],
      records: [record({ tmux: { session: HOST, pane: "%7" } }), record({ sessionId: other, tmux: { session: HOST, pane: "%8" } })],
      sessions: [session(), session({ id: other, lastUsed: new Date(9_000) })],
    }));
    expect(r.map((p) => [p.shape, p.paneId, p.session.id])).toEqual([["window", "%7", SID], ["window", "%8", other]]);
  });

  test("a split is a split by window INDEX, whatever the panes are named", () => {
    // The real shape of a hand-split window: two panes, one window index.
    const split = [MENU, pane({ paneId: "%7", windowIndex: "3" }), pane({ paneId: "%8", windowIndex: "3", cwd: "/home/dev" })];
    expect(planAdoptions(inputs({ panes: split }))).toMatchObject([{ shape: "pane", paneId: "%7" }]);
  });

  test("a pane in a split window is adopted as a pane under its canonical name", () => {
    const r = planAdoptions(inputs({ panes: [MENU, pane({ paneId: "%6", cwd: "/elsewhere" }), pane()] }));
    expect(r).toEqual([{ shape: "pane", paneId: "%7", name: CANON, session: session(), placeholderPane: undefined }]);
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
    const r = planAdoptions(inputs({ records: [record(), record({ sessionId: "other" })] }));
    expect(r).toEqual([]);
  });

  test("one session claimed by two panes: neither is trusted", () => {
    const r = planAdoptions(inputs({
      panes: [MENU, pane({ paneId: "%7" }), pane({ paneId: "%8", windowIndex: "4" })],
      records: [record({ tmux: { session: HOST, pane: "%7" } }), record({ tmux: { session: HOST, pane: "%8" } })],
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

// A restart leaves every previous tab as a paused placeholder window named after
// its session. A `claude --resume <id>` typed into a hand-opened window then
// names exactly that session, and the placeholder — idle bash, no agent — would
// otherwise stay beside the adopted window under the same canonical name, where
// `close` and `send` reach it first. The plan carries the placeholder's PANE id,
// and the apply step kills that pane before the take-over (pinned in
// e2e/adoption.spec.ts). Found in the host's own listing, never by name across
// the server.
describe("planAdoptions: a paused restore tab for the same session", () => {
  const PAUSED = pane({ window: CANON, windowIndex: "2", paneId: "%5", placeholder: true });

  test("is carried on the plan by its pane id, for both shapes", () => {
    expect(planAdoptions(inputs({ panes: [MENU, pane(), PAUSED] }))).toMatchObject([{ shape: "window", placeholderPane: "%5" }]);
    const split = [MENU, pane({ window: "notes", paneId: "%8", cwd: "/home/dev" }), pane({ window: "notes" }), PAUSED];
    expect(planAdoptions(inputs({ panes: split }))).toMatchObject([{ shape: "pane", placeholderPane: "%5" }]);
  });

  test("a paused tab for the same session in ANOTHER launcher's host is not ours, and does not block", () => {
    const elsewhere = pane({ ...PAUSED, session: "agendo-other" });
    const [plan] = planAdoptions(inputs({ panes: [MENU, pane(), elsewhere] }));
    expect(plan).toMatchObject({ shape: "window", name: CANON });
    expect(plan!.placeholderPane).toBeUndefined();
  });

  // Retirement kills one pane. If the user split the paused tab's window, the
  // other pane would keep that window alive under the canonical name beside the
  // adopted one — so nothing is adopted, and nothing is killed, until it is a
  // single pane again or gone.
  test("a paused tab the user has SPLIT is left alone, and so is the adoption", () => {
    const beside = pane({ window: CANON, windowIndex: "2", paneId: "%6", placeholder: true, cwd: "/home/dev" });
    expect(planAdoptions(inputs({ panes: [MENU, pane(), PAUSED, beside] }))).toEqual([]);
  });

  test("a paused tab for some OTHER session is nobody's business here", () => {
    const other = pane({ ...PAUSED, window: "cl-claude-aaaaaaaaaaaa" });
    expect(planAdoptions(inputs({ panes: [MENU, pane(), other] }))[0]!.placeholderPane).toBeUndefined();
  });

  // A placeholder is never in `live` (reconcileLive drops it when no real window
  // vouches for it), but a session that IS running somewhere keeps blocking
  // adoption even with a paused tab beside it — nothing is adopted twice.
  test("a session that is running elsewhere is still never adopted", () => {
    expect(planAdoptions(inputs({ panes: [MENU, pane(), PAUSED], live: new Set([CANON]) }))).toEqual([]);
  });
});
