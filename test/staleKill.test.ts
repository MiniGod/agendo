// The Sessions view's `K` (src/ui/actions/staleKill.ts): what it says when it
// has nothing to do, what its y/n asks, and the notice a batch ends on. e2e
// drives the happy path and the cancel against the fake tmux; the arms that need
// a refusal beside a plan, or a batch that half-landed, are pinned here.
import { describe, expect, test } from "bun:test";
import { refused, type EndOutcome, type EndPlan, type Inspection } from "../src/app/sessionEnd/index.ts";
import type { OrchestratorCandidate, OrchestratorState } from "../src/orchestration/repoOrchestrator.ts";
import { endExtra, staleAskStep, stoppedNotice, staleKillRefusal, staleOutcomeNotice, staleQuestion } from "../src/ui/actions/staleKill.ts";
import type { AgentSession } from "../src/shared/types.ts";

const session = (title: string): AgentSession => ({ id: `id-${title}`, source: "claude", cwd: "/r", title, lastUsed: new Date(2026, 9, 1) });
const cand = (title: string, state: OrchestratorState = "running"): OrchestratorCandidate => ({ session: session(title), state, recorded: true });
// Only `kind` is read off a plan by staleAskStep.
const plan = { kind: "plan" } as Inspection;
const REPO = { root: "/r", lookAlikes: false };
const busy = refused(2, 'session looks "busy"', 'session looks "busy"', ["…"]);

describe("staleKillRefusal", () => {
  test("over several repos, or with no block, K says it needs a one-repo scope", () => {
    expect(staleKillRefusal(null)).toContain("scope agendo to one repo");
    expect(staleKillRefusal({ repoScope: false, lines: [], killable: [], killRoot: null, killLookAlikes: false, killBlocked: null })).toContain("scope agendo to one repo");
  });

  test("while the repo's orchestrator is starting, K refuses with the block's reason", () => {
    expect(staleKillRefusal({ repoScope: true, lines: [], killable: [cand("a")], killRoot: "/r", killLookAlikes: true, killBlocked: "wait" })).toBe("wait");
  });

  test("a repo with nothing open to kill says so; one with extras goes ahead", () => {
    expect(staleKillRefusal({ repoScope: true, lines: [], killable: [], killRoot: "/r", killLookAlikes: false, killBlocked: null })).toBe("No extra orchestrator with a window open in this repo — nothing to kill.");
    expect(staleKillRefusal({ repoScope: true, lines: [], killable: [cand("a")], killRoot: "/r", killLookAlikes: false, killBlocked: null })).toBeNull();
  });
});

describe("staleAskStep", () => {
  test("every one passed: a y/n naming how many and which", () => {
    const step = staleAskStep(REPO, [cand("a", "paused"), cand("b")], [plan, plan], false);
    expect(step.notice).toBeNull();
    expect(step.mode).toEqual({
      kind: "confirmEndStale",
      root: "/r",
      lookAlikes: false,
      sessions: [session("a"), session("b")],
      prompt: "Kill 2 extra orchestrators — a (⏸ paused), b (● running)?",
      skipped: [],
    });
  });

  test("one x would refuse is left out of the question and named with why", () => {
    const step = staleAskStep(REPO, [cand("a"), cand("b")], [busy, plan], false);
    expect(step.mode?.kind === "confirmEndStale" && step.mode.prompt).toBe("Kill 1 extra orchestrator — b (● running)?");
    expect(step.mode?.kind === "confirmEndStale" && step.mode.skipped).toEqual([
      { id: "id-a", title: "a", why: 'a (session looks "busy")' },
    ]);
  });

  test("none passed: no question, only the reasons", () => {
    const gone: Inspection = { kind: "notRunning", found: { s: undefined, sid: "b", label: "b" } };
    const step = staleAskStep(REPO, [cand("a"), cand("b")], [busy, gone], false);
    expect(step.mode).toBeUndefined();
    expect(step.notice).toBe('None killed: a (session looks "busy"), b (not running any more).');
  });

  test("keys pressed while it checked: not asked, so the next keystroke can't answer it", () => {
    const step = staleAskStep(REPO, [cand("a")], [plan], true);
    expect(step.mode).toBeUndefined();
    expect(step.notice).toContain("K asks again");
  });
});

test("staleQuestion: singular, and look-alikes named as such in a repo with no orchestrator", () => {
  expect(staleQuestion([cand("a", "paused")])).toBe("Kill 1 extra orchestrator — a (⏸ paused)?");
  expect(staleQuestion([cand("a"), cand("b")], true)).toBe("Kill 2 orchestrator look-alikes — a (● running), b (● running)?");
});

describe("staleOutcomeNotice", () => {
  const done = { kind: "done" } as EndOutcome;
  test("all killed: counted and named, with what was kept", () => {
    expect(staleOutcomeNotice([{ s: session("a"), o: done }, { s: session("b"), o: done }])).toBe(
      "✕ killed 2 extra orchestrators: a, b — worktrees, branches, transcripts kept.",
    );
  });

  test("one refused on the re-check, and one skipped before the question: both named after the kills", () => {
    const got = staleOutcomeNotice([{ s: session("a"), o: done }, { s: session("b"), o: busy }], [{ id: "id-c", title: "c", why: "c (x)" }]);
    expect(got).toBe('✕ killed 1 extra orchestrator: a — worktrees, branches, transcripts kept. Not killed: b (session looks "busy"), c (x).');
  });

  test("nothing landed", () => {
    expect(staleOutcomeNotice([{ s: session("a"), o: busy }])).toBe('None killed: a (session looks "busy").');
  });

  test("a whole-prompt title is flattened and capped, as the ⚠ line shows it, so the notice stays short", () => {
    const long = session(`do this\nthen ${"x".repeat(200)}`);
    const got = staleOutcomeNotice([{ s: long, o: done }]);
    expect(got).not.toContain("\n");
    expect(got.length).toBeLessThan(120);
  });
});

test("endExtra: one that became the primary while the question was up is refused, not killed", () => {
  // The primary branch returns before the plan is performed, so nothing is killed.
  const o = endExtra(session("b"), plan as EndPlan, { primary: "id-b", starting: false });
  expect(o).toEqual(refused(1, "it is now the one O/G opens", "it is now the one O/G opens"));
  expect(staleOutcomeNotice([{ s: session("b"), o }])).toBe("None killed: b (it is now the one O/G opens).");
});

test("stoppedNotice: one starting mid-batch stops it with ONE reason, after whatever was already killed", () => {
  const done = { kind: "done" } as EndOutcome;
  expect(stoppedNotice([], [], false)).toBe("None killed. Stopped: an orchestrator started in this repo meanwhile — K again once it is up.");
  expect(stoppedNotice([{ s: session("a"), o: done }], [{ id: "id-c", title: "c", why: "c (busy)" }], true)).toBe(
    "✕ killed 1 orchestrator look-alike: a — worktrees, branches, transcripts kept. Not killed: c (busy). Stopped: an orchestrator started in this repo meanwhile — K again once it is up.",
  );
  expect(stoppedNotice([], [{ id: "id-c", title: "c", why: "c (busy)" }], false)).toBe(
    "None killed: c (busy). Stopped: an orchestrator started in this repo meanwhile — K again once it is up.",
  );
});
