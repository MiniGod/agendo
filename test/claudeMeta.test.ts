// What a Claude transcript says about its session (src/sessions/claude.ts,
// scanClaudeMeta). The e2e fixtures write one transcript shape: a cwd and a
// timestamp on the first record, one branch, at most one title. Here the arms
// the fixtures never take sit beside the ones they do: a base branch demoted
// under a later feature branch and a base-only session, each title kind and
// the precedence between them, a bad timestamp, and a blank or broken line.
import { describe, expect, test } from "bun:test";
import { scanClaudeMeta } from "../src/sessions/claude.ts";

const lines = (...recs: unknown[]) => recs.map((r) => (typeof r === "string" ? r : JSON.stringify(r))).join("\n");

describe("scanClaudeMeta", () => {
  test("the first cwd and the first parseable timestamp win; a bad timestamp is skipped", () => {
    const m = scanClaudeMeta(lines({ timestamp: "not a date" }, { cwd: "/a", timestamp: "2026-09-01T10:00:00Z" }, { cwd: "/b", timestamp: "2026-09-02T10:00:00Z" }), "t.jsonl");
    expect(m.cwd).toBe("/a");
    expect(m.createdAt).toEqual(new Date("2026-09-01T10:00:00Z"));
  });

  test("the last non-base branch outranks a later master; a base-only session keeps its base", () => {
    expect(scanClaudeMeta(lines({ gitBranch: "master" }, { gitBranch: "feat/x" }, { gitBranch: "master" }), "t").branch).toBe("feat/x");
    expect(scanClaudeMeta(lines({ gitBranch: "feat/x" }, { gitBranch: "feat/y" }), "t").branch).toBe("feat/y");
    expect(scanClaudeMeta(lines({ gitBranch: "main" }, { gitBranch: "master" }), "t").branch).toBe("master");
    expect(scanClaudeMeta(lines({ cwd: "/a" }), "t").branch).toBeUndefined();
  });

  test("a custom title outranks an AI title outranks an agent name, each the last of its kind", () => {
    const custom = { type: "custom-title", customTitle: "Mine" };
    const ai = { type: "ai-title", aiTitle: "Theirs" };
    const agent = { type: "agent-name", agentName: "worker" };
    expect(scanClaudeMeta(lines(agent, ai, custom), "t").title).toBe("Mine");
    expect(scanClaudeMeta(lines(custom, { type: "custom-title", customTitle: "Renamed" }), "t").title).toBe("Renamed");
    expect(scanClaudeMeta(lines(agent, ai), "t").title).toBe("Theirs");
    expect(scanClaudeMeta(lines(agent), "t").title).toBe("worker");
    expect(scanClaudeMeta(lines({ type: "custom-title" }, { type: "ai-title", aiTitle: "" }), "t").title).toBeUndefined();
  });

  test("blank lines, a broken line and a non-object record are skipped, not fatal", () => {
    const m = scanClaudeMeta(lines("", "{not json", "42", { cwd: "/a" }, ""), "t.jsonl");
    expect(m.cwd).toBe("/a");
    expect(m.workflows).toBeUndefined();
  });
});
