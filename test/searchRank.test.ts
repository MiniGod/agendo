// The `/` search ranking (src/ui/models/search.ts). The fuzzy match is a
// subsequence match over one joined string, so a PR-id query also hits other
// PRs whose id shares a prefix and whose title or branch supplies the rest of
// the digits; an exact id has to rank first. Session identity — full uuid, the
// 12-hex short id, a tmux window name — is matched exactly or by prefix, never
// fuzzily, and these tests pin both the hits and the near-misses.
import { describe, expect, test } from "bun:test";
import type { AgentSession, PRWithSessions, WorkItem } from "../src/shared/types.ts";
import { sessionName } from "../src/runtime/tmux/index.ts";
import type { LiveInfo } from "../src/ui/models/tmuxMeta.ts";
import {
  MIN_ID_PREFIX, RANK_EXACT, RANK_FUZZY, RANK_ID_PREFIX, parseQuery, prRank, itemRank, rankMatches,
  searchContext, sessionIdRank, sessionRank, uniqueBy,
} from "../src/ui/models/search.ts";

const UUID = "9cb15657-a0dd-4f4e-8a2b-0123456789ab";
const sess = (over: Partial<AgentSession> = {}): AgentSession =>
  ({ id: UUID, source: "claude", cwd: "/r", title: "fix the thing", branch: "main", lastUsed: new Date(0), ...over }) as AgentSession;
const pr = (id: number, over: Partial<PRWithSessions> = {}): PRWithSessions =>
  ({ id, title: "a change", branch: "feature/x", repositoryName: "repo", sessions: [], ...over }) as PRWithSessions;
const item = (id: number, over: Partial<WorkItem> = {}): WorkItem =>
  ({ id, title: "a story", type: "User Story", state: "Active", sessions: [], ...over }) as WorkItem;
// A LiveInfo whose `windows` maps a canonical name to the live window it runs in.
const live = (windows: Record<string, string> = {}): LiveInfo => ({
  names: new Set(Object.keys(windows)),
  windows: new Map(Object.entries(windows).map(([canon, name]) => [canon, { name, target: `agendo:${name}` }])),
  locations: new Map(),
});
const ctx = (query: string, windows: Record<string, string> = {}, inScope = (_: string) => true) =>
  searchContext(live(windows), inScope, query);
// sessionIdRank with the session's canonical name and, optionally, its live window.
const idRank = (s: AgentSession, query: string, window?: string) =>
  sessionIdRank(s, parseQuery(query), window ? [sessionName(s), window] : [sessionName(s)]);

describe("parseQuery: numeric ids", () => {
  const numericId = (q: string) => parseQuery(q).digits;
  test("digits, optionally behind ! or #, with surrounding space", () => {
    expect(numericId("81656")).toBe("81656");
    expect(numericId("!81656")).toBe("81656");
    expect(numericId(" #81656 ")).toBe("81656");
  });
  test("anything else is not an id query", () => {
    expect(numericId("!!81656")).toBeNull();
    expect(numericId("8165a")).toBeNull();
    expect(numericId("")).toBeNull();
    expect(numericId("70 02")).toBeNull();
  });
});

