// The strings above the rows of the list screen (src/ui/screens/listLines.tsx).
// The e2e suite renders the list in every view and with the search box in each
// state, so the shapes are pinned there by screenshot; here each hint's arms
// sit beside one another — what enter does per view, the grouped and sorted
// variants, the repo filter with none, one and several repos — so a change to
// one reads against the rest.
import { describe, expect, test } from "bun:test";
import {
  coordinatorHint, pinnedLineCount, repoFilterHint, scopeText, scopeToggleHint, searchHint, teamNoticeLines, teamNoticeText, viewHint,
} from "../src/ui/screens/listLines.tsx";
import type { LoadedModel } from "../src/app/model/types.ts";

const state = { grouped: false, prsGrouped: true, prSort: "created" as const, sessionSort: "updated" as const };

describe("searchHint", () => {
  test("typing and walking the results, with enter naming what it does in that view", () => {
    expect(searchHint("input", "sessions")).toBe("type to filter · ←/→ caret · ⌫ delete · ⌃w del word · ↓ results · enter resume · esc cancel");
    expect(searchHint("input", "items")).toMatch(/· enter open · esc cancel$/);
    expect(searchHint("list", "prs")).toBe("↑/↓ move · ↑ at top edits search · → expand · / edit · enter open · o browser · esc cancel");
  });
});

describe("viewHint", () => {
  test("sessions: the group toggle and the sort in force", () => {
    expect(viewHint("sessions", state)).toMatch(/^↑\/↓ move · → expand · ⇥ view · g group · s sort: updated · \/ search · n new · O orch · G global · enter resume/);
    expect(viewHint("sessions", { ...state, grouped: true })).toContain("· g ungroup ·");
  });

  test("sessions scoped to one repo: O and G open the same orchestrator, so they share one entry", () => {
    expect(coordinatorHint(true)).toBe("O/G orch");
    expect(coordinatorHint(false)).toBe("O orch · G global");
    expect(coordinatorHint(undefined)).toBe("O orch · G global");
    expect(viewHint("sessions", { ...state, repoScope: true })).toContain("· n new · O/G orch · enter resume ·");
  });

  test("PRs: its own group toggle and the sort spelled created or updated", () => {
    expect(viewHint("prs", state)).toContain("· g ungroup · s sort: created ·");
    expect(viewHint("prs", { ...state, prsGrouped: false, prSort: "updated" })).toContain("· g group · s sort: updated ·");
  });

  test("items: neither grouping nor sorting", () => {
    expect(viewHint("items", state)).toBe("↑/↓ move · →/← expand · ⇥ switch view · / search · enter open/expand · o browser · , settings · r refresh · q/esc quit");
  });
});

describe("the scope line", () => {
  test("scoped to the host session's path, or global; the toggle names the other", () => {
    expect(scopeText(true, "agendo", "/w")).toBe("⊙ agendo: /w");
    expect(scopeText(false, "agendo", "/w")).toBe("⊙ global — all paths");
    expect(scopeToggleHint(true, "agendo")).toBe("  · a show all");
    expect(scopeToggleHint(false, "agendo")).toBe("  · a rescope to agendo");
  });

  test("the repo filter: nothing to filter by, off, on with one repo, on with several", () => {
    expect(repoFilterHint(0, true)).toBe("  · f repo filter: no repos found here");
    expect(repoFilterHint(2, false)).toBe("  · f repo filter: off");
    expect(repoFilterHint(1, true)).toBe("  · f repo filter: on (1 repo)");
    expect(repoFilterHint(3, true)).toBe("  · f repo filter: on (3 repos)");
  });
});

describe("pinnedLineCount", () => {
  test("the pinned block's height on the Sessions view, and nothing anywhere else or without one", () => {
    const pins = { repoScope: true, lines: [[{ text: "a" }], [{ text: "b" }]], killable: [], killRoot: null, killLookAlikes: false, killBlocked: null };
    expect(pinnedLineCount("sessions", pins)).toBe(2);
    expect(pinnedLineCount("prs", pins)).toBe(0);
    expect(pinnedLineCount("sessions", null)).toBe(0);
  });
});

describe("teamNoticeText", () => {
  const check = (team: string, mine: string[] | null) => ({ team, project: "Fabrikam", mine });

  test("nothing to say when the team checked out, or wasn't checked", () => {
    expect(teamNoticeText(null)).toBeNull();
    expect(teamNoticeText(undefined)).toBeNull();
  });

  test("no team at all, and a team the project doesn't have", () => {
    expect(teamNoticeText(check("", ["Prisma"]))).toBe("no team is set, so there is no current sprint — set it in , settings");
    expect(teamNoticeText(check("Team Prisma", null))).toBe("team 'Team Prisma' wasn't found in Fabrikam, set it in , settings");
  });

  test("a team that isn't one of the user's names up to three of theirs", () => {
    expect(teamNoticeText(check("Team DES", ["Prisma"]))).toBe("team 'Team DES' isn't one of yours (Prisma), set it in , settings");
    expect(teamNoticeText(check("Team DES", ["A", "B", "C", "D"]))).toBe("team 'Team DES' isn't one of yours (A, B, C, …), set it in , settings");
    expect(teamNoticeText(check("Team DES", []))).toBe("team 'Team DES' isn't one of yours (you're in no team of Fabrikam), set it in , settings");
  });

  test("the viewport reserves its line only in the Work items view, and only when there is one", () => {
    const model = { teamCheck: check("Team DES", ["Prisma"]) } as LoadedModel;
    expect(teamNoticeLines("items", model)).toBe(1);
    expect(teamNoticeLines("sessions", model)).toBe(0);
    expect(teamNoticeLines("items", { teamCheck: null } as LoadedModel)).toBe(0);
    expect(teamNoticeLines("items", null)).toBe(0);
  });
});
