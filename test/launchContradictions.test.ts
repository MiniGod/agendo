import { describe, expect, test } from "bun:test";
import { launchContradiction, type LaunchArgs } from "../src/cli/launchCmd.ts";

/** A `launch` with no flags: nothing to contradict. */
function args(over: Partial<LaunchArgs> = {}): LaunchArgs {
  return {
    attach: false, orchestrator: false, global: false, unattended: false,
    agent: "claude", forwardArgv: [], positionals: [], ...over,
  };
}

describe("launchContradiction", () => {
  test("a plain launch, and every flag on its own, is allowed", () => {
    expect(launchContradiction(args())).toBeNull();
    expect(launchContradiction(args({ worktreePath: "/w" }))).toBeNull();
    expect(launchContradiction(args({ name: "fix", worktree: true }))).toBeNull();
    expect(launchContradiction(args({ orchestrator: true, unattended: true }))).toBeNull();
    expect(launchContradiction(args({ global: true, layout: "pane", unattended: true }))).toBeNull();
    expect(launchContradiction(args({ agent: "copilot" }))).toBeNull();
  });

  test("--worktree=<path> refuses the flags that would pick another directory", () => {
    expect(launchContradiction(args({ worktreePath: "/w", name: "fix" }))).toBe(
      "--worktree=<path> can't be combined with --name (it already says where to run)",
    );
    expect(launchContradiction(args({ worktreePath: "/w", worktree: true }))).toContain("a bare --worktree");
    expect(launchContradiction(args({ worktreePath: "/w", worktree: false }))).toContain("with --no-worktree");
  });

  test("an orchestrator is Claude-only, and the message names the flag that asked", () => {
    expect(launchContradiction(args({ orchestrator: true, agent: "copilot" }))).toBe(
      "--orchestrator is Claude-only (no --append-system-prompt equivalent in --agent copilot)",
    );
    expect(launchContradiction(args({ global: true, agent: "codex" }))).toStartWith("--global-orchestrator is Claude-only");
  });

  test("the global orchestrator refuses the repo-shaped flags", () => {
    expect(launchContradiction(args({ global: true, worktree: false }))).toContain("--worktree/--no-worktree don't apply");
    expect(launchContradiction(args({ global: true, worktreePath: "/w" }))).toContain("--worktree/--no-worktree don't apply");
    expect(launchContradiction(args({ global: true, name: "fix" }))).toContain("--name doesn't apply");
  });

  test("layout and --unattended need an orchestrator", () => {
    expect(launchContradiction(args({ layout: "window" }))).toBe("--window/--pane only apply to --global-orchestrator");
    expect(launchContradiction(args({ orchestrator: true, layout: "window" }))).toContain("only apply to --global-orchestrator");
    expect(launchContradiction(args({ unattended: true }))).toContain("only applies with --orchestrator");
  });

  test("checks run in their historical order, so the first clash wins", () => {
    // Both the worktree-path and the agent check fail; the path one was always first.
    expect(launchContradiction(args({ worktreePath: "/w", name: "x", orchestrator: true, agent: "codex" }))).toContain("--worktree=<path>");
    // Global + copilot + name: the agent check precedes the global-name one.
    expect(launchContradiction(args({ global: true, agent: "copilot", name: "x" }))).toContain("Claude-only");
  });
});
