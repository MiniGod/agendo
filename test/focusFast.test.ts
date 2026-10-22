// The live-window shortcut `agendo focus` takes before the full index
// (src/cli/focus/fast.ts): which Claude transcripts it reads, when it declines,
// when a second look at the windows still trusts the narrowed index, and that a
// narrowed index reads only those. The e2e suite pins that a link answered this
// way never loads the model; how many transcripts were parsed is invisible from
// there, so it is pinned here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { liveIds, narrowTo, stillCovers } from "../src/cli/focus/fast.ts";
import { tokenNames } from "../src/cli/commands/resume.ts";
import { inProject, ownOpenItem, prReviewedBy } from "../src/providers/azureDevOps/index.ts";
import { cfg } from "../src/providers/azureDevOps/env.ts";
import type { ManagedTarget } from "../src/runtime/tmux/index.ts";

const ID_A = "aaaaaaaa-1111-4000-8000-000000000001";
const ID_B = "bbbbbbbb-2222-4000-8000-000000000002";
const ID_C = "cccccccc-3333-4000-8000-000000000003";
const ID_D = "dddddddd-4444-4000-8000-000000000004";

const win = (name: string, cwd: string, extra: Partial<ManagedTarget> = {}): ManagedTarget => ({
  name, target: `=agendo:=${name}`, cwd, placeholder: false, session: "agendo", windowIndex: "1", ...extra,
});

/** Every name tmux lists for `windows` — their session's and their own — as `liveTargets` does. */
const namesOf = (windows: ManagedTarget[]): string[] => ["agendo", ...windows.map((w) => w.name)];

/** `liveIds` as `snapshot` calls it: the managed windows, and every name tmux lists. */
const idsOf = (windows: ManagedTarget[]) => liveIds(windows, namesOf(windows));

describe("liveIds", () => {
  test("a tagged window names the session its tag does, whatever its name", () => {
    expect(idsOf([win("cl-pr-5", "/w", { tags: { sessionId: ID_A } })])).toEqual(new Set(["aaaaaaaa1111"]));
  });

  test("an id-bearing name names its session by short id, and nothing else in its cwd", () => {
    expect(idsOf([win("cl-claude-bbbbbbbb2222", "/w")])).toEqual(new Set(["bbbbbbbb2222"]));
  });

  test("a live window that names no session declines: only the full index can attribute it", () => {
    expect(idsOf([win("cl-claude-aaaaaaaa1111", "/a"), win("cl-wi-101", "/repo/wt")])).toBeNull();
  });

  test("a placeholder is not running: it admits nothing, not even by its name, and an id-less one does not decline", () => {
    const windows = [win("cl-claude-aaaaaaaa1111", "/w", { placeholder: true }), win("cl-wi-101", "/repo/wt", { placeholder: true })];
    expect(idsOf(windows)).toEqual(new Set());
  });

  test("a window tmux names but whose pane reports no cwd still admits the id its name carries", () => {
    expect(liveIds([], ["agendo", "cl-claude-bbbbbbbb2222", "cl-wi-101"])).toEqual(new Set(["bbbbbbbb2222"]));
  });
});

describe("narrowTo", () => {
  test("admits the sessions named by short id, and what `also` admits", () => {
    const only = narrowTo(new Set(["aaaaaaaa1111"]), (id) => id === ID_C);
    expect(only("-x", ID_A)).toBe(true);
    expect(only("-x", ID_C)).toBe(true);
    expect(only("-x", ID_B)).toBe(false);
  });
});

describe("stillCovers", () => {
  const before = new Set(["aaaaaaaa1111", "bbbbbbbb2222"]);

  test("windows that closed or fell back to placeholders since are still covered", () => {
    expect(stillCovers(before, new Set(["aaaaaaaa1111"]))).toBe(true);
    expect(stillCovers(before, new Set())).toBe(true);
  });

  test("a session started since is not: the narrowed index never read it", () => {
    expect(stillCovers(before, new Set(["aaaaaaaa1111", "cccccccc3333"]))).toBe(false);
  });

  test("nor is a window that names no session, opened since", () => {
    expect(stillCovers(before, null)).toBe(false);
  });
});

describe("tokenNames", () => {
  test("a full id, a short id and a window name all name the session", () => {
    for (const token of [ID_A, "aaaaaaaa1111", "cl-claude-aaaaaaaa1111"]) {
      expect(tokenNames(token)(ID_A), token).toBe(true);
      expect(tokenNames(token)(ID_B), token).toBe(false);
    }
  });
});

/** Two live windows, each naming its session, and a placeholder. D's session has no window at all. */
const LIVE = [
  win("cl-claude-aaaaaaaa1111", "/repo/a"),
  win("cl-pr-7", "/repo/c", { tags: { sessionId: ID_C } }),
  win("cl-claude-bbbbbbbb2222", "/repo/b", { placeholder: true }),
];

