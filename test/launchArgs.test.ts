// `agendo launch`'s argv (src/cli/launchCmd.ts), one token at a time. The e2e
// suite launches real sessions with the flags a user would type; what it never
// types is the rejected forms — a value on a switch, a flag where a value
// should be, a bare --worktree followed by a path, a flag the agent does not
// take — nor every spelling of the same flag side by side. Those are here,
// with `process.exit` stubbed to throw so a refusal is an assertion.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseLaunchArgs } from "../src/cli/launchCmd.ts";

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

const refused = (argv: string[]): string => {
  try {
    parseLaunchArgs(argv);
  } catch (e) {
    if (e instanceof Exit && e.code === 1) return errors[errors.length - 1];
    throw e;
  }
  throw new Error("parsed");
};

describe("parseLaunchArgs", () => {
  test("nothing: the defaults, with worktree left unspecified", () => {
    expect(parseLaunchArgs([])).toEqual({
      attach: false, orchestrator: false, global: false, unattended: false, agent: "claude", forwardArgv: [], positionals: [],
    });
  });

  test("every switch, long and short", () => {
    expect(parseLaunchArgs(["-a", "--no-worktree", "-O", "--unattended", "--codex", "--window"])).toMatchObject({
      attach: true, worktree: false, orchestrator: true, unattended: true, agent: "codex", layout: "window",
    });
    expect(parseLaunchArgs(["--attach", "--orchestrator", "--copilot", "--pane", "--global"])).toMatchObject({
      attach: true, orchestrator: true, agent: "copilot", layout: "pane", global: true,
    });
    expect(parseLaunchArgs(["-G", "--claude"])).toMatchObject({ global: true, agent: "claude" });
    expect(parseLaunchArgs(["--global-orchestrator"]).global).toBe(true);
  });

  test("a value flag in both forms, and the token after it consumed only in the two-token form", () => {
    expect(parseLaunchArgs(["--name=fix", "--agent", "codex", "--model=opus", "hello"])).toMatchObject({
      name: "fix", agent: "codex", forwardArgv: ["--model", "opus"], positionals: ["hello"],
    });
    expect(parseLaunchArgs(["-n", "fix", "--model", "opus"])).toMatchObject({ name: "fix", forwardArgv: ["--model", "opus"] });
  });

  test("--worktree: bare is yes, =path adopts, and a path after a bare one is refused as a mistake", () => {
    expect(parseLaunchArgs(["--worktree"])).toMatchObject({ worktree: true });
    expect(parseLaunchArgs(["--worktree"]).worktreePath).toBeUndefined();
    expect(parseLaunchArgs(["--worktree", "fix the thing"])).toMatchObject({ worktree: true, positionals: ["fix the thing"] });
    const adopted = parseLaunchArgs(["--worktree=/w/x"]);
    expect(adopted.worktreePath).toBe("/w/x");
    expect(adopted.worktree).toBeUndefined();
    expect(refused(["--worktree", "a/b"])).toMatch(/looks like a path/);
    expect(refused(["--worktree="])).toBe("launch failed: --worktree= needs a path");
  });

  test("everything after -- is prompt, flags included; a bare unknown --flag is refused", () => {
    expect(parseLaunchArgs(["fix", "--", "--not-a-flag", "-O"])).toMatchObject({ positionals: ["fix", "--not-a-flag", "-O"], orchestrator: false });
    expect(refused(["--nope"])).toMatch(/^launch failed: unknown flag "--nope" \(forwardable agent flags: /);
    expect(refused(["--attach=yes"])).toMatch(/unknown flag "--attach=yes"/);
  });

  test("a switch given a value is refused, in every spelling", () => {
    expect(refused(["--orchestrator=1"])).toBe('launch failed: --orchestrator takes no value (got "--orchestrator=1")');
    expect(refused(["-O=1"])).toBe('launch failed: --orchestrator takes no value (got "-O=1")');
    expect(refused(["--global-orchestrator=1"])).toBe('launch failed: --global-orchestrator takes no value (got "--global-orchestrator=1")');
    expect(refused(["-G=1"])).toBe('launch failed: --global-orchestrator takes no value (got "-G=1")');
  });

  test("a value flag without a value, or with a flag in its place, is refused; an unknown agent too", () => {
    expect(refused(["--model"])).toBe("launch failed: --model needs a value");
    expect(refused(["--model="])).toBe("launch failed: --model needs a value");
    expect(refused(["--model", "--attach"])).toBe("launch failed: --model needs a value");
    expect(refused(["--agent", "gemini"])).toBe('launch failed: --agent must be one of claude, copilot, codex, got "gemini"');
    expect(refused(["--agent"])).toBe('launch failed: --agent must be one of claude, copilot, codex, got ""');
  });

  test("a forwarded flag the chosen agent does not take is refused, whichever order they came in", () => {
    expect(refused(["--fallback-model=x", "--agent", "codex"])).toBe("launch failed: --fallback-model isn't supported by --agent codex");
    expect(refused(["--codex", "--fallback-model", "x"])).toBe("launch failed: --fallback-model isn't supported by --agent codex");
    expect(parseLaunchArgs(["--fallback-model=x", "--model", "opus"]).forwardArgv).toEqual(["--fallback-model", "x", "--model", "opus"]);
  });
});
