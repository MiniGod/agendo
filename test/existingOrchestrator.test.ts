// The orchestrator launched a moment ago (src/launch/existingOrchestrator.ts):
// live in tmux, unknown to the session index because its agent has not written
// a transcript yet — the gap a second `O` press falls into. e2e stages it for a
// Claude orchestrator (a CLI launch, then a second one or the pinned block); the
// arms it cannot — a Codex window found by its cwd marker, and every window that
// must NOT be taken for one — are pinned here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existingLabel, hasUnmatchedMarker, openExistingOrchestrator, pendingOrchestrator } from "../src/launch/existingOrchestrator.ts";
import type { AgentSession } from "../src/shared/types.ts";
import type { ManagedTarget } from "../src/runtime/tmux/index.ts";
import type { OrchestratorRole } from "../src/orchestration/index.ts";

const scratch = mkdtempSync(join(tmpdir(), "agendo-pending-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const REPO = join(scratch, "agendo");
const OTHER = join(scratch, "blip");
for (const r of [REPO, OTHER]) mkdirSync(join(r, ".git"), { recursive: true });

const ID = "c9eee429-ff60-400c-90fa-e8a6aae2d017";
const SID = ID.replace(/-/g, "").slice(0, 12);

const win = (name: string, cwd: string, over: Partial<ManagedTarget> = {}): ManagedTarget => ({
  name,
  target: `=agendo:=${name}`,
  cwd,
  placeholder: false,
  session: "agendo",
  windowIndex: "3",
  ...over,
});
const marks = (roles: [string, OrchestratorRole][], cwds: [string, OrchestratorRole][] = []) => ({
  roles: new Map(roles),
  cwdRoles: new Map(cwds),
});

describe("pendingOrchestrator", () => {
  test("a live window carrying a recorded repo orchestrator's short id, in the repo", () => {
    const t = win(`cl-new-${SID}`, REPO);
    expect(pendingOrchestrator(REPO, [t], marks([[ID, "repo"]]))).toBe(t);
  });

  test("not in another repo, not as a placeholder, not for a global id", () => {
    const f = marks([[ID, "repo"]]);
    expect(pendingOrchestrator(REPO, [win(`cl-new-${SID}`, OTHER)], f)).toBeNull();
    expect(pendingOrchestrator(REPO, [win(`cl-new-${SID}`, REPO, { placeholder: true })], f)).toBeNull();
    expect(pendingOrchestrator(REPO, [win(`cl-new-${SID}`, REPO)], marks([[ID, "global"]]))).toBeNull();
  });

  test("an unrelated managed window in the repo is not one", () => {
    expect(pendingOrchestrator(REPO, [win("cl-bg-abcdef123456", REPO), win("cl-wi-101", REPO)], marks([[ID, "repo"]]))).toBeNull();
  });

  test("a Codex orchestrator has no id yet, so its repo-level cwd marker is what finds it", () => {
    const t = win("cl-bg-codex-abcdef123456", REPO);
    expect(pendingOrchestrator(REPO, [t], marks([], [[REPO, "repo"]]))).toBe(t);
    expect(pendingOrchestrator(REPO, [t], marks([], [[REPO, "global"]]))).toBeNull();
    // Named by the TUI's fresh launch, or known only by its tag.
    const fresh = win("cl-new-codex-abcdef123456", REPO);
    expect(pendingOrchestrator(REPO, [fresh], marks([], [[REPO, "repo"]]))).toBe(fresh);
    const tagged = win("cl-free-x", REPO, { tags: { source: "codex" } });
    expect(pendingOrchestrator(REPO, [tagged], marks([], [[REPO, "repo"]]))).toBe(tagged);
  });

  test("a Codex cwd marker vouches for a Codex window only, not for the work beside it", () => {
    // The marker says "a Codex orchestrator was launched here" — not that every
    // window in the main checkout is one. A Claude work session there, by id or
    // fresh, stays a work session, so `O` starts the orchestrator instead.
    const others = [win("cl-claude-abcdef123456", REPO), win(`cl-new-${SID}`, REPO), win("cl-wi-101", REPO), win("cl-free-x", REPO, { tags: { source: "claude" } })];
    expect(pendingOrchestrator(REPO, others, marks([], [[REPO, "repo"]]))).toBeNull();
  });

  test("a window in a worktree of the repo still belongs to the repo", () => {
    const t = win(`cl-new-${SID}`, join(REPO, ".claude", "worktrees", "orchestrator"));
    expect(pendingOrchestrator(`${REPO}/`, [t], marks([[ID, "repo"]]))).toBe(t);
  });
});

test("a pending one is switched to by its exact target, creating nothing", () => {
  const t = win(`cl-new-${SID}`, REPO);
  const empty = { live: new Set<string>(), placeholders: new Set<string>(), windows: new Map(), placeholderWindows: new Map() };
  // The unit suite runs with $TMUX unset, so this is the outside-tmux handover.
  expect(openExistingOrchestrator({ kind: "pending", target: t }, empty)).toEqual({
    alreadyRunning: true,
    tmuxName: t.name,
    mode: "handover",
    handover: ["tmux", "attach-session", "-t", t.target],
  });
  expect(existingLabel({ kind: "pending", target: t })).toBe(`cl-new-${SID} (just started)`);
});

test("a session's label is one line, however long or many-lined its title", () => {
  const session: AgentSession = { id: ID, source: "codex", cwd: REPO, title: `Coordinate\nthe ${"x".repeat(60)}`, lastUsed: new Date(2026, 9, 1) };
  const primary = { session, state: "idle" as const, recorded: true };
  const label = existingLabel({ kind: "session", status: { root: REPO, name: "agendo", primary, stale: [] }, primary });
  expect(label).not.toContain("\n");
  expect(label).toBe(`Coordinate the ${"x".repeat(25)} (codex)`);
});

test("a running one is reached by the exact target of its window, not looked up by name", () => {
  const s: AgentSession = { id: ID, source: "claude", cwd: REPO, title: "orch-agendo", lastUsed: new Date(2026, 9, 1) };
  const canon = `cl-claude-${SID}`;
  const live = {
    live: new Set([canon]),
    placeholders: new Set<string>(),
    windows: new Map([[canon, { name: canon, target: `=agendo:=${canon}`, session: "agendo", windowIndex: "4" }]]),
    placeholderWindows: new Map(),
  };
  const primary = { session: s, state: "running" as const, recorded: true };
  const found = { kind: "session" as const, status: { root: REPO, name: "agendo", primary, stale: [] }, primary };
  // Outside tmux (the unit suite): an attach to that window — the name lookup
  // there sees only tmux sessions, and would start a second agent instead.
  expect(openExistingOrchestrator(found, live).handover).toEqual(["tmux", "attach-session", "-t", `=agendo:=${canon}`]);
});

describe("hasUnmatchedMarker", () => {
  const s = (id: string, source: AgentSession["source"] = "claude", cwd = REPO): AgentSession =>
    ({ id, source, cwd, title: id, lastUsed: new Date(2026, 9, 1) });

  test("a recorded repo id with no session, or a repo Codex cwd with no Codex session in it", () => {
    expect(hasUnmatchedMarker([], marks([[ID, "repo"]]))).toBe(true);
    expect(hasUnmatchedMarker([s("x", "claude")], marks([], [[REPO, "repo"]]))).toBe(true);
  });

  test("not once each has its session, and never for a global marker", () => {
    expect(hasUnmatchedMarker([s(ID)], marks([[ID, "repo"]]))).toBe(false);
    expect(hasUnmatchedMarker([s("cx", "codex")], marks([], [[REPO, "repo"]]))).toBe(false);
    expect(hasUnmatchedMarker([], marks([[ID, "global"]], [[REPO, "global"]]))).toBe(false);
  });
});
