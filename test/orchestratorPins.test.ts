// The pinned orchestrator block's text (src/ui/models/orchestratorPins.ts).
// e2e sees the block one fixture state at a time; the arms that need several
// repos in several states at once — the overflow line, the count header with a
// state nobody is in, a repo whose only candidate was never recorded — are
// pinned here, along with the line count the viewport reserves — and which
// repos the block speaks for (`pinRoots`), over real temp checkouts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinRoots } from "../src/ui/hooks/useOrchestratorPins.ts";
import type { RepoInfo } from "../src/repositories/index.ts";
import { MAX_PINNED_REPOS, orchestratorPins, pinText, shownPins, staleList } from "../src/ui/models/orchestratorPins.ts";
import type { OrchestratorCandidate, OrchestratorState, RepoOrchestratorStatus } from "../src/orchestration/repoOrchestrator.ts";

const cand = (title: string, state: OrchestratorState, day = 1, recorded = true): OrchestratorCandidate => ({
  session: { id: title, source: "claude", cwd: "/r", title, lastUsed: new Date(2026, 9, day) },
  state,
  recorded,
});
const status = (name: string, primary: OrchestratorCandidate | null, stale: OrchestratorCandidate[] = []): RepoOrchestratorStatus => ({
  root: `/git/${name}`,
  name,
  primary,
  stale,
});
const texts = (s: RepoOrchestratorStatus[], repoScope: boolean, pending: [string, string][] = []) =>
  orchestratorPins(s, repoScope, new Map(pending))?.lines.map(pinText) ?? null;

describe("orchestratorPins — a scope that IS one repo", () => {
  test("running: one line naming it, and that O/G switches to it", () => {
    expect(texts([status("agendo", cand("orch-agendo", "running"))], true)).toEqual([
      "▌ Orchestrator  agendo  ● running  orch-agendo  ·  O/G switch to it",
    ]);
  });

  test("paused and idle both resume", () => {
    expect(texts([status("agendo", cand("orch-agendo", "paused"))], true)?.[0]).toContain("⏸ paused  orch-agendo  ·  O/G resume it");
    expect(texts([status("agendo", cand("orch-agendo", "idle"))], true)?.[0]).toContain("○ idle  orch-agendo  ·  O/G resume it");
  });

  test("none: says so, and that O/G starts one", () => {
    expect(texts([status("agendo", null)], true)).toEqual(["▌ Orchestrator  agendo  – none  ·  O/G start one"]);
  });

  test("the real duplicate: a second line names the stale one and says O/G will not open it", () => {
    const got = texts([status("agendo", cand("orch-agendo", "running"), [cand("agendo-orchestrator", "paused", 1, false)])], true);
    expect(got).toEqual([
      "▌ Orchestrator  agendo  ● running  orch-agendo  ·  O/G switch to it",
      "  ⚠ stale, not what O/G opens: agendo-orchestrator (⏸ paused)",
    ]);
  });

  test("only an unrecorded look-alike: none, and the look-alike is named for what it is", () => {
    const got = texts([status("agendo", null, [cand("orch-old", "idle", 1, false)])], true);
    expect(got?.[0]).toContain("– none");
    expect(got?.[1]).toBe("  ⚠ looks like an orchestrator, never recorded as one: orch-old (○ idle)");
  });

  test("titles are flattened and capped so the line stays one line", () => {
    const long = cand(`a\nb ${"x".repeat(80)}`, "idle");
    const line = texts([status("agendo", long)], true)?.[0] ?? "";
    expect(line).not.toContain("\n");
    expect(line).toContain(`a b ${"x".repeat(36)}  ·`);
  });
});

describe("orchestratorPins — a scope over several repos", () => {
  test("a count header, a line per repo with one (best state first), then the repos with none", () => {
    const got = texts(
      [
        status("zeta", cand("orch-zeta", "idle")),
        status("blip", null),
        status("agendo", cand("orch-agendo", "running"), [cand("agendo-orchestrator", "paused", 1, false)]),
        status("applib", cand("orch-applib", "paused")),
        status("appweb", null, [cand("orch-old", "idle", 1, false)]),
      ],
      false,
    );
    expect(got).toEqual([
      "▌ Orchestrators  ● 1 running · ⏸ 1 paused · ○ 1 idle · – 2 none  ·  O start/open",
      "  ● agendo  orch-agendo  ⚠ 1 stale",
      "  ⏸ applib  orch-applib",
      "  ○ zeta  orch-zeta",
      "  none in: appweb (⚠ 1 stale), blip",
    ]);
  });

  test(`at most ${MAX_PINNED_REPOS} repos get a line; the rest are still named, with their state`, () => {
    const many = ["a", "b", "c", "d", "e"].map((n, i) => status(n, cand(`orch-${n}`, "idle", i + 1)));
    const got = texts(many, false) ?? [];
    expect(got).toHaveLength(1 + MAX_PINNED_REPOS + 1);
    // Same state: the most recently used come first.
    expect(got.slice(1, 4).map((l) => l.trim().split(/\s+/)[1])).toEqual(["e", "d", "c"]);
    expect(got[4]).toBe("  +2 more: b ○, a ○");
  });

  test("nobody coordinating anything: the header, and the one line naming them all", () => {
    expect(texts([status("b", null), status("a", null)], false)).toEqual([
      "▌ Orchestrators  – 2 none  ·  O start/open",
      "  none in: a, b",
    ]);
  });

  test("no repos in scope: no block at all", () => {
    expect(orchestratorPins([], false)).toBeNull();
    expect(orchestratorPins([], true)).toBeNull();
  });

  test("repoScope rides along for the hint line", () => {
    expect(orchestratorPins([status("a", null)], true)?.repoScope).toBe(true);
    expect(orchestratorPins([status("a", null)], false)?.repoScope).toBe(false);
  });
});