/**
 * Build the index in a child bun whose HOME is `home`: bun reads the home dir
 * once per process, so this process cannot be pointed at a fixture profile.
 * The narrowing is composed as `snapshot` and `narrowedIndex` compose it.
 * Reports the session ids, the ids on one branch and how many transcripts were
 * parsed (a running total) after a narrowed build, a full one, a narrowed one
 * again and a full one again.
 */
function buildIn(home: string): { narrowed: string[]; onBranch: string[]; parsed: number[] } {
  const script = `
    const { SessionIndex, __claudeParseCount } = await import(${JSON.stringify(join(import.meta.dir, "../src/sessions/index.ts"))});
    const { liveIds, narrowTo } = await import(${JSON.stringify(join(import.meta.dir, "../src/cli/focus/fast.ts"))});
    const only = narrowTo(liveIds(${JSON.stringify(LIVE)}, ${JSON.stringify(namesOf(LIVE))}));
    const narrowed = await SessionIndex.build(only);
    const parsed = [__claudeParseCount()];
    for (const pass of [undefined, only, undefined]) {
      await SessionIndex.build(pass);
      parsed.push(__claudeParseCount());
    }
    console.log(JSON.stringify({ narrowed: narrowed.all.map((s) => s.id).sort(), onBranch: narrowed.forBranch("feature/a").map((s) => s.id), parsed }));
  `;
  // CODEX_HOME would point the (always whole) Codex scan at the real one.
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  delete env.CODEX_HOME;
  const r = Bun.spawnSync(["bun", "-e", script], { env });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "{}");
}

describe("a narrowed SessionIndex", () => {
  let home: string;

  /** One Claude transcript with a cwd and a branch, filed where Claude would file it. */
  function transcript(id: string, cwd: string, branch: string): void {
    const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: "user", cwd, gitBranch: branch, timestamp: "2026-01-01T00:00:00Z" })}\n`);
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "agendo-fast-"));
    transcript(ID_A, "/repo/a", "feature/a");
    transcript(ID_B, "/repo/b", "feature/b");
    transcript(ID_C, "/repo/c", "feature/c");
    transcript(ID_D, "/repo/a", "feature/a");
  });

  afterAll(() => rmSync(home, { recursive: true, force: true }));

  test("parses only what the live windows name, and prunes nothing it skipped", () => {
    const r = buildIn(home);
    // The running windows' sessions: not the placeholder's, nor D's, though D
    // shares A's directory and branch.
    expect(r.narrowed).toEqual([ID_A, ID_C]);
    expect(r.onBranch).toEqual([ID_A]);
    // 2 parsed narrowed; the full build adds only the two it skipped. The
    // second narrowed build must not prune those from the cache, or the last
    // full build would parse them again.
    expect(r.parsed).toEqual([2, 4, 4, 4]);
  });
});

describe("what the ADO shortcut vouches the model lists", () => {
  const me = { id: "me-guid", displayName: "Me", uniqueName: "Me@Example.com" };

  test("a PR the identity is asked to review in person — not one for a team only", () => {
    expect(prReviewedBy({ reviewers: [{ id: "team-guid" }, { id: "me-guid" }] }, me)).toBe(true);
    expect(prReviewedBy({ reviewers: [{ id: "team-guid" }] }, me)).toBe(false);
    expect(prReviewedBy({}, me)).toBe(false);
  });

  test("a PR in the configured project, by name or id, case-insensitively — not one elsewhere or unsaid", () => {
    const pr = (project?: object) => ({ repository: { project } });
    const saved = cfg.project;
    try {
      cfg.project = "Widgets";
      expect(inProject(pr({ name: "widgets", id: "p-guid" }))).toBe(true);
      expect(inProject(pr({ name: "Other", id: "WIDGETS" }))).toBe(true);
      expect(inProject(pr({ name: "Other", id: "o-guid" }))).toBe(false);
      expect(inProject(pr())).toBe(false);
    } finally {
      cfg.project = saved;
    }
  });

  test("an item assigned to the identity by unique name and not closed, both case-insensitively", () => {
    const item = (uniqueName?: string, state = "Active") => ({
      fields: { "System.State": state, "System.AssignedTo": uniqueName === undefined ? undefined : { uniqueName } },
    });
    const saved = cfg.closedStates;
    try {
      cfg.closedStates = ["Closed", "Done"];
      expect(ownOpenItem(item("me@example.com"), me)).toBe(true);
      expect(ownOpenItem(item("me@example.com", "done"), me)).toBe(false);
      expect(ownOpenItem(item("someone@example.com"), me)).toBe(false);
      expect(ownOpenItem(item(undefined), me)).toBe(false);
      expect(ownOpenItem(item(""), { ...me, uniqueName: "" })).toBe(false);
    } finally {
      cfg.closedStates = saved;
    }
  });
});
