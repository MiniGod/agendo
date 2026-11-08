// How often the GitHub provider may ask GitHub (src/providers/github/throttle.ts).
// e2e drives one load against the fake `gh`, so it sees one fetch and, for the
// rate-limited case, one failure with nothing cached. Reuse across loads, the
// clock running past the TTL or the reset, stale data served under a warning,
// and the secondary-limit backoff need a clock, which the suite cannot move.
import { beforeEach, describe, expect, test } from "bun:test";
import { Throttle, TTL_MS, clock } from "../src/providers/github/throttle.ts";
import { isRetryable, takeWarnings } from "../src/shared/errors.ts";

const LIMITED = new Error("gh api graphql -> exit 1: gh: API rate limit already exceeded for user ID 1.");
const SECONDARY = new Error("gh api graphql -> exit 1: gh: You have exceeded a secondary rate limit.");

/** A Throttle over a scripted fetch and a hand-moved clock. */
function rig(opts: { reset?: number | null } = {}) {
  let t = 1_000_000;
  const outcomes: Array<string | Error> = [];
  const fetched: string[] = [];
  let probes = 0;
  const throttle = new Throttle<string>({
    fetch: async (key) => {
      fetched.push(key);
      const next = outcomes.shift() ?? `${key}@${t}`;
      if (next instanceof Error) throw next;
      return next;
    },
    resetAt: async () => {
      probes++;
      return opts.reset === undefined ? t + 30 * 60_000 : opts.reset;
    },
    now: () => t,
  });
  return {
    throttle, fetched, outcomes,
    probes: () => probes,
    advance: (ms: number) => { t += ms; },
    now: () => t,
  };
}

beforeEach(() => { takeWarnings(); });

