// One row of the enriched `agendo list` (src/cli/listRow.ts) and the query
// behind `--pr` / `--issue` (src/cli/list.ts). The e2e suite lists real
// fixture sessions through a real tmux; what it never shows is a link whose
// URL could not be built, the global orchestrator's absent repo, a session
// on a PR linked to two items, or a running session whose window tmux can no
// longer place. Those arms are here, on a context of maps.
import { describe, expect, test } from "bun:test";
import { querySessions } from "../src/cli/list.ts";
import {
  linkFields, listRow, liveFields, paneFields, repoFields, rowWorkflows, usableLink, type ListRowContext,
} from "../src/cli/listRow.ts";
import type { LoadedModel } from "../src/model.ts";
import type { AgentSession } from "../src/types.ts";

const session = (id: string, over: Partial<AgentSession> = {}): AgentSession =>
  ({ source: "claude", id, cwd: "/w/repo", title: "  Fix   the thing ", lastUsed: new Date("2026-09-02T09:00:00Z"), ...over }) as AgentSession;

const ctxIn = (over: Partial<ListRowContext> = {}): ListRowContext => ({
  live: new Set(),
  liveKinds: new Map(),
  liveWindows: new Map(),
  roles: new Map(),
  linkOf: () => undefined,
  thresholdMs: 1_500,
  readBranchSync: null,
  ...over,
});

describe("the parts", () => {
  test("a link without a URL reads as absent, nested and flattened alike", () => {
    expect(usableLink(undefined)).toBeNull();
    expect(usableLink({ id: 7, url: "" })).toBeNull();
    expect(usableLink({ id: 7, url: "https://x/7" })).toEqual({ id: 7, url: "https://x/7" });
    expect(linkFields(undefined)).toEqual({ pr: null, workItem: null, prUrl: null, workItemUrl: null });
    expect(linkFields({ pr: { id: 7, url: "https://x/7" }, workItem: { id: 1, url: "" } })).toEqual({
      pr: { id: 7, url: "https://x/7" }, workItem: null, prUrl: "https://x/7", workItemUrl: null,
    });
  });

  test("the global orchestrator belongs to no repo; everyone else to the checkout around their cwd", () => {
    expect(repoFields("global", "/w/vantage")).toEqual({ repoRoot: null, repoName: null });
    const r = repoFields("repo", "/w/repo");
    expect(r.repoRoot).toBe("/w/repo");
    expect(r.repoName).toBe("repo");
  });

  test("no pane to read is the nulls and zeros, never a tmux call", () => {
    expect(paneFields(undefined)).toEqual({ readiness: null, shells: 0, backgroundAgents: 0, resumeDialog: false, resetAt: null, compactionPercent: null });
  });

  test("live: not running, running with a window tmux cannot place, running with a kind", () => {
    const s = session("abcdef123456-0000-0000-0000-000000000000");
    const canon = "cl-claude-abcdef123456";
    expect(liveFields(s, ctxIn())).toMatchObject({ running: false, kind: null, pane: { readiness: null } });
    expect(liveFields(s, ctxIn({ live: new Set([canon]) }))).toMatchObject({ running: true, kind: null, pane: { readiness: null } });
    expect(liveFields(s, ctxIn({ live: new Set([canon]), liveKinds: new Map([[canon, "background"]]) })).kind).toBe("background");
  });

  test("workflows carry their effective status and a summary or null", () => {
    const s = session("a", { workflows: [{ runId: "r1", name: "n", notifiedStatus: "completed" }, { runId: "r2", name: "m", summary: "two" }] });
    expect(rowWorkflows(session("b"), true)).toEqual([]);
    expect(rowWorkflows(s, false)).toEqual([
      { runId: "r1", name: "n", status: "completed", summary: null },
      { runId: "r2", name: "m", status: expect.any(String), summary: "two" },
    ]);
  });
});

describe("listRow", () => {
  test("an idle session: squashed title, exact threshold, links flattened, git only when asked", () => {
    const s = session("abcdef123456-0000-0000-0000-000000000000", { branch: "feat" });
    const row = listRow(s, ctxIn({ linkOf: () => ({ pr: { id: 7, url: "https://x/7" } }) }));
    expect(row).toMatchObject({
      shortId: "abcdef123456", running: false, readiness: null, kind: null, orchestrator: false, role: null, branch: "feat",
      repoRoot: "/w/repo", repoName: "repo", dir: "repo", title: "Fix the thing", lastUsed: "2026-09-02T09:00:00.000Z",
      stalled: false, stalledAfterSeconds: 1.5, git: null, pr: { id: 7, url: "https://x/7" }, prUrl: "https://x/7", workItem: null, workItemUrl: null,
      limitResetAt: null, workflows: [],
    });
    const sync = { ahead: 1, behind: 0 } as unknown as NonNullable<ReturnType<ListRowContext["readBranchSync"] & object>>;
    expect(listRow(s, ctxIn({ readBranchSync: () => sync as never })).git).toBe(sync);
  });

  test("an orchestrator's row says so, and the global one has no repo", () => {
    const s = session("g");
    const row = listRow(s, ctxIn({ roles: new Map([["g", "global"]]) }));
    expect(row).toMatchObject({ orchestrator: true, role: "global", repoRoot: null, repoName: null });
  });
});

describe("querySessions", () => {
  test("a PR's sessions and an item's sessions, from the forward lists, deduped by source:id", () => {
    const a = session("a");
    const b = session("b");
    const m = {
      linkedPrs: [{ id: 7, sessions: [a] }], orphanPrs: [{ id: 8, sessions: [b] }], reviewPrs: [],
      current: [{ id: 1, sessions: [a, b] }], other: [], prLinked: [{ id: 2, sessions: [b] }],
    } as unknown as LoadedModel;
    expect(querySessions(m, 7, undefined)).toEqual([a]);
    expect(querySessions(m, undefined, 1)).toEqual([a, b]);
    expect(querySessions(m, 7, 2)).toEqual([a, b]);
    expect(querySessions(m, 9, 9)).toEqual([]);
  });
});