describe("prRank", () => {
  test("an exact PR id ranks first, with or without its sigil", () => {
    for (const q of ["81656", "!81656", "#81656"]) expect(prRank(pr(81656), ctx(q))).toBe(RANK_EXACT);
  });

  test("the real-world collision: a near id plus a digit in the title is only a fuzzy hit", () => {
    const near = pr(81654, { title: "User Story 247306: save the network" });
    expect(prRank(near, ctx("81656"))).toBe(RANK_FUZZY);
    expect(prRank(near, ctx("!81656"))).toBe(RANK_FUZZY);
  });

  test("a partial id is fuzzy, not exact; a non-match is null", () => {
    expect(prRank(pr(81656), ctx("8165"))).toBe(RANK_FUZZY);
    expect(prRank(pr(81656), ctx("99999"))).toBeNull();
  });

  test("the linked work-item id is not an exact PR hit", () => {
    const linked = pr(81656, { workItemId: 247304, workItemTitle: "story" } as Partial<PRWithSessions>);
    expect(prRank(linked, ctx("247304"))).toBeNull();
  });

  test("titles and branches still match exactly as before", () => {
    expect(prRank(pr(1, { title: "Migrate to bun" }), ctx("migbun"))).toBe(RANK_FUZZY);
    expect(prRank(pr(1, { branch: "hmi/lazy-loading" }), ctx("lazy"))).toBe(RANK_FUZZY);
  });

  test("a PR is found by any of its sessions' ids, and only by in-scope ones", () => {
    const p = pr(5, { sessions: [sess({ cwd: "/in" })] });
    expect(prRank(p, ctx(UUID))).toBe(RANK_EXACT);
    expect(prRank(p, ctx("9cb15657a0dd"))).toBe(RANK_EXACT);
    expect(prRank(p, ctx("cl-claude-9cb15657a0dd"))).toBe(RANK_EXACT);
    expect(prRank(p, ctx(UUID, {}, (cwd) => cwd !== "/in"))).toBeNull();
  });
});

describe("itemRank", () => {
  test("an exact work-item id ranks first; a partial one is fuzzy", () => {
    expect(itemRank(item(247304), ctx("#247304"))).toBe(RANK_EXACT);
    expect(itemRank(item(247304), ctx("247304"))).toBe(RANK_EXACT);
    expect(itemRank(item(247304), ctx("2473"))).toBe(RANK_FUZZY);
  });
  test("found by a session's window name", () => {
    const it = item(1, { sessions: [sess()] });
    expect(itemRank(it, ctx("cl-wi-1", { "cl-claude-9cb15657a0dd": "cl-wi-1" }))).toBe(RANK_EXACT);
  });
});

describe("sessionIdRank", () => {
  const s = sess();

  test("the full uuid, its compact form and the 12-hex short id are exact", () => {
    expect(idRank(s, UUID)).toBe(RANK_EXACT);
    expect(idRank(s, UUID.toUpperCase())).toBe(RANK_EXACT);
    expect(idRank(s, UUID.replace(/-/g, ""))).toBe(RANK_EXACT);
    expect(idRank(s, "9cb15657a0dd")).toBe(RANK_EXACT);
  });

  test("a long enough prefix matches below exact, dashes or not", () => {
    expect(idRank(s, "9cb156")).toBe(RANK_ID_PREFIX);
    expect(idRank(s, "9cb15657-a0")).toBe(RANK_ID_PREFIX);
    expect(idRank(s, "9cb15657a0dd4f4e")).toBe(RANK_ID_PREFIX);
  });

  test("a prefix shorter than the minimum, or one that diverges, is no match", () => {
    expect(idRank(s, "9cb15657".slice(0, MIN_ID_PREFIX - 1))).toBeNull();
    expect(idRank(s, "9cb15658")).toBeNull();
    expect(idRank(s, "a0dd4f4e")).toBeNull(); // a substring, not a prefix
    expect(idRank(s, "")).toBeNull();
  });

  test("the canonical and id-bearing window names are exact", () => {
    expect(idRank(s, "cl-claude-9cb15657a0dd")).toBe(RANK_EXACT);
    expect(idRank(s, "cl-bg-9cb15657a0dd")).toBe(RANK_EXACT);
    expect(idRank(s, "cl-new-9cb15657a0dd")).toBe(RANK_EXACT);
    expect(idRank(sess({ source: "codex" }), "cl-codex-9cb15657a0dd")).toBe(RANK_EXACT);
  });

  test("an id-bearing name naming another agent, or too short a prefix, is no match", () => {
    expect(idRank(s, "cl-copilot-9cb15657a0dd")).toBeNull();
    expect(idRank(s, "cl-bg-9cb1")).toBeNull();
    expect(idRank(s, "cl-claude-9cb156")).toBe(RANK_ID_PREFIX);
  });

  test("the live window name matches exactly, id-less ones included", () => {
    expect(idRank(s, "cl-pr-81656", "cl-pr-81656")).toBe(RANK_EXACT);
    expect(idRank(s, "cl-bg-codex-593851b62240", "cl-bg-codex-593851b62240")).toBe(RANK_EXACT);
    expect(idRank(s, "cl-pr-8165", "cl-pr-81656")).toBeNull();
    expect(idRank(s, "cl-pr-81656")).toBeNull();
  });

  test("cl-bg-/cl-new- never name a Codex session: its background windows are minted id-less", () => {
    const codex = sess({ source: "codex" });
    expect(idRank(codex, "cl-bg-9cb15657a0dd")).toBeNull();
    expect(idRank(codex, "cl-new-9cb15657a0dd")).toBeNull();
  });

  test("Codex ids are time-ordered: a short prefix matches siblings, the short id only its own", () => {
    const a = sess({ source: "codex", id: "019cde00-1111-7000-8000-00000000cde0" });
    const b = sess({ source: "codex", id: "019cde00-2222-7000-8000-00000000cde1" });
    expect([idRank(a, "019cde00"), idRank(b, "019cde00")]).toEqual([RANK_ID_PREFIX, RANK_ID_PREFIX]);
    expect([idRank(a, "019cde001111"), idRank(b, "019cde001111")]).toEqual([RANK_EXACT, null]);
  });

  test("a word or a PR number is not taken for an id", () => {
    expect(idRank(s, "fix the thing")).toBeNull();
    expect(idRank(s, "81656")).toBeNull();
  });
});

