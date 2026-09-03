// The head of a codex rollout (src/sessions/codex.ts): the session_meta line
// and the first user message after it. The e2e fixtures write one well-formed
// rollout per codex session, so a spec never sees a truncated last line, a
// meta with no git block, a timestamp that does not parse, a sub-agent thread
// in each of its three markings, or a fork that must stay listed. Those are
// here, one arm beside the next.
import { describe, expect, test } from "bun:test";
import { parseCodexHead, sessionMetaOf, skipsListing } from "../src/sessions/codex.ts";

const meta = (payload: Record<string, unknown>) => JSON.stringify({ type: "session_meta", payload });
const user = (text: string) =>
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const full = {
  id: "0195a1b2-0000-4000-8000-000000000001",
  cwd: "/w/repo",
  timestamp: "2026-09-01T10:00:00Z",
  git: { branch: "feat", repository_url: "https://github.com/o/r.git" },
};

describe("parseCodexHead", () => {
  test("a meta line then the first user message: everything, and the title cut at 120", () => {
    const long = "y".repeat(200);
    expect(parseCodexHead([meta(full), user(long), user("second")].join("\n"))).toEqual({
      id: full.id, cwd: "/w/repo", branch: "feat", repository: "o/r", createdAt: new Date("2026-09-01T10:00:00Z"), skip: false, title: "y".repeat(120),
    });
  });

  test("a head with no user message yet keeps the meta; a head with nothing usable is null", () => {
    expect(parseCodexHead(meta(full) + "\n")?.title).toBeUndefined();
    expect(parseCodexHead("")).toBeNull();
    expect(parseCodexHead('"just a string"\n[]\n{"type":"x"}\n{"type":"y","payload":3}')).toBeNull();
  });

  test("a truncated last line and blank lines are skipped, not fatal", () => {
    const head = ["", meta(full), "   ", user("hello there, please look at this"), '{"type":"response_item","payload":{"ty'].join("\n");
    expect(parseCodexHead(head)?.title).toBe("hello there, please look at this");
  });

  test("a sub-agent or exec thread returns at its meta line, marked to skip, without reading on", () => {
    const head = meta({ ...full, thread_source: "subagent" }) + "\n" + user("ignored");
    expect(parseCodexHead(head)).toMatchObject({ skip: true, id: full.id });
    expect(parseCodexHead(head)?.title).toBeUndefined();
  });
});

describe("sessionMetaOf", () => {
  test("anything not a string is absent; a bad timestamp is absent; no git block is no branch and no repository", () => {
    expect(sessionMetaOf({ id: 7, cwd: null, timestamp: "not a date" })).toEqual({
      id: undefined, cwd: undefined, branch: undefined, repository: undefined, createdAt: undefined, skip: false,
    });
    expect(sessionMetaOf({ ...full, git: { branch: "b", repository_url: "git@ssh.dev.azure.com:v3/org/proj/repo" } }).repository).toBe("repo");
    expect(sessionMetaOf({ ...full, git: { repository_url: 42 } })).toMatchObject({ branch: undefined, repository: undefined });
  });
});

describe("skipsListing", () => {
  test("thread_source, a {subagent} source, exec, or a parent thread skip; a fork and a plain thread do not", () => {
    expect(skipsListing({ thread_source: "subagent" })).toBe(true);
    expect(skipsListing({ source: { subagent: "review" } })).toBe(true);
    expect(skipsListing({ source: "exec" })).toBe(true);
    expect(skipsListing({ parent_thread_id: "abc" })).toBe(true);
    expect(skipsListing({ source: { subagent: null } })).toBe(false);
    expect(skipsListing({ forked_from_id: "abc", source: "cli" })).toBe(false);
    expect(skipsListing({})).toBe(false);
  });
});
