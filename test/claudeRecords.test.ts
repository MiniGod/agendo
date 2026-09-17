// Claude's per-process session record (src/sessions/records.ts): the file
// window adoption rests its identity on. Pure parsing, and untestable through
// the e2e suite for the usual reason: every record a fixture writes is
// well-formed, and well-formed input is where a validating parser and a
// trusting one agree. What matters is what a malformed, foreign or headless
// record degrades to — and it must be "no record", never a confident wrong pane.
import { describe, expect, test } from "bun:test";
import { parseClaudeProcessRecord, parseTmuxLocation, pidAlive } from "../src/sessions/records.ts";

const DIR = "/home/dev/.claude";

/** A record as claude 2.1.x writes it, trimmed to the fields that matter. */
const FULL = {
  pid: 4242,
  sessionId: "0e6e2941-73bb-4f49-ab40-c921bc6959f5",
  cwd: "/home/dev/repo",
  startedAt: 1789562887045,
  version: "2.1.273",
  kind: "interactive",
  entrypoint: "cli",
  tmux: "agendo:@29.%29",
  status: "idle",
};

describe("parseTmuxLocation", () => {
  test("reads the session name and pane id out of `session:@window.%pane`", () => {
    expect(parseTmuxLocation("agendo:@29.%29")).toEqual({ session: "agendo", pane: "%29" });
    // A session name may itself carry dashes and digits (`agendo-mc-applications`).
    expect(parseTmuxLocation("agendo-mc-applications:@5.%5")).toEqual({ session: "agendo-mc-applications", pane: "%5" });
  });

  test("anything else is no location", () => {
    expect(parseTmuxLocation("")).toBeUndefined();
    expect(parseTmuxLocation("agendo")).toBeUndefined();
    expect(parseTmuxLocation("agendo:1")).toBeUndefined();
    expect(parseTmuxLocation("%29")).toBeUndefined();
  });
});

describe("parseClaudeProcessRecord", () => {
  test("reads a full record back", () => {
    expect(parseClaudeProcessRecord(JSON.stringify(FULL), DIR)).toEqual({
      pid: 4242,
      sessionId: FULL.sessionId,
      cwd: "/home/dev/repo",
      tmux: { session: "agendo", pane: "%29" },
      configDir: DIR,
    });
  });

  test("a process outside tmux has no location, and is still a record", () => {
    const { tmux: _omitted, ...outside } = FULL;
    expect(parseClaudeProcessRecord(JSON.stringify(outside), DIR)?.tmux).toBeUndefined();
  });

  // A `claude -p` one-shot writes a record too, and can run in a pane; it is not
  // a session anyone attaches to, so adopting its window would manage nothing.
  test("a non-interactive process is not a record to act on", () => {
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, kind: "print" }), DIR)).toBeUndefined();
    const { kind: _omitted, ...unkinded } = FULL;
    expect(parseClaudeProcessRecord(JSON.stringify(unkinded), DIR)).toBeUndefined();
  });

  test("a malformed record degrades to nothing, never to a partial answer", () => {
    expect(parseClaudeProcessRecord("not json", DIR)).toBeUndefined();
    expect(parseClaudeProcessRecord("null", DIR)).toBeUndefined();
    expect(parseClaudeProcessRecord("[]", DIR)).toBeUndefined();
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, pid: "4242" }), DIR)).toBeUndefined();
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, pid: -1 }), DIR)).toBeUndefined();
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, sessionId: "" }), DIR)).toBeUndefined();
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, cwd: 7 }), DIR)).toBeUndefined();
  });

  test("an unparseable tmux field reads as outside tmux, not as some pane", () => {
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, tmux: "garbage" }), DIR)?.tmux).toBeUndefined();
    expect(parseClaudeProcessRecord(JSON.stringify({ ...FULL, tmux: 29 }), DIR)?.tmux).toBeUndefined();
  });
});

describe("pidAlive", () => {
  test("this process is alive; a pid past the kernel's range is not", () => {
    expect(pidAlive(process.pid)).toBe(true);
    // Linux pid_max caps at 2^22; nothing can hold this pid.
    expect(pidAlive(2 ** 30)).toBe(false);
  });
});
