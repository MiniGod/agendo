// What `launch --orchestrator` prints when the repo already has one
// (src/cli/commands/launchExisting.ts). e2e runs the guard over the fixture
// sessions, which give it one recorded orchestrator at a time; the arms that
// need a stale extra beside it, or a window too new to have a transcript, are
// pinned here. The command prefix differs between a local run and CI, so the
// lines are read past it rather than matched whole.
import { describe, expect, test } from "bun:test";
import { ignoredFlags, lookAlikeReport, reuseReport, type NewOnlyFlags } from "../src/cli/commands/launchExisting.ts";
import type { ExistingOrchestrator } from "../src/launch/existingOrchestrator.ts";
import type { OrchestratorCandidate, OrchestratorState } from "../src/orchestration/repoOrchestrator.ts";
import type { ManagedTarget } from "../src/runtime/tmux/index.ts";

const ID = "c9eee429-ff60-400c-90fa-e8a6aae2d017";
const OLD = "0e6e2941-4a1b-4c2d-9e3f-0123456789ab";

const cand = (id: string, title: string, state: OrchestratorState, recorded = true): OrchestratorCandidate => ({
  session: { id, source: "claude", cwd: "/git/agendo", title, lastUsed: new Date(2026, 9, 1) },
  state,
  recorded,
});
const found = (primary: OrchestratorCandidate, stale: OrchestratorCandidate[] = []): ExistingOrchestrator => ({
  kind: "session",
  status: { root: "/git/agendo", name: "agendo", primary, stale },
  primary,
});

describe("reuseReport", () => {
  test("running: left alone, and the prompt it was given is NOT delivered but spelled out as a send", () => {
    const [head, prompt, ...rest] = reuseReport("agendo", found(cand(ID, "orch-agendo", "running")), "do the thing");
    expect(head).toBe("▸ agendo already has an orchestrator (running): orch-agendo (claude) — not starting a second");
    expect(prompt).toMatch(/^ {2}prompt: {2}NOT delivered — send it with `.* send c9eee429ff60 "<prompt>"`$/);
    expect(rest).toEqual(["  link:    agendo://focus?session=c9eee429ff60"]);
  });

  test("idle with an extra beside it: resumed, the extra named and left alone, and no prompt to warn about", () => {
    const lines = reuseReport("agendo", found(cand(ID, "orch-agendo", "idle"), [cand(OLD, "agendo-orchestrator", "paused", false)]), "");
    expect(lines[0]).toBe("▸ agendo already has an orchestrator (idle): orch-agendo (claude) — resuming it instead of starting a second");
    expect(lines[1]).toBe("  extra:   0e6e29414a1b  agendo-orchestrator (paused) — left alone");
    expect(lines[2]).toMatch(/^ {2}send: {4}`.* send c9eee429ff60 "<prompt>"`$/);
    expect(lines[3]).toBe("  link:    agendo://focus?session=c9eee429ff60");
    expect(lines).toHaveLength(4);
  });

  test("a paused one is resumed too", () => {
    expect(reuseReport("agendo", found(cand(ID, "orch-agendo", "paused")), "")[0]).toContain("(paused): orch-agendo (claude) — resuming it instead");
  });

  test("a window too new to have a session: starting, and sent to by its window name", () => {
    const target: ManagedTarget = {
      name: "cl-new-c9eee429ff60", target: "=agendo:=cl-new-c9eee429ff60", cwd: "/git/agendo",
      placeholder: false, session: "agendo", windowIndex: "3",
    };
    const lines = reuseReport("agendo", { kind: "pending", target }, "hi");
    expect(lines[0]).toBe("▸ agendo already has an orchestrator (starting): cl-new-c9eee429ff60 (just started) — not starting a second");
    expect(lines[1]).toContain(' send cl-new-c9eee429ff60 "<prompt>"');
  });

  test("a Codex window too new to have a session: no token `send` can't resolve, but where to find one", () => {
    const target: ManagedTarget = {
      name: "cl-bg-codex-c9eee429ff60", target: "=agendo:=cl-bg-codex-c9eee429ff60", cwd: "/git/agendo",
      placeholder: false, session: "agendo", windowIndex: "3",
    };
    const lines = reuseReport("agendo", { kind: "pending", target }, "");
    expect(lines[1]).not.toContain("cl-bg-codex-c9eee429ff60");
    expect(lines[1]).toMatch(/^ {2}send: {4}`.* send <id> "<prompt>"` once `.* list` shows its id$/);
    // ...but a link can name the window: it resolves once the session has started.
    expect(lines[2]).toBe("  link:    agendo://focus?session=cl-bg-codex-c9eee429ff60");
  });
});

describe("ignoredFlags", () => {
  const none: NewOnlyFlags = { unattended: false, agent: "claude", forwardArgv: [] };
  const running = found(cand(ID, "orch-agendo", "running"));

  test("a plain launch ignores nothing", () => {
    expect(ignoredFlags(none, running)).toEqual([]);
  });

  test("every flag that would only shape a new one is named, the way it was written", () => {
    const given: NewOnlyFlags = { name: "x", worktree: true, unattended: true, agent: "codex", forwardArgv: ["--model", "opus", "--effort=high"] };
    expect(ignoredFlags(given, running)).toEqual(["--name", "--worktree", "--agent codex", "--unattended", "--model", "--effort=high"]);
    expect(ignoredFlags({ ...none, worktree: false }, running)).toEqual(["--no-worktree"]);
    expect(ignoredFlags({ ...none, worktree: true, worktreePath: "/w" }, running)).toEqual(["--worktree=<path>"]);
  });

  test("a forwarded flag is named by its slot, whatever its value looks like", () => {
    expect(ignoredFlags({ ...none, forwardArgv: ["--model", "-x", "--effort", "high"] }, running)).toEqual(["--model", "--effort"]);
  });

  test("asking for the agent it already runs on is not news", () => {
    const codex = found({ ...cand(ID, "orch-agendo", "idle"), session: { ...cand(ID, "orch-agendo", "idle").session, source: "codex" } });
    expect(ignoredFlags({ ...none, agent: "codex" }, codex)).toEqual([]);
    // A Codex window too new to have a session says so by its name.
    const target: ManagedTarget = {
      name: "cl-bg-codex-c9eee429ff60", target: "=agendo:=cl-bg-codex-c9eee429ff60", cwd: "/git/agendo",
      placeholder: false, session: "agendo", windowIndex: "3",
    };
    expect(ignoredFlags({ ...none, agent: "codex" }, { kind: "pending", target })).toEqual([]);
  });

  test("the report says they did nothing, before the send line", () => {
    const lines = reuseReport("agendo", running, "", ["--worktree", "--model"]);
    expect(lines[1]).toBe("  ignored: --worktree, --model — they shape a new orchestrator, and none is started");
    expect(lines[2]).toMatch(/^ {2}send: /);
  });
});

describe("lookAlikeReport", () => {
  test("nothing to say when the repo has no look-alike", () => {
    expect(lookAlikeReport("agendo", [])).toEqual([]);
  });

  test("a look-alike is named and left alone, and the launch says why it starts one anyway", () => {
    const lines = lookAlikeReport("agendo", [cand(OLD, "agendo-orchestrator\n(old)", "paused", false)]);
    expect(lines[0]).toBe("▸ agendo has no recorded orchestrator, so this starts one — only LOOKING like one is not enough to be reused:");
    expect(lines[1]).toBe("  look-alike: 0e6e29414a1b  agendo-orchestrator (old) (paused) — left alone");
  });
});
