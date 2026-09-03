// The pure halves of `list issues` and `list pr` (src/cli/listIssues.ts,
// src/cli/listPrs.ts, src/cli/resources.ts): the rows each builds from the
// model, and the table line each prints. The e2e suite runs both commands
// against the fixture backend and reads the tables; it never lists a work item
// that appears in two of the model's lists, never a PR number shared by two
// repos, never an idle session on a row, and never a draft PR.
import { describe, expect, test } from "bun:test";
import { formatIssueRow, issueHeader, issueRows } from "../src/cli/listIssues.ts";
import { formatPrRow, PR_HEADER, prRows } from "../src/cli/listPrs.ts";
import { oneLine, sessionMark } from "../src/cli/resources.ts";
import { sessionName } from "../src/tmux.ts";
import type { AgentSession, LinkedPR, PRWithSessions, WorkItem } from "../src/types.ts";

const session = (id: string, lastUsed = 1): AgentSession => ({ id, source: "claude", cwd: "/w", title: id, lastUsed: new Date(lastUsed) });
const item = (id: number, p: Partial<WorkItem> = {}): WorkItem => ({
  id, type: "Task", title: `Item ${id}`, state: "Active", iterationPath: "", project: "p", inCurrentSprint: true, prs: [], url: "", sessions: [], ...p,
} as WorkItem);
const pr = (id: number, p: Partial<PRWithSessions> = {}): PRWithSessions => ({
  id, title: `PR ${id}`, status: "active", branch: `feat/${id}`, repositoryId: "r1", isDraft: false, approvals: 0, rejections: 0, waiting: 0,
  approvedCount: 0, requiredCount: 0, ci: "none", updatedDate: id, url: "", sessions: [], ...p,
} as PRWithSessions);

describe("sessionMark and oneLine", () => {
  test("running, idle, none; a title's whitespace collapsed", () => {
    expect(sessionMark([{ id: "a", shortId: "a", source: "claude", running: true }])).toBe("●");
    expect(sessionMark([{ id: "a", shortId: "a", source: "claude", running: false }])).toBe("○");
    expect(sessionMark([])).toBe(" ");
    expect(oneLine("  a\n  b\t c ")).toBe("a b c");
  });
});

describe("issueRows and formatIssueRow", () => {
  test("the three lists merge without repeats, newest id first; a row shows its best session", () => {
    const live = new Set([sessionName(session("run"))]);
    const rows = issueRows({
      current: [item(3, { sessions: [session("idle", 5), session("run", 1)] })],
      other: [item(3), item(1, { title: " two\nlines ", state: "", url: "https://x/1" })],
      prLinked: [item(2)],
      liveTmux: live,
    });
    expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(rows[2]).toMatchObject({ title: "two lines", url: "https://x/1", sessions: [] });
    expect(rows[0].url).toBeNull();
    expect(rows[0].sessions[0]).toMatchObject({ id: "run", running: true });
    expect(issueHeader("issue")).toBe("  id       state           session       issue");
    expect(formatIssueRow(rows[0])).toMatch(/^●  #3       Active          run\S*\s+Item 3$/);
    expect(formatIssueRow(rows[2])).toBe("   #1       -               -             two lines");
  });
});

/** A PR under a work item, as the linked list carries it. */
const linked = (p: PRWithSessions): LinkedPR => ({ ...p, workItemId: 1, workItemType: "Task", workItemTitle: "t", workItemUrl: "https://x/wi/1" });

describe("prRows and formatPrRow", () => {
  test("PRs dedupe by repo:id, sort by update then id; the row carries the prefix, the draft mark and the gate", () => {
    const rows = prRows({
      linkedPrs: [linked(pr(7, { updatedDate: 10 })), linked(pr(7, { repositoryId: "r2", updatedDate: 10, title: "same number, other repo" }))],
      orphanPrs: [pr(7), pr(9, { updatedDate: 10, isDraft: true, gateMet: false, repositoryName: "agendo", url: "https://x/9" })],
      liveTmux: new Set(),
    });
    expect(rows.map((r) => [r.id, r.repositoryId])).toEqual([[9, "r1"], [7, "r1"], [7, "r2"]]);
    expect(rows[0]).toMatchObject({ gateMet: false, repositoryName: "agendo", url: "https://x/9" });
    expect(rows[1]).toMatchObject({ gateMet: null, repositoryName: null, url: null });
    expect(PR_HEADER).toBe("  pr      ci        appr   branch                    session       title");
    expect(formatPrRow(rows[0], "#")).toBe("   #9      none      -      feat/9                    -             [draft] PR 9");
    expect(formatPrRow(rows[2], "!")).toBe("   !7      none      -      feat/7                    -             same number, other repo");
  });
});
