// Which session IS a repo's orchestrator (src/orchestration/repoOrchestrator.ts).
// Pure over the sessions and the facts it is handed, so the duplicate cases the
// e2e fixtures never stage — a recorded and an unrecorded one side by side, two
// recorded ones tied on everything but their marker position, a Codex one found
// only by its cwd — are pinned here.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flatTitle,
  looksLikeOrchestrator,
  orchestratorCandidates,
  recordedRanks,
  repoOrchestratorStatuses,
  type OrchestratorFacts,
  type OrchestratorState,
} from "../src/orchestration/repoOrchestrator.ts";
import type { OrchestratorRole } from "../src/orchestration/index.ts";
import type { AgentSession } from "../src/shared/types.ts";

// Real checkouts, so `repoRootForCwd`'s walk resolves them the way it does on disk.
const scratch = mkdtempSync(join(tmpdir(), "agendo-orch-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const REPO = join(scratch, "agendo");
const OTHER = join(scratch, "blip");
for (const r of [REPO, OTHER]) mkdirSync(join(r, ".git"), { recursive: true });
const WT = join(REPO, ".claude", "worktrees", "feat");
// A linked worktree OUTSIDE .claude/worktrees: its .git is a pointer file whose
// git dir has a `commondir` back to the main checkout's .git.
const LINKED = join(scratch, "agendo-hotfix");
mkdirSync(join(REPO, ".git", "worktrees", "agendo-hotfix"), { recursive: true });
writeFileSync(join(REPO, ".git", "worktrees", "agendo-hotfix", "commondir"), "../..\n");
mkdirSync(LINKED, { recursive: true });
writeFileSync(join(LINKED, ".git"), `gitdir: ${join(REPO, ".git", "worktrees", "agendo-hotfix")}\n`);
// The repo reached through a symlink, the way a scope may name it.
const LINK = join(scratch, "agendo-link");
symlinkSync(REPO, LINK);

function session(id: string, over: Partial<AgentSession> = {}): AgentSession {
  return { id, source: "claude", cwd: REPO, title: id, lastUsed: new Date("2026-10-01T00:00:00Z"), ...over };
}

function facts(
  roles: [string, OrchestratorRole][],
  states: Record<string, OrchestratorState> = {},
  cwdRoles: [string, OrchestratorRole][] = [],
): OrchestratorFacts {
  return { roles: new Map(roles), cwdRoles: new Map(cwdRoles), stateOf: (s) => states[s.id] ?? "idle" };
}

const ids = (list: { session: AgentSession }[]) => list.map((c) => c.session.id);

describe("looksLikeOrchestrator", () => {
  test.each(["orch-agendo", "agendo-orchestrator", "orchestrator", "ORCH_2", "my_orch"])("%s reads as an orchestrator name", (t) => {
    expect(looksLikeOrchestrator(t)).toBe(true);
  });
  test.each(["Fix the orchestrator prompt", "orchard-app", "porch", "orchestration-notes", ""])("%s does not", (t) => {
    expect(looksLikeOrchestrator(t)).toBe(false);
  });
});

describe("orchestratorCandidates", () => {
  test("a recorded repo orchestrator counts wherever in the repo it runs", () => {
    const got = orchestratorCandidates([session("a", { cwd: WT, title: "Integrate things" })], facts([["a", "repo"]]));
    expect([...got.keys()]).toEqual([REPO]);
    expect(got.get(REPO)?.[0].recorded).toBe(true);
  });

  test("an unrecorded one counts only in the main checkout, and only when named like one", () => {
    const got = orchestratorCandidates(
      [
        session("legacy", { title: "agendo-orchestrator" }),
        session("in-worktree", { cwd: WT, title: "orch-feat" }),
        session("task", { title: "Fix the orchestrator prompt" }),
      ],
      facts([]),
    );
    expect(ids(got.get(REPO) ?? [])).toEqual(["legacy"]);
    expect(got.get(REPO)?.[0].recorded).toBe(false);
  });

  test("…or in the worktree the role slug names, whatever its title", () => {
    const at = (name: string) => join(REPO, ".claude", "worktrees", name);
    const got = orchestratorCandidates(
      [
        session("old-default", { cwd: at("orchestrator"), title: "Coordinate the rewrite" }),
        session("stepped", { cwd: at("orchestrator-2"), title: "Coordinate the rest" }),
        session("docs", { cwd: at("orchestration-docs"), title: "Write the docs" }),
        session("named", { cwd: at("orchestrator-api"), title: "Build the api" }),
      ],
      facts([]),
    );
    expect(ids(got.get(REPO) ?? []).sort()).toEqual(["old-default", "stepped"]);
  });

  test("a linked worktree outside .claude/worktrees is filed under its main checkout", () => {
    const got = orchestratorCandidates([session("a", { cwd: join(LINKED, "src"), title: "Integrate" })], facts([["a", "repo"]]));
    expect([...got.keys()]).toEqual([REPO]);
  });

  test("global orchestrators belong to no repo, by id or by cwd", () => {
    const got = orchestratorCandidates(
      [session("g", { title: "orch-global" }), session("cg", { source: "codex", title: "orchestrator" })],
      facts([["g", "global"]], {}, [[REPO, "global"]]),
    );
    expect(got.size).toBe(0);
  });

  test("a Codex session is found by its cwd marker; another agent in that cwd is not", () => {
    const got = orchestratorCandidates(
      [session("cx", { source: "codex", title: "x y" }), session("cl", { title: "x y" })],
      facts([], {}, [[REPO, "repo"]]),
    );
    expect(ids(got.get(REPO) ?? [])).toEqual(["cx"]);
  });
});

describe("repoOrchestratorStatuses", () => {
  test("a repo with no candidates has no orchestrator", () => {
    const [st] = repoOrchestratorStatuses([OTHER], [session("a", { cwd: OTHER, title: "work" })], facts([]));
    expect(st).toMatchObject({ root: OTHER, name: "blip", primary: null, stale: [] });
  });

  test("the real duplicate: the recorded one is THE orchestrator, the hand-started one is stale", () => {
    const sessions = [
      session("old", { title: "agendo-orchestrator", lastUsed: new Date("2026-10-19T00:00:00Z") }),
      session("cur", { title: "orch-agendo", lastUsed: new Date("2026-10-10T00:00:00Z") }),
    ];
    // Even with the unrecorded one more alive AND more recent, recorded wins.
    const [st] = repoOrchestratorStatuses([REPO], sessions, facts([["cur", "repo"]], { old: "running", cur: "paused" }));
    expect(st.primary?.session.id).toBe("cur");
    expect(st.primary?.state).toBe("paused");
    expect(ids(st.stale)).toEqual(["old"]);
  });

  test("only unrecorded candidates: no primary, every one of them stale", () => {
    const [st] = repoOrchestratorStatuses([REPO], [session("legacy", { title: "orch-agendo" })], facts([]));
    expect(st.primary).toBeNull();
    expect(ids(st.stale)).toEqual(["legacy"]);
  });

  test("among recorded ones: running, then paused, then idle", () => {
    const sessions = [session("i"), session("p"), session("r")];
    const roles: [string, OrchestratorRole][] = [["r", "repo"], ["p", "repo"], ["i", "repo"]];
    const [st] = repoOrchestratorStatuses([REPO], sessions, facts(roles, { r: "running", p: "paused" }));
    expect(st.primary?.session.id).toBe("r");
    expect(ids(st.stale)).toEqual(["p", "i"]);
    const [noRunning] = repoOrchestratorStatuses([REPO], sessions.slice(0, 2), facts(roles, { p: "paused" }));
    expect(noRunning.primary?.session.id).toBe("p");
  });

  test("same state: the most recently used, then the most recently marked, then the id", () => {
    const t = new Date("2026-10-05T00:00:00Z");
    const recent = session("recent", { lastUsed: new Date("2026-10-06T00:00:00Z") });
    const [byUse] = repoOrchestratorStatuses([REPO], [session("older", { lastUsed: t }), recent], facts([["recent", "repo"], ["older", "repo"]]));
    expect(byUse.primary?.session.id).toBe("recent");

    const tied = [session("first", { lastUsed: t }), session("second", { lastUsed: t })];
    const [byMark] = repoOrchestratorStatuses([REPO], tied, facts([["second", "repo"], ["first", "repo"]]));
    expect(byMark.primary?.session.id).toBe("first");

    // Two Codex ones found by the same cwd marker carry no marker position at all.
    const codex = [session("b", { lastUsed: t, source: "codex" }), session("a", { lastUsed: t, source: "codex" })];
    const [byId] = repoOrchestratorStatuses([REPO], codex, facts([], {}, [[REPO, "repo"]]));
    expect(byId.primary?.session.id).toBe("a");
    expect(ids(byId.stale)).toEqual(["b"]);
  });

  test("roots are answered in the order given, spelled any way", () => {
    const sts = repoOrchestratorStatuses([`${OTHER}/`, REPO], [session("a")], facts([["a", "repo"]]));
    expect(sts.map((s) => s.root)).toEqual([OTHER, REPO]);
    expect(sts[1].primary?.session.id).toBe("a");
  });

  test("a root named through a symlink finds the sessions recorded under the real path, and keeps its own spelling", () => {
    const [st] = repoOrchestratorStatuses([LINK], [session("a")], facts([["a", "repo"]]));
    expect(st.root).toBe(LINK);
    expect(st.primary?.session.id).toBe("a");
  });
});

describe("recordedRanks — the order `list repos` names them in", () => {
  test("the rule's order over the recorded repo orchestrators: running, paused, idle, then most recent", () => {
    const old = session("idle-old", { lastUsed: new Date("2026-09-01T00:00:00Z") });
    const fresh = session("idle-new");
    const parked = session("parked", { lastUsed: new Date("2026-08-01T00:00:00Z") });
    const live = session("live", { lastUsed: new Date("2026-07-01T00:00:00Z") });
    const f = facts([["idle-old", "repo"], ["idle-new", "repo"], ["parked", "repo"], ["live", "repo"]], { parked: "paused", live: "running" });
    const rank = recordedRanks([old, fresh, parked, live], f);
    expect([...rank.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id)).toEqual(["live", "parked", "idle-new", "idle-old"]);
  });

  test("its first is the rule's primary", () => {
    const a = session("a");
    const b = session("b");
    const f = facts([["a", "repo"], ["b", "repo"]], { b: "paused" });
    const [status] = repoOrchestratorStatuses([REPO], [a, b], f);
    expect(recordedRanks([a, b], f).get(status.primary!.session.id)).toBe(0);
  });

  test("a Codex orchestrator recorded by its cwd is ranked like one recorded by id", () => {
    const codex = session("codex-orch", { source: "codex", cwd: WT });
    const claude = session("claude-orch", { lastUsed: new Date("2026-09-01T00:00:00Z") });
    const f = facts([["claude-orch", "repo"]], {}, [[WT, "repo"]]);
    expect(recordedRanks([claude, codex], f)).toEqual(new Map([["codex-orch", 0], ["claude-orch", 1]]));
  });

  test("only repo-level ids: a global one, a look-alike and an unmarked session have no rank", () => {
    const f = facts([["g", "global"]]);
    expect(recordedRanks([session("g"), session("orch-agendo"), session("work")], f).size).toBe(0);
  });
});

test("flatTitle puts a title on one short line", () => {
  expect(flatTitle("  first\n\tsecond  ")).toBe("first second");
  expect(flatTitle("x".repeat(80))).toHaveLength(40);
});
