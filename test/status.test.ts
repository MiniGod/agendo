// The pure parts of `agendo status` (src/cli/status.ts). The e2e suite drives
// the command against fixture sessions and reaches every line it prints; what
// it never varies is the shape of what those lines are built from — a workflow
// with no launch time, one that is running but has done nothing yet, a model
// tally with one of each, a link whose URL could not be built, a branch with
// no upstream at all. Those are here, one arm beside the next.
import { describe, expect, test } from "bun:test";
import { describeSync, paneFacts, usableLinks, workflowAgents, workflowBits, workflowDescription, workflowPhases } from "../src/cli/status.ts";
import type { BranchSync, WorkflowDetails, WorkflowRef } from "../src/types.ts";

const ref = (over: Partial<WorkflowRef> = {}): WorkflowRef => ({ runId: "wf_1", name: "review", ...over });
const details = (over: Partial<WorkflowDetails> = {}): WorkflowDetails => ({ agentsStarted: 3, agentsDone: 1, ...over }) as WorkflowDetails;

describe("a workflow's line", () => {
  test("the tally: agents done, then when it started and — only while running — when it last did anything", () => {
    const now = Date.now();
    expect(workflowBits(ref(), "running", details())).toEqual(["1/3 agents done"]);
    expect(workflowBits(ref({ launchedAt: new Date(now - 120_000) }), "completed", details({ lastActivity: new Date(now) }))).toEqual([
      "1/3 agents done", expect.stringMatching(/^started /),
    ]);
    expect(workflowBits(ref(), "running", details({ lastActivity: new Date(now - 5_000) }))).toEqual([
      "1/3 agents done", expect.stringMatching(/^active /),
    ]);
  });

  test("the description: the ref's summary over the run's, cut at 120 unless --full", () => {
    const long = "x".repeat(150);
    expect(workflowDescription(ref(), details(), false)).toBeNull();
    expect(workflowDescription(ref({ summary: "mine" }), details({ description: "theirs" }), false)).toBe("mine");
    expect(workflowDescription(ref(), details({ description: long }), false)).toBe("x".repeat(120));
    expect(workflowDescription(ref(), details({ description: long }), true)).toBe(long);
  });

  test("the agents: sorted by model, counted only when there is more than one", () => {
    expect(workflowAgents({ sonnet: 2, haiku: 1, opus: 3 })).toBe("haiku, opus ×3, sonnet ×2");
    expect(workflowAgents({})).toBe("");
  });

  test("the phases: titles, with the model where one was pinned", () => {
    expect(workflowPhases([{ title: "Review", model: "opus" }, { title: "Verify" }] as NonNullable<WorkflowDetails["phases"]>)).toBe("Review (opus) → Verify");
  });
});

describe("the rest", () => {
  test("a link without a URL reads as absent, for the PR and the item alike", () => {
    expect(usableLinks(undefined)).toEqual({ pr: undefined, workItem: undefined });
    expect(usableLinks({ pr: { id: 7, url: "" }, workItem: { id: 1, url: "https://x/1" } })).toEqual({ pr: undefined, workItem: { id: 1, url: "https://x/1" } });
  });

  test("no window is no pane, and nothing read from one", () => {
    expect(paneFacts(undefined)).toEqual({ pane: null, readiness: null, resumeDialog: false, backgroundAgents: 0 });
    expect(paneFacts(null)).toEqual({ pane: null, readiness: null, resumeDialog: false, backgroundAgents: 0 });
  });

  test("the work line: in sync, diverged, never pushed, and no upstream to say", () => {
    const sync = (over: Partial<BranchSync>): BranchSync => ({ branch: "feat", upstream: "origin/feat", unpushed: false, hasRemoteRef: true, upstreamConfigured: true, ...over }) as BranchSync;
    expect(describeSync(sync({}))).toBe("HEAD on feat — matches origin/feat (from .git refs, no fetch)");
    expect(describeSync(sync({ unpushed: true }))).toBe("HEAD on feat — differs from origin/feat: unpushed or diverged (from .git refs, no fetch)");
    expect(describeSync(sync({ unpushed: true, hasRemoteRef: false }))).toBe("HEAD on feat — nothing at origin/feat yet: never pushed (from .git refs, no fetch)");
    expect(describeSync(sync({ unpushed: true, hasRemoteRef: false, upstreamConfigured: false }))).toBe(
      "HEAD on feat — no origin/feat ref and no configured upstream: unpushed, or tracking another remote (from .git refs, no fetch)",
    );
  });
});
