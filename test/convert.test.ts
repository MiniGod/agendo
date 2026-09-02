// The pure halves of the cross-agent convert flow. The e2e suite has no npx and
// never runs the converter, so how its output is read — and what a session
// becomes on the other side — is exactly what a green e2e run says nothing
// about.
import { describe, expect, test } from "bun:test";
import { convertTarget, parseConvertOutput } from "../src/ui/convert.ts";
import { convertedSession, planConvert } from "../src/ui/convertAgent.ts";
import type { AgentSession } from "../src/types.ts";

describe("parseConvertOutput", () => {
  test("takes the last JSON object line, ignoring npx chatter around it", () => {
    const stdout = ["npm warn exec …", '{"progress":1}', "Need to install the following packages", '{"id":"abc","cwd":"/w"}', ""].join("\n");
    expect(parseConvertOutput(stdout, "", null)).toEqual({ id: "abc", cwd: "/w" });
  });

  test("a converter-reported error is thrown with its own words", () => {
    expect(() => parseConvertOutput('{"error":"no such session"}\n', "", null)).toThrow("no such session");
  });

  test("with no answer, stderr wins, then the spawn error, then the stock line", () => {
    expect(() => parseConvertOutput("", "  boom  \n", new Error("spawn failed"))).toThrow("boom");
    expect(() => parseConvertOutput("", "", new Error("spawn failed"))).toThrow("spawn failed");
    expect(() => parseConvertOutput("", "", null)).toThrow("converter produced no result");
  });

  test("a line that starts with { but is not JSON is chatter, not an answer", () => {
    expect(() => parseConvertOutput('{"id":"real"}\n{ not json', "", null)).toThrow("converter produced no result");
  });

  test("an object without an id is not a result either", () => {
    expect(() => parseConvertOutput('{"ok":true}', "", null)).toThrow("converter produced no result");
  });
});

describe("convertTarget", () => {
  test("claude and copilot swap; codex has nowhere to go", () => {
    expect(convertTarget("claude")).toBe("copilot");
    expect(convertTarget("copilot")).toBe("claude");
    expect(convertTarget("codex")).toBeNull();
  });
});

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
  id: "s1",
  source: "claude",
  cwd: "/src/cwd",
  branch: "feature",
  repository: "org/proj/repo",
  title: "Fix the thing",
  lastUsed: new Date(0),
  ...over,
});

describe("planConvert", () => {
  test("refuses a codex session with a notice, not a crash", () => {
    const plan = planConvert(session({ source: "codex" }), () => false);
    expect(plan).toHaveProperty("refusal", expect.stringContaining("codex"));
  });

  test("refuses to turn an orchestrator into a copilot session", () => {
    const plan = planConvert(session(), (id) => id === "s1");
    expect(plan).toHaveProperty("refusal", expect.stringContaining("orchestrator"));
  });

  test("an orchestrator on the copilot side may still come back to claude", () => {
    expect(planConvert(session({ source: "copilot" }), () => true)).toEqual({ dest: "claude", direction: "copilot-to-claude" });
  });

  test("otherwise names the destination and the direction", () => {
    expect(planConvert(session(), () => false)).toEqual({ dest: "copilot", direction: "claude-to-copilot" });
  });
});

describe("convertedSession", () => {
  test("claude→copilot keeps the source cwd and repository", () => {
    const out = convertedSession(session(), "copilot", { id: "new" });
    expect(out).toMatchObject({ id: "new", source: "copilot", cwd: "/src/cwd", branch: "feature", repository: "org/proj/repo", title: "Fix the thing" });
  });

  test("copilot→claude takes the converter's cwd and drops the copilot repository id", () => {
    const out = convertedSession(session({ source: "copilot" }), "claude", { id: "new", cwd: "/reported" });
    expect(out).toMatchObject({ source: "claude", cwd: "/reported", repository: undefined });
  });

  test("lastUsed is now, so the new session sorts to the top", () => {
    const before = Date.now();
    expect(convertedSession(session(), "copilot", { id: "new" }).lastUsed.getTime()).toBeGreaterThanOrEqual(before);
  });
});
