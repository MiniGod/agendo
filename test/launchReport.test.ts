// The launch report (src/cli/launchReport.ts): which kind of session a flag set
// names, and the next-steps lines printed for it. The e2e suite reads the real
// report for a background launch with an id and for a global orchestrator; it
// never sees the codex shape (no id yet) beside a layout note, and never asks
// for the kind on its own.
import { describe, expect, test } from "bun:test";
import { SELF_CMD } from "../src/launch.ts";
import { launchSummary, sessionKind } from "../src/cli/launchReport.ts";

const kind = (global: boolean, orchestrator: boolean, agent: "claude" | "codex" = "claude") => ({ global, orchestrator, agent });

describe("sessionKind", () => {
  test("global wins over orchestrator, orchestrator over background", () => {
    expect(sessionKind(kind(true, true))).toBe("global orchestrator");
    expect(sessionKind(kind(true, false))).toBe("global orchestrator");
    expect(sessionKind(kind(false, true))).toBe("orchestrator");
    expect(sessionKind(kind(false, false))).toBe("background");
  });
});

describe("launchSummary", () => {
  test("a session with an id gets a status line and no layout line", () => {
    const lines = launchSummary(kind(false, true), { id: "abc123", cwd: "/w", tmuxName: "cl-bg-abc123" }, null);
    expect(lines).toEqual([
      "▸ launched orchestrator session abc123",
      "  window:  cl-bg-abc123   (in /w)",
      `  status:  ${SELF_CMD} status abc123`,
      "  attach:  open agendo and pick it (running → attach), or rerun with --attach",
    ]);
  });

  test("no id yet sends the caller to list; a global launch reports its layout and why", () => {
    const landed = { cwd: "/w", tmuxName: "cl-bg-x" };
    const withNote = { cwd: "/w", layout: "window" as const, layoutNote: "no pane: not inside the TUI" };
    expect(launchSummary(kind(true, false, "codex"), landed, withNote)).toEqual([
      "▸ launched global orchestrator session — codex assigns its own id",
      "  window:  cl-bg-x   (in /w)",
      `  id:      ${SELF_CMD} list   (then: ${SELF_CMD} status <id>)`,
      "  layout:  its own tmux window — no pane: not inside the TUI",
      "  attach:  open agendo and pick it (running → attach), or rerun with --attach",
    ]);
    const asked = { cwd: "/w", layout: "pane" as const, layoutNote: null };
    expect(launchSummary(kind(true, false), landed, asked)[3]).toBe("  layout:  split pane beside the agendo TUI");
  });
});