describe("Throttle", () => {
  test("a value is reused until the TTL runs out, then fetched again", async () => {
    const r = rig();
    const first = await r.throttle.get("ada");
    r.advance(TTL_MS - 1);
    expect(await r.throttle.get("ada")).toBe(first);
    r.advance(1);
    expect(await r.throttle.get("ada")).not.toBe(first);
    expect(r.fetched).toEqual(["ada", "ada"]);
  });

  test("callers that arrive mid-fetch share it; keys do not", async () => {
    const r = rig();
    const [a, b, c] = await Promise.all([r.throttle.get("ada"), r.throttle.get("ada"), r.throttle.get("bob")]);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(r.fetched).toEqual(["ada", "bob"]);
  });

  test("invalidate makes the next get fetch again", async () => {
    const r = rig();
    await r.throttle.get("ada");
    r.throttle.invalidate();
    await r.throttle.get("ada");
    expect(r.fetched).toEqual(["ada", "ada"]);
  });

  test("invalidate while rate limited asks nothing: it serves the last value under the warning", async () => {
    const r = rig();
    const old = await r.throttle.get("ada");
    r.advance(TTL_MS);
    r.outcomes.push(LIMITED);
    await r.throttle.get("ada");
    takeWarnings();
    r.throttle.invalidate();
    expect(await r.throttle.get("ada")).toBe(old);
    expect(r.fetched).toHaveLength(2);
    expect(takeWarnings()).toHaveLength(1);
  });

  test("invalidate during a fetch: the next get asks again, and the earlier answer is not kept even if it lands last", async () => {
    const answers: Array<(v: string) => void> = [];
    const throttle = new Throttle<string>({
      fetch: () => new Promise<string>((resolve) => answers.push(resolve)),
      resetAt: async () => null,
      now: () => 0,
    });
    const before = throttle.get("ada");
    throttle.invalidate();
    const after = throttle.get("ada");
    expect(answers).toHaveLength(2);
    answers[1]!("new");
    expect(await after).toBe("new");
    answers[0]!("old");
    expect(await before).toBe("old"); // its own callers still get their answer…
    expect(await throttle.get("ada")).toBe("new"); // …but the cache keeps the later one
    expect(answers).toHaveLength(2);
  });

  test("any other failure is thrown as it is, and the next get tries again", async () => {
    const r = rig();
    const boom = new Error("gh api graphql -> exit 1: HTTP 502");
    r.outcomes.push(boom);
    await expect(r.throttle.get("ada")).rejects.toBe(boom);
    expect(r.probes()).toBe(0);
    await r.throttle.get("ada");
    expect(r.fetched).toHaveLength(2);
  });

  test("rate limited with nothing cached: fails, non-retryable, naming the reset time", async () => {
    const r = rig();
    r.outcomes.push(LIMITED);
    const error = await r.throttle.get("ada").catch((e) => e);
    expect(error.message).toBe(`GitHub rate limited until ${clock(r.now() + 30 * 60_000)}`);
    expect(isRetryable(error)).toBe(false);
  });

  test("rate limited: nothing is asked again until the reset; then it is", async () => {
    const r = rig();
    r.outcomes.push(LIMITED);
    await r.throttle.get("ada").catch(() => {});
    r.advance(30 * 60_000 - 1);
    r.throttle.invalidate();
    await expect(r.throttle.get("ada")).rejects.toThrow("rate limited");
    expect(r.fetched).toHaveLength(1);
    expect(r.probes()).toBe(1);
    r.advance(1);
    expect(await r.throttle.get("ada")).toBe(`ada@${r.now()}`);
    expect(r.fetched).toHaveLength(2);
  });

  test("rate limited with a value in hand: serves it, with a warning saying until when and from when", async () => {
    const r = rig();
    const old = await r.throttle.get("ada");
    const at = r.now();
    r.advance(TTL_MS);
    r.outcomes.push(LIMITED);
    expect(await r.throttle.get("ada")).toBe(old);
    expect(takeWarnings()).toEqual([`GitHub rate limited until ${clock(r.now() + 30 * 60_000)} — showing data from ${clock(at)}`]);
    // …and keeps serving it, without asking, while the gate is closed.
    r.advance(60_000);
    expect(await r.throttle.get("ada")).toBe(old);
    expect(r.fetched).toHaveLength(2);
  });

  test("a secondary limit (no reset to read) backs off from a minute, doubling, capped at fifteen", async () => {
    let t = 0;
    let fetches = 0;
    const throttle = new Throttle<string>({
      fetch: async () => { fetches++; throw SECONDARY; },
      resetAt: async () => null,
      now: () => t,
    });
    await throttle.get("ada").catch(() => {});
    for (const minutes of [1, 2, 4, 8, 15, 15]) {
      const before = fetches;
      t += minutes * 60_000 - 1;
      await throttle.get("ada").catch(() => {});
      expect(fetches).toBe(before);
      t += 1;
      await throttle.get("ada").catch(() => {});
      expect(fetches).toBe(before + 1);
    }
  });

  test("a reset already in the past counts as a secondary limit", async () => {
    const r = rig({ reset: 0 });
    r.outcomes.push(LIMITED);
    const error = await r.throttle.get("ada").catch((e) => e);
    expect(error.message).toBe(`GitHub rate limited until ${clock(r.now() + 60_000)}`);
  });

  test("a success resets the backoff", async () => {
    const r = rig({ reset: null });
    r.outcomes.push(SECONDARY);
    await r.throttle.get("ada").catch(() => {});
    r.advance(60_000);
    await r.throttle.get("ada");
    r.advance(TTL_MS);
    r.outcomes.push(SECONDARY);
    await r.throttle.get("ada");
    expect(takeWarnings()[0]).toStartWith(`GitHub rate limited until ${clock(r.now() + 60_000)}`);
  });

  test("a failed budget read falls back to backing off", async () => {
    const r = rig();
    const throttle = new Throttle<string>({
      fetch: async () => { throw LIMITED; },
      resetAt: async () => { throw new Error("offline"); },
      now: r.now,
    });
    await expect(throttle.get("ada")).rejects.toThrow(`until ${clock(r.now() + 60_000)}`);
  });
});

describe("clock", () => {
  test("local 24-hour HH:MM", () => {
    expect(clock(new Date(2026, 9, 29, 7, 5).getTime())).toBe("07:05");
    expect(clock(new Date(2026, 9, 29, 23, 59).getTime())).toBe("23:59");
  });
});
