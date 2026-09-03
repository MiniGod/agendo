// `agendo wait`'s argv (src/wait/args.ts). The e2e suite drives the command
// with the flags a real wait uses and reaches the happy paths and a couple of
// refusals; here every flag sits beside the next, with the refusals as return
// codes — the function reports rather than exits, which is what makes this
// possible — and `console.error` captured so each one's line is checked too.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseDuration, parseWaitArgs } from "../src/wait/args.ts";
import type { WaitOptions } from "../src/wait/types.ts";

const realError = console.error;
let errors: string[];
beforeEach(() => {
  errors = [];
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
});
afterEach(() => {
  console.error = realError;
});

const parse = (...rest: string[]) => parseWaitArgs(rest, "/w");
const opts = (...rest: string[]) => parse(...rest) as WaitOptions;

describe("parseDuration", () => {
  test("bare seconds, each unit, and nothing for a malformed or missing string", () => {
    expect(parseDuration("2")).toBe(2_000);
    expect(parseDuration("500ms")).toBe(500);
    expect(parseDuration("1.5s")).toBe(1_500);
    expect(parseDuration("5M")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration(undefined)).toBeNull();
  });
});

describe("parseWaitArgs", () => {
  test("nothing asked for: no ids, the defaults, the cwd's scope", () => {
    expect(opts()).toMatchObject({ ids: [], all: false, any: false, json: false, timeoutMs: 120_000, intervalMs: 2_000 });
    expect(opts().prefix).toBeUndefined();
    expect(opts().state).toBeUndefined();
  });

  test("toggles, ids, and `--` escaping whatever follows", () => {
    expect(opts("--all", "--any", "--json", "abc", "def")).toMatchObject({ all: true, any: true, json: true, ids: ["abc", "def"] });
    expect(opts("abc", "--", "--not-a-flag", "ghi").ids).toEqual(["abc", "--not-a-flag", "ghi"]);
  });

  test("value flags: prefix raw (even empty), state and not, timeout and interval as durations", () => {
    expect(opts("--prefix", "", "--state", "ready", "--timeout", "5m", "--interval", "500ms")).toMatchObject({
      prefix: "", state: "ready", timeoutMs: 300_000, intervalMs: 500,
    });
    expect(opts("--not", "busy").not).toBe("busy");
  });

  test("scope: --repo and --path each need a value that is not another flag", () => {
    expect(opts("--repo", "agendo").scope).toMatchObject({ repo: "agendo" });
    expect(parse("--path")).toBe(1);
    expect(parse("--repo", "--all")).toBe(1);
    expect(errors).toEqual(["wait: --path needs a value", "wait: --repo needs a value"]);
  });

  test("a bad duration names the flag and what it got", () => {
    expect(parse("--timeout", "soon")).toBe(1);
    expect(parse("--interval")).toBe(1);
    expect(errors).toEqual([
      'wait: --timeout needs a duration like 500ms, 2s, 5m, 1h (got "soon")',
      'wait: --interval needs a duration like 500ms, 2s, 5m, 1h (got "")',
    ]);
  });

  test("states must be states, and only one of --state / --not", () => {
    expect(parse("--state", "asleep")).toBe(1);
    expect(parse("--not", "gone")).toBe(1);
    expect(parse("--state", "ready", "--not", "busy")).toBe(1);
    expect(errors).toEqual([
      'wait: --state must be one of ready|busy|compacting|queued|dialog|limited|unknown|exited, got "asleep"',
      'wait: --not must be one of ready|busy|compacting|queued|dialog|limited|unknown|exited, got "gone"',
      "wait: use only one of --state / --not",
    ]);
  });

  test("a dashed token that is not a flag is a mistyped flag, not a session id", () => {
    expect(parse("--repo=x")).toBe(1);
    expect(parse("-v")).toBe(1);
    expect(errors).toEqual(['wait: unknown argument "--repo=x"', 'wait: unknown argument "-v"']);
  });
});
