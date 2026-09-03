// The pure halves of `list repos` (src/cli/listRepos.ts): how a session counts
// into its repo's row, the order rows are printed in, the empty-case message
// and the table line. The e2e suite runs the real command over fixture sessions
// and reads the table; it never sees an empty survey (both empty messages were
// the lines no spec reached), never sorts two repos that differ only in idle
// orchestrators, and never prints an idle orchestrator's row.
import { describe, expect, test } from "bun:test";
import { addSession, byNeed, emptyMessage, formatRepoRow, REPO_HEADER, type RepoRow } from "../src/cli/listRepos.ts";

const row = (p: Partial<RepoRow> = {}): RepoRow => ({
  root: "/r/a", name: "a", sessions: 0, running: 0, orchestrators: [], hasOrchestrator: false, hasRunningOrchestrator: false, ...p,
});

describe("addSession", () => {
  test("a plain session only counts; a repo orchestrator is listed, and marks the row running only while it runs", () => {
    const r = row();
    addSession(r, { id: "s1" }, true, undefined);
    addSession(r, { id: "s2" }, false, "global");
    expect(r).toMatchObject({ sessions: 2, running: 1, orchestrators: [], hasOrchestrator: false, hasRunningOrchestrator: false });
    addSession(r, { id: "orch-idle-0001" }, false, "repo");
    expect(r).toMatchObject({ sessions: 3, running: 1, hasOrchestrator: true, hasRunningOrchestrator: false });
    addSession(r, { id: "orch-live-0002" }, true, "repo");
    expect(r).toMatchObject({ sessions: 4, running: 2, hasOrchestrator: true, hasRunningOrchestrator: true });
    expect(r.orchestrators.map((o) => [o.id, o.running])).toEqual([["orch-idle-0001", false], ["orch-live-0002", true]]);
  });
});

describe("byNeed", () => {
  test("unmanaged first, then remembered-only, then busier, then by name", () => {
    const managedRunning = row({ name: "d", hasOrchestrator: true, hasRunningOrchestrator: true, running: 5, sessions: 9 });
    const managedIdle = row({ name: "c", hasOrchestrator: true, running: 5, sessions: 9 });
    const busy = row({ name: "b", running: 1, sessions: 1 });
    const quietA = row({ name: "a", sessions: 2 });
    const quietZ = row({ name: "z", sessions: 2 });
    const sorted = [managedRunning, quietZ, managedIdle, busy, quietA].sort(byNeed).map((r) => r.name);
    expect(sorted).toEqual(["b", "a", "z", "c", "d"]);
  });
});

describe("emptyMessage", () => {
  test("a scoped path survey says checkouts; unscoped or --repo says sessions", () => {
    expect(emptyMessage(null)).toBe("No repos with agent sessions.");
    expect(emptyMessage({ roots: ["/w"], repo: null })).toMatch(/^No git checkouts /);
    expect(emptyMessage({ roots: ["/w"], repo: "agendo" })).toMatch(/^No repos with agent sessions /);
    expect(emptyMessage({ roots: [], repo: "agendo" })).toMatch(/^No repos with agent sessions /);
  });
});

describe("formatRepoRow", () => {
  test("the orchestrator column shows the first one with its state, or none", () => {
    expect(REPO_HEADER).toBe("repo                      sessions  running  orchestrator  root");
    expect(formatRepoRow(row({ sessions: 3, running: 1 }))).toBe("a                         3         1        none          /r/a");
    const live = row({ orchestrators: [{ id: "x", shortId: "abcd1234", running: true }] });
    expect(formatRepoRow(live)).toBe("a                         0         0        ● abcd1234    /r/a");
    const idle = row({ orchestrators: [{ id: "x", shortId: "abcd1234", running: false }] });
    expect(formatRepoRow(idle)).toBe("a                         0         0        ○ abcd1234    /r/a");
  });
});
