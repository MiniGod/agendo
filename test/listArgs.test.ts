// The argv of `list` and its subcommands (src/cli/listArgs.ts). The e2e suite
// runs every listing end to end and reaches the flags orchestrators use; what
// it never does is name the path scope twice, hand `--pr` a word, put a dashed
// token nobody knows on `list repos`, or give a switch its own tail. Those
// refusals are here, with `process.exit` stubbed to throw so each one is an
// assertion, and every accepted shape beside the one next to it.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { duplicatePathScope, requireDuration, requireValue, unknownArgument } from "../src/cli/args.ts";
import { listRoute, parseRepoListArgs, parseResourceListArgs, parseSessionListArgs } from "../src/cli/listArgs.ts";

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

describe("the guards", () => {
  test("a duration flag needs a duration; a scope flag needs a value; the rest name what was refused", () => {
    expect(requireDuration("list", "--stalled-after", "5m")).toBe(300_000);
    expect(exitCode(() => requireDuration("list", "--stalled-after", "soon"))).toBe(1);
    expect(exitCode(() => requireDuration("status", "--stalled-after", undefined))).toBe(1);
    expect(requireValue("list", "--repo", "agendo")).toBe("agendo");
    expect(exitCode(() => requireValue("list", "--repo", undefined))).toBe(1);
    expect(exitCode(() => duplicatePathScope())).toBe(1);
    expect(exitCode(() => unknownArgument("list prs", "--bogus"))).toBe(1);
    expect(errors).toEqual([
      'list: --stalled-after needs a duration like 500ms, 2s, 5m, 1h (got "soon")',
      'status: --stalled-after needs a duration like 500ms, 2s, 5m, 1h (got "")',
      expect.stringContaining("--repo"),
      "list: the path scope was given twice — [dir] and --path <dir> name the same slot",
      'list prs: unknown argument "--bogus"',
    ]);
  });
});

describe("listRoute", () => {
  test("only the exact keywords route; anything else is the session list's [dir]", () => {
    expect(listRoute(undefined)).toEqual({ kind: "sessions" });
    expect(listRoute("repos")).toEqual({ kind: "repos", sub: "repos" });
    expect(listRoute("repo")).toEqual({ kind: "repos", sub: "repo" });
    expect(listRoute("prs")).toEqual({ kind: "prs", sub: "prs" });
    expect(listRoute("pr")).toEqual({ kind: "prs", sub: "pr" });
    for (const sub of ["issue", "issues", "wi", "work-item", "work-items", "workitem", "workitems"]) {
      expect(listRoute(sub)).toEqual({ kind: "issues", sub });
    }
    expect(listRoute("./somewhere")).toEqual({ kind: "sessions" });
    expect(listRoute("--pr")).toEqual({ kind: "sessions" });
  });
});

describe("parseResourceListArgs", () => {
  test("the dir context, the filter switch either way, --json; a second positional or a dashed stranger is refused", () => {
    expect(parseResourceListArgs("prs", [])).toEqual({ json: false });
    expect(parseResourceListArgs("prs", ["--json", "./repos", "--no-repo-filter"])).toEqual({ json: true, dirArg: "./repos", repoFilter: false });
    expect(parseResourceListArgs("issues", ["--repo-filter"])).toEqual({ json: false, repoFilter: true });
    expect(exitCode(() => parseResourceListArgs("prs", ["a", "b"]))).toBe(1);
    expect(exitCode(() => parseResourceListArgs("wi", ["--repo", "x"]))).toBe(1);
    expect(errors).toEqual(['list prs: unknown argument "b"', 'list wi: unknown argument "--repo"']);
  });
});

describe("parseRepoListArgs", () => {
  test("[dir] or --path, --repo, --json; the path slot twice is refused whichever spelling came first", () => {
    expect(parseRepoListArgs("repos", [])).toEqual({ json: false });
    expect(parseRepoListArgs("repos", ["--json", "--path", "./w", "--repo", "agendo"])).toEqual({ json: true, dirArg: "./w", repoArg: "agendo" });
    expect(parseRepoListArgs("repos", ["./w"])).toEqual({ json: false, dirArg: "./w" });
    expect(exitCode(() => parseRepoListArgs("repos", ["./w", "--path", "./x"]))).toBe(1);
    expect(exitCode(() => parseRepoListArgs("repos", ["--path", "./x", "./w"]))).toBe(1);
    expect(exitCode(() => parseRepoListArgs("repo", ["--all"]))).toBe(1);
    expect(exitCode(() => parseRepoListArgs("repos", ["--path"]))).toBe(1);
    expect(errors[0]).toBe("list: the path scope was given twice — [dir] and --path <dir> name the same slot");
    expect(errors[1]).toBe(errors[0]);
    expect(errors[2]).toBe('list repo: unknown argument "--all"');
  });
});

describe("parseSessionListArgs", () => {
  test("nothing asked is the live list; every flag in one line, each landing in its own slot", () => {
    expect(parseSessionListArgs([])).toEqual({ json: false, all: false });
    expect(parseSessionListArgs(["--json", "--include-idle", "--stalled-after", "2s", "--pr", "76", "--work-item", "1", "--repo", "agendo", "./w"])).toEqual({
      json: true, all: true, stalledAfterMs: 2_000, pr: 76, item: 1, repoArg: "agendo", dirArg: "./w",
    });
    expect(parseSessionListArgs(["--all", "--issue", "1", "--path", "./w"])).toEqual({ json: false, all: true, item: 1, dirArg: "./w" });
    expect(parseSessionListArgs(["--workitem", "1"])).toEqual({ json: false, all: false, item: 1 });
  });

  test("a value flag takes the next token whatever it is, so a flag left dangling does not eat a positional's meaning", () => {
    expect(exitCode(() => parseSessionListArgs(["--pr"]))).toBe(1);
    expect(exitCode(() => parseSessionListArgs(["--pr", "seventy-six"]))).toBe(1);
    expect(exitCode(() => parseSessionListArgs(["--issue", "--json"]))).toBe(1);
    expect(errors).toEqual(Array(3).fill("list: --pr/--issue/--work-item need a numeric id"));
  });

  test("the path slot twice, a bad duration, a dashed stranger", () => {
    expect(exitCode(() => parseSessionListArgs(["./w", "--path", "./x"]))).toBe(1);
    expect(exitCode(() => parseSessionListArgs(["--stalled-after", "later"]))).toBe(1);
    expect(exitCode(() => parseSessionListArgs(["--stalled-after=1h"]))).toBe(1);
    expect(exitCode(() => parseSessionListArgs(["--repo"]))).toBe(1);
    expect(errors[0]).toBe("list: the path scope was given twice — [dir] and --path <dir> name the same slot");
    expect(errors[1]).toBe('list: --stalled-after needs a duration like 500ms, 2s, 5m, 1h (got "later")');
    expect(errors[2]).toBe('list: unknown argument "--stalled-after=1h"');
  });
});
