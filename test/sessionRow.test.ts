// What a session row says (src/ui/sessionRow.ts). The e2e suite renders the
// list from fixtures and so reaches most of these states, one per fixture
// session; here every arm is beside the one next to it — placeholder against
// idle against live, each readiness detail, the shell count in the singular
// and the plural — so a change to one reads against the rest.
import { describe, expect, test } from "bun:test";
import type { AgentSession } from "../src/types.ts";
import { timeAgo, type PaneState } from "../src/ui/format.ts";
import {
  displayTimeOf, kindBadge, linkBadge, readinessDetail, sessionRowParts, shellsLabel, statusGlyph, statusTag,
} from "../src/ui/sessionRow.ts";

const created = new Date("2026-09-01T10:00:00Z");
const used = new Date("2026-09-02T10:00:00Z");
const session = { source: "claude", title: "  Fix   the\n thing " + "x".repeat(60), createdAt: created, lastUsed: used } as unknown as AgentSession;
const pane = (readiness: PaneState["readiness"], rest: Partial<PaneState> = {}): PaneState => ({ readiness, shells: 0, ...rest });

describe("sessionRowParts", () => {
  test("an idle session: caret, hollow glyph in gray, source, title squashed (not trimmed) and cut at 50, and its last use", () => {
    const p = sessionRowParts({ session, running: false, expanded: false });
    expect(p).toEqual({
      caret: "▸ ",
      glyph: "○ ",
      glyphColor: "gray",
      source: "[claude] ",
      badge: null,
      title: (" Fix the thing " + "x".repeat(60)).slice(0, 50),
      link: null,
      time: `  ${timeAgo(used)}`,
      status: null,
      shells: null,
      restored: false,
    });
  });

  test("a live session carries its kind badge, its status tag in the status color, and its shells", () => {
    const p = sessionRowParts({ session, running: true, kind: "background", pane: pane("busy", { shells: 2 }), expanded: true });
    expect(p).toMatchObject({
      caret: "▾ ",
      glyph: "● ",
      glyphColor: "yellow",
      badge: "{bg} ",
      status: { text: "  (busy…)", color: "yellow" },
      shells: "  ⛁ 2 shells",
    });
  });

  test("a restore placeholder is paused, not idle, and says so; the link and the creation time are opt-in", () => {
    const open = { pr: { id: 76 }, workItem: { id: 1 } } as unknown as NonNullable<Parameters<typeof linkBadge>[0]>;
    const p = sessionRowParts({ session, running: false, expanded: false, placeholder: true, showLink: true, open, timeField: "created" });
    expect(p).toMatchObject({ glyph: "⏸ ", glyphColor: "gray", restored: true, link: "!76 → WI 1", time: `  ${timeAgo(created)}` });
    expect(sessionRowParts({ session, running: false, expanded: false, open }).link).toBeNull();
  });
});

describe("the parts", () => {
  test("glyph: live, paused, idle", () => {
    expect(statusGlyph(true, true)).toBe("● ");
    expect(statusGlyph(false, true)).toBe("⏸ ");
    expect(statusGlyph(false, false)).toBe("○ ");
    expect(statusGlyph(false, undefined)).toBe("○ ");
  });

  test("badge: only the kinds that have one", () => {
    expect(kindBadge("background")).toBe("{bg} ");
    expect(kindBadge("new")).toBe("{new} ");
    expect(kindBadge("workitem")).toBeNull();
    expect(kindBadge(undefined)).toBeNull();
  });

  test("time: creation when asked for and known, else last use", () => {
    expect(displayTimeOf(session, "created")).toBe(created);
    expect(displayTimeOf(session, "lastUsed")).toBe(used);
    expect(displayTimeOf({ createdAt: undefined, lastUsed: used } as AgentSession, "created")).toBe(used);
  });

  test("status: the readiness label, with a reset time when limited and a percentage when compacting", () => {
    expect(statusTag(undefined)).toEqual({ text: "  (running → attach)", color: "green" });
    expect(statusTag(pane("ready"))).toEqual({ text: "  (ready → attach)", color: "green" });
    expect(statusTag(pane("compacting", { compactionPercent: 42 }))).toEqual({ text: "  (compacting… · 42%)", color: "yellow" });
    expect(statusTag(pane("compacting"))).toEqual({ text: "  (compacting…)", color: "yellow" });
    expect(statusTag(pane("limited", { resetAt: null }))).toEqual({ text: "  (usage limit · no reset time)", color: "red" });
    expect(readinessDetail(pane("limited", { resetAt: Date.now() - 60_000 }))).toMatch(/^ · reset passed /);
    expect(readinessDetail(pane("limited", { resetAt: Date.now() + 3_600_000 }))).toMatch(/^ · resets /);
    expect(readinessDetail(pane("dialog"))).toBe("");
    expect(readinessDetail(undefined)).toBe("");
  });

  test("shells: counted only while running, singular and plural, nothing for none", () => {
    expect(shellsLabel(false, pane("ready", { shells: 3 }))).toBeNull();
    expect(shellsLabel(true, undefined)).toBeNull();
    expect(shellsLabel(true, pane("ready"))).toBeNull();
    expect(shellsLabel(true, pane("ready", { shells: 1 }))).toBe("  ⛁ 1 shell");
    expect(shellsLabel(true, pane("ready", { shells: 2 }))).toBe("  ⛁ 2 shells");
  });

  test("link: the PR, the work item, both, or nothing", () => {
    const t = (open: unknown) => linkBadge(open as Parameters<typeof linkBadge>[0]);
    expect(t(undefined)).toBeNull();
    expect(t({})).toBeNull();
    expect(t({ pr: { id: 76 } })).toBe("!76");
    expect(t({ workItem: { id: 1 } })).toBe("WI 1");
    expect(t({ pr: { id: 76 }, workItem: { id: 1 } })).toBe("!76 → WI 1");
  });
});
