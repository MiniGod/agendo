// The reset time in a usage-limit notice (src/usageLimit.ts `parseResetTime`).
// The e2e suite's spec cases for this function run in-process under Playwright,
// which the instrumented bun never sees, and the fixture panes it drives the
// TUI and CLI with all say a same-day "2:10pm": under measurement only that
// path was ever entered. Here every arm of the parse is beside the one next to
// it — no anchor, no time, each clock spelling, a zone the runtime knows and one
// it doesn't, a date, a weekday, a bare time — each rolled forward or left
// standing by the lookback. Expectations are built with the same local-time
// constructor the parser uses, so they hold in any zone the test runs in.
import { describe, expect, test } from "bun:test";
import { BARE_TIME_LOOKBACK_MS, parseResetTime } from "../src/usageLimit.ts";

/** Wed Sep 2 2026, 10:00 local. */
const now = new Date(2026, 8, 2, 10, 0);
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const at = (notice: string, lookbackMs = 0) => parseResetTime(notice, now, lookbackMs);

describe("the anchor", () => {
  test("no reset phrase, or one whose time sits on the next line, is no time", () => {
    expect(at("You've hit your limit. Try again later.")).toBeNull();
    expect(at("Your limit resets\n3pm")).toBeNull();
    expect(at("Your limit resets soon")).toBeNull();
  });

  test("a stray `reset` before the notice is skipped once the phrase is present", () => {
    expect(at("$ git reset --hard at 3pm\nYou've hit your usage limit · resets 4pm")).toBe(local(2026, 9, 2, 16));
    expect(at("git reset at 3pm")).toBe(local(2026, 9, 2, 15));
  });
});

describe("the clock", () => {
  test("am/pm with and without minutes, noon and midnight, and a 24h time", () => {
    expect(at("resets 3pm")).toBe(local(2026, 9, 2, 15));
    expect(at("resets at 3:30pm")).toBe(local(2026, 9, 2, 15, 30));
    expect(at("resets by 11:15 A.M.")).toBe(local(2026, 9, 2, 11, 15));
    expect(at("resets 12pm")).toBe(local(2026, 9, 2, 12));
    expect(at("resets 12am", BARE_TIME_LOOKBACK_MS)).toBe(local(2026, 9, 3, 0));
    expect(at("resets at 15:30")).toBe(local(2026, 9, 2, 15, 30));
    expect(at("resets at 4.30pm")).toBeNull(); // the hour is bounded so the stray "30pm" can't match
  });
});

describe("the zone", () => {
  test("a zone the runtime knows is honoured; one it doesn't falls back to local time", () => {
    expect(at("resets 3pm (Etc/UTC)")).toBe(Date.UTC(2026, 8, 2, 15, 0));
    expect(at("resets 3pm (Mars/Olympus)")).toBe(local(2026, 9, 2, 15));
  });

  test("the zone's letters never read as a weekday: Monterrey is not Monday", () => {
    expect(at("resets 3pm (America/Monterrey)")).toBe(at("resets 3pm (America/Mexico_City)"));
  });
});

describe("a date", () => {
  test("this year while it is ahead or within the lookback, next year once long past; an unknown month is not a date", () => {
    expect(at("resets Oct 24 at 3pm")).toBe(local(2026, 10, 24, 15));
    expect(at("resets April 24 at 3pm")).toBe(local(2027, 4, 24, 15));
    expect(at("resets Sep 1 at 3pm", 2 * 24 * 3600_000)).toBe(local(2026, 9, 1, 15));
    expect(at("resets Foo 24 at 3pm")).toBe(local(2026, 9, 2, 15));
  });
});

describe("a weekday", () => {
  test("ahead in the week, today when its time is still to come, next week once past, and standing within the lookback", () => {
    expect(at("resets Friday 3pm")).toBe(local(2026, 9, 4, 15));
    expect(at("resets Wednesday 11am")).toBe(local(2026, 9, 2, 11));
    expect(at("resets Wed 9am")).toBe(local(2026, 9, 9, 9));
    expect(at("resets Wed 9am", 2 * 3600_000)).toBe(local(2026, 9, 2, 9));
    expect(at("resets Tuesday 9am")).toBe(local(2026, 9, 8, 9));
  });
});

describe("a bare time", () => {
  test("today while ahead or just passed, tomorrow once past the capped lookback", () => {
    expect(at("resets 9am")).toBe(local(2026, 9, 3, 9));
    expect(at("resets 9am", 2 * 3600_000)).toBe(local(2026, 9, 2, 9));
    expect(parseResetTime("resets 1am", new Date(2026, 8, 2, 23, 0), 8 * 24 * 3600_000)).toBe(local(2026, 9, 3, 1));
  });
});
