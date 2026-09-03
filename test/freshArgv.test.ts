// `freshArgv` (src/launchArgv.ts): the command line a brand-new agent window
// runs. The e2e suite launches each agent through it, but only in the shapes
// the fixtures use; the ORDER the flags come in is the contract here — a codex
// prompt after every flag, a forwarded `--model` after the autonomy flags — and
// order is exactly what a green launch cannot vouch for.
import { describe, expect, test } from "bun:test";
import { freshArgv } from "../src/launchArgv.ts";

/** The argv after the `env` prefix `withSelfCmdEnv` puts on. */
function command(argv: string[]): string[] {
  expect(argv[0]).toBe("env");
  const at = argv.findIndex((a, i) => i > 0 && !a.includes("="));
  return argv.slice(at);
}

describe("freshArgv", () => {
  test("copilot: session id, autonomy, forwarded flags, then an interactive prompt", () => {
    expect(command(freshArgv("copilot"))).toEqual(["copilot"]);
    expect(command(freshArgv("copilot", { sessionId: "s1", autonomy: true, forwardArgv: ["--model", "gpt"], prompt: "do it" }))).toEqual([
      "copilot", "--session-id", "s1", "--autopilot", "--allow-all-tools", "--model", "gpt", "--interactive", "do it",
    ]);
  });

  test("codex: no session id, and the prompt is the last positional", () => {
    expect(command(freshArgv("codex", { sessionId: "ignored" }))).toEqual(["codex"]);
    expect(command(freshArgv("codex", { autonomy: true, forwardArgv: ["--model", "o3"], prompt: "task" }))).toEqual([
      "codex", "--approve-for-me", "--model", "o3", "task",
    ]);
  });

  test("claude: session id, autonomy, forwarded flags, prompt, then the launcher system prompt", () => {
    const argv = command(freshArgv("claude", { sessionId: "s2", autonomy: true, forwardArgv: ["--model", "opus"], prompt: "go" }));
    expect(argv.slice(0, 2)).toEqual(["claude", "--session-id", "s2"].slice(0, 2));
    expect(argv.indexOf("--permission-mode")).toBeGreaterThan(argv.indexOf("s2"));
    expect(argv.indexOf("--model")).toBeGreaterThan(argv.indexOf("auto"));
    expect(argv.indexOf("go")).toBeGreaterThan(argv.indexOf("opus"));
    expect(argv.at(-2)).toBe("--append-system-prompt");
    expect(argv.indexOf("--append-system-prompt")).toBeGreaterThan(argv.indexOf("go"));
  });

  test("an orchestrator's role prompt rides in the same --append-system-prompt", () => {
    const plain = command(freshArgv("claude")).at(-1) ?? "";
    const repo = command(freshArgv("claude", { orchestrator: "repo" })).at(-1) ?? "";
    expect(repo.startsWith(plain)).toBe(true);
    expect(repo.length).toBeGreaterThan(plain.length);
  });

  test("an empty forwardArgv adds nothing", () => {
    expect(command(freshArgv("codex", { forwardArgv: [] }))).toEqual(["codex"]);
  });
});