describe("searchContext", () => {
  test("a session's live window name, read from LiveInfo, finds its PR — id-less names included", () => {
    const p = pr(5001, { sessions: [sess()] });
    const windows = { "cl-claude-9cb15657a0dd": "cl-pr-5001" };
    expect(prRank(p, ctx("cl-pr-5001", windows))).toBe(RANK_EXACT);
    expect(prRank(p, ctx("cl-claude-9cb15657a0dd", windows))).toBe(RANK_EXACT); // canonical still works
    expect(prRank(p, ctx("cl-pr-5001"))).toBeNull(); // not live: no such window
  });
  test("parses the query: trimmed, lower-cased, an id-bearing name split, a space inside is not an id", () => {
    expect(ctx("  cl-BG-9cb156 ").query).toMatchObject({ id: "cl-bg-9cb156", named: { kind: "bg", part: "9cb156" }, digits: null });
    expect(ctx("#42").query).toMatchObject({ digits: "42", compact: null, named: null });
    expect(ctx("9cb156 57a0").query).toMatchObject({ compact: null, named: null }); // a space inside: not an id
  });
});

describe("sessionRank", () => {
  test("identity beats the fuzzy title match; the title match still counts", () => {
    expect(sessionRank(sess(), ctx("9cb15657a0dd"))).toBe(RANK_EXACT);
    expect(sessionRank(sess(), ctx("thing"))).toBe(RANK_FUZZY);
    expect(sessionRank(sess(), ctx("zzz"))).toBeNull();
  });
});

describe("rankMatches / uniqueBy", () => {
  test("drops non-matches and orders by rank, keeping input order within a rank", () => {
    const ranks: Record<string, number | null> = { a: 2, b: 0, c: null, d: 2, e: 1 };
    expect(rankMatches(["a", "b", "c", "d", "e"], (x) => ranks[x])).toEqual(["b", "e", "a", "d"]);
  });
  test("the exact PR hit comes first, the fuzzy near-miss stays below it", () => {
    const prs = [pr(81654, { title: "User Story 247306" }), pr(81656)];
    expect(rankMatches(prs, (p) => prRank(p, ctx("81656"))).map((p) => p.id)).toEqual([81656, 81654]);
  });
  test("uniqueBy keeps the first of each key", () => {
    expect(uniqueBy([{ k: "a", n: 1 }, { k: "b", n: 2 }, { k: "a", n: 3 }], (x) => x.k).map((x) => x.n)).toEqual([1, 2]);
  });
});