test("the count header skips the states nobody is in", () => {
  expect(texts([status("a", cand("x", "running")), status("b", cand("y", "running"))], false)?.[0]).toBe("▌ Orchestrators  ● 2 running  ·  O start/open");
});

describe("orchestratorPins — one launched a moment ago", () => {
  // Its window is live but its agent has written no transcript, so the rule has
  // no session for it; `O` switches to the window, and the block says so.
  test("one repo: starting, named by its window, and O/G switches to it", () => {
    expect(texts([status("agendo", null)], true, [["/git/agendo", "cl-new-abc123"]])).toEqual([
      "▌ Orchestrator  agendo  ◌ starting  cl-new-abc123  ·  O/G switch to it",
    ]);
  });

  test("a look-alike beside it is stale, not merely unrecorded", () => {
    const got = texts([status("agendo", null, [cand("agendo-orchestrator", "idle", 1, false)])], true, [["/git/agendo", "cl-new-abc123"]]);
    expect(got?.[1]).toBe("  ⚠ stale, not what O/G opens: agendo-orchestrator (○ idle)");
  });

  test("several repos: counted and listed between running and paused", () => {
    const got = texts([status("applib", cand("orch-applib", "paused")), status("appweb", null)], false, [["/git/appweb", "cl-new-abc123"]]);
    expect(got).toEqual([
      "▌ Orchestrators  ◌ 1 starting · ⏸ 1 paused  ·  O start/open",
      "  ◌ appweb  cl-new-abc123",
      "  ⏸ applib  orch-applib",
    ]);
  });
});

describe("shownPins", () => {
  const pins = orchestratorPins([status("a", null), status("b", cand("x", "idle"))], false)!;

  test("a block that fits is passed through untouched", () => {
    expect(shownPins(pins, pins.lines.length)).toBe(pins);
    expect(shownPins(null, 0)).toBeNull();
  });

  test("cut short, it keeps its first lines — the header leads — and what G means", () => {
    const cut = shownPins(pins, 1)!;
    expect(cut.lines.map(pinText)).toEqual([pinText(pins.lines[0])]);
    expect(cut.repoScope).toBe(false);
    expect(shownPins(pins, 0)?.lines).toEqual([]);
  });
});

test("staleList names each stale one with its state", () => {
  expect(staleList([cand("one", "paused"), cand("two", "idle")])).toBe("one (⏸ paused), two (○ idle)");
});

describe("pinRoots", () => {
  const scratch = mkdtempSync(join(tmpdir(), "agendo-pinroots-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const A = join(scratch, "work", "a");
  const B = join(scratch, "work", "b");
  const C = join(scratch, "elsewhere", "c");
  for (const r of [A, B, C]) mkdirSync(join(r, ".git"), { recursive: true });
  // A linked worktree of A outside .claude/worktrees: its .git is a pointer file.
  const WT = join(scratch, "work", "a-feature");
  mkdirSync(join(A, ".git", "worktrees", "a-feature"), { recursive: true });
  writeFileSync(join(A, ".git", "worktrees", "a-feature", "commondir"), "../..\n");
  mkdirSync(WT, { recursive: true });
  writeFileSync(join(WT, ".git"), `gitdir: ${join(A, ".git", "worktrees", "a-feature")}\n`);
  const PLAIN = join(scratch, "work", "notes");
  mkdirSync(PLAIN, { recursive: true });
  const info = (root: string): RepoInfo => ({ root, name: root.split("/").pop()!, total: 1, claude: 1, copilot: 0, codex: 0 });

  test("a scope that IS a repo speaks for that repo alone", () => {
    expect(pinRoots({ scopeRepo: A, scoped: true, filterRoot: A, discovered: [info(B)], known: [info(C)] })).toEqual([A]);
  });

  test("a folder scope: checkouts found under it plus repos with sessions there, a worktree folded onto its repo, a plain folder dropped", () => {
    const got = pinRoots({
      scopeRepo: null, scoped: true, filterRoot: join(scratch, "work"),
      discovered: [info(A), info(B)], known: [info(WT), info(PLAIN), info(C)],
    });
    expect(got).toEqual([A, B]);
  });

  test("unscoped (or the global view): every repo with sessions anywhere", () => {
    const known = [info(A), info(C), info(WT)];
    expect(pinRoots({ scopeRepo: null, scoped: false, filterRoot: join(scratch, "work"), discovered: [info(B)], known })).toEqual([A, C]);
  });
});
