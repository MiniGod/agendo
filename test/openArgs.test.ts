// The argv of `open` (src/cli/openArgs.ts). The e2e suite opens a session's PR
// and work item and prints the links; what it never does is name both
// selectors, hand `open` a dashed token nobody knows, give it two ids, or
// leave `--path` without a value. Those refusals are here, with `process.exit`
// stubbed to throw so each one is an assertion.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseOpenArgs } from "../src/cli/openArgs.ts";

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code}`);
  }
}

const realExit = process.exit;
const realError = console.error;
let errors: string[];

beforeEach(() => {
  errors = [];
  process.exit = ((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
});

afterEach(() => {
  process.exit = realExit;
  console.error = realError;
});

/** The exit code a refusal ended with, or null when the call returned. */
function exitCode(fn: () => unknown): number | null | undefined {
  try {
    fn();
    return null;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}

describe("parseOpenArgs", () => {
  test("nothing, an id, the selectors and the print switch, in any order", () => {
    expect(parseOpenArgs([])).toEqual({ printOnly: false });
    expect(parseOpenArgs(["abc", "--pr", "-p"])).toEqual({ token: "abc", want: "pr", printOnly: true });
    expect(parseOpenArgs(["--print", "--issue", "abc"])).toEqual({ token: "abc", want: "item", printOnly: true });
    expect(parseOpenArgs(["--work-item"]).want).toBe("item");
    expect(parseOpenArgs(["--workitem"]).want).toBe("item");
    expect(parseOpenArgs(["--pr", "--pr", "abc"])).toEqual({ token: "abc", want: "pr", printOnly: false });
  });

  test("the scope selectors take a value each", () => {
    expect(parseOpenArgs(["--path", "/p", "abc", "--repo", "r"])).toEqual({
      token: "abc", printOnly: false, pathArg: "/p", repoArg: "r",
    });
    expect(exitCode(() => parseOpenArgs(["abc", "--path"]))).toBe(1);
    expect(errors).toEqual([expect.stringContaining("--path")]);
  });

  test("two different selectors, an unknown dashed token and a second id are refused", () => {
    expect(exitCode(() => parseOpenArgs(["--pr", "--issue"]))).toBe(1);
    expect(exitCode(() => parseOpenArgs(["--work-item", "abc", "--pr"]))).toBe(1);
    expect(exitCode(() => parseOpenArgs(["--bogus"]))).toBe(1);
    expect(exitCode(() => parseOpenArgs(["abc", "def"]))).toBe(1);
    expect(errors).toEqual([
      "open: use only one of --pr / --work-item",
      "open: use only one of --pr / --work-item",
      'open: unknown argument "--bogus"',
      'open: unexpected argument "def"',
    ]);
  });
});
