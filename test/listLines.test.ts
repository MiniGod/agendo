// The strings above the rows of the list screen (src/ui/screens/listLines.tsx).
// The e2e suite renders the list in every view and with the search box in each
// state, so the shapes are pinned there by screenshot; here each hint's arms
// sit beside one another — what enter does per view, the grouped and sorted
// variants, the repo filter with none, one and several repos — so a change to
// one reads against the rest.
import { describe, expect, test } from "bun:test";
import { repoFilterHint, scopeText, scopeToggleHint, searchHint, viewHint } from "../src/ui/screens/listLines.tsx";

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
