import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { messageOf, parseJsonLine, resetTranscriptWarnings, takeWarnings } from "../src/errors.ts";

// Torn-append recovery is a pure helper on a string, and the e2e suite cannot
// reach it: driving it there would mean a fixture transcript that is corrupt in
// one exact way, read at one exact moment, to prove a record the UI then shows
// no differently from any other. What is worth pinning is the boundary rule
// itself — which record comes back, which lines stay silent, and above all
// which lines must NOT be declared recovered — and that is this file.
//
// `torn-append.jsonl` is a sterilized cut of the specimen this was written for:
// a real transcript line, 4,758 bytes, holding a record truncated mid-signature
// with a complete record appended straight onto its stump. Every uuid, request
// id, path and branch name is synthetic and the signature blobs are visible
// filler; the structure, the tear offset and the failure mode are the
// original's. The lines around it are the other cases a walk over a live
// transcript hits.
const FIXTURE = readFileSync(join(import.meta.dir, "fixtures", "torn-append.jsonl"), "utf-8").split("\n");

const [CLEAN, TORN, , TRUNCATED] = FIXTURE;
/** The complete record riding on the back of the truncated one in TORN. */
const TORN_TAIL_UUID = "c5f2b724-5e88-68a4-cef3-7be712605cb6";
/** The truncated record TORN opens with — recovering THIS would be the bug. */
const TORN_HEAD_UUID = "a82013e1-9845-1c4e-9a1e-0a30b5ba446a";

// Both halves of the diagnostic state are module-global: the warning list, which
// drains, and the set of already-warned paths, which by design does not. A test
// that inherited either would assert nothing rather than fail — so both are
// cleared here, and the suite stays honest under `bun test --rerun-each`, where
// this file is re-imported but src/errors.ts is not.
beforeEach(() => {
  takeWarnings();
  resetTranscriptWarnings();
});

describe("parseJsonLine — intact lines", () => {
  test("parses a clean record without warning", () => {
    const e = parseJsonLine(CLEAN, "/t/clean.jsonl", 1);
    expect(e?.uuid).toBe("11111111-1111-4111-8111-111111111111");
    expect(takeWarnings()).toEqual([]);
  });

  test("leaves a record holding brace sequences in its strings alone", () => {
    // `}{` and `{"` both occur inside legitimate string values. Nothing may
    // treat them as structure — this line is valid and must come back whole.
    const line = JSON.stringify({ type: "user", note: 'a }{ b {"k":1} c', uuid: "u1" });
    const e = parseJsonLine(line, "/t/braces.jsonl", 1);
    expect(e.note).toBe('a }{ b {"k":1} c');
    expect(takeWarnings()).toEqual([]);
  });
});

describe("parseJsonLine — torn appends", () => {
  test("recovers the complete record from the specimen's torn line", () => {
    const e = parseJsonLine(TORN, "/t/specimen.jsonl", 11);
    expect(e).not.toBeNull();
    expect(e.uuid).toBe(TORN_TAIL_UUID);
    expect(e.type).toBe("assistant");
    expect(e.timestamp).toBe("2026-08-07T10:13:07.425Z");
    // Not the stump it was stuck to, and not some fragment of it.
    expect(e.uuid).not.toBe(TORN_HEAD_UUID);
    expect(e.gitBranch).toBe("worktree-demo");
  });

  test("recovering is silent — nothing was lost, so there is nothing to report", () => {
    parseJsonLine(TORN, "/t/silent.jsonl", 11);
    expect(takeWarnings()).toEqual([]);
  });

  test("finds the boundary with no `}` in front of it", () => {
    // The specimen's stump ends mid-base64, so the join is `…NOT4{"parentUuid"`.
    // Splitting on `}{` would find nothing here; this is why the rule is
    // try-and-verify rather than match.
    const boundary = TORN.indexOf('{"parentUuid"', 1);
    expect(boundary).toBeGreaterThan(0);
    expect(TORN[boundary - 1]).not.toBe("}");
  });

  test("recovers the last record when several torn writes precede it", () => {
    const whole = JSON.stringify({ type: "assistant", uuid: "survivor" });
    const stump1 = '{"type":"assistant","uuid":"lost-1","text":"cut off here';
    const stump2 = '{"type":"assistant","uuid":"lost-2","text":"and here';
    const e = parseJsonLine(stump1 + stump2 + whole, "/t/multi.jsonl", 3);
    expect(e.uuid).toBe("survivor");
  });

  test("recovers records that do not start on `parentUuid`", () => {
    // Claude transcripts alone lead with `parentUuid` or `type`, and copilot's
    // events.jsonl and a workflow journal are different shapes again. A rule
    // anchored on one known first key would be wrong for most of them.
    const shapes = [
      { agentId: "a1", type: "result" }, // workflows.ts journal.jsonl
      { type: "user.message", data: { content: "hi" } }, // copilot events.jsonl
      { timestamp: "2026-08-07T10:00:00Z", type: "response_item" }, // codex shape
    ];
    for (const shape of shapes) {
      const e = parseJsonLine(`{"cut":"off${JSON.stringify(shape)}`, "/t/shape.jsonl", 1);
      expect(e).toEqual(shape);
    }
  });

  test("rejects a candidate boundary that sits inside a string", () => {
    // The stump's surviving text contains `{"` inside a quoted value. It is a
    // candidate by shape and a non-boundary in fact, and only trying it tells
    // them apart — so the record that comes back is still the real one.
    const whole = JSON.stringify({ type: "assistant", uuid: "survivor" });
    const stump = '{"type":"assistant","note":"see {\\"k\\":1} and {\\"j\\":2} below';
    const e = parseJsonLine(stump + whole, "/t/instring.jsonl", 1);
    expect(e.uuid).toBe("survivor");
  });
});

// The failure mode the first cut of this function had. A record cut just after
// one of its own nested objects closes leaves that object as the rightmost
// thing on the line, where it parses perfectly — so try-parse alone declares a
// mangled line "recovered", hands the reader a non-record, and suppresses the
// diagnostic that would have named the damage. Every case here parsed to
// something before the value-position filter was added.
describe("parseJsonLine — a nested object is not a record", () => {
  test("a record truncated after a nested object closes is NOT recovered", () => {
    const path = "/t/nested.jsonl";
    const line = '{"type":"assistant","uuid":"u1","usage":{"web_search_requests":0}';
    const e = parseJsonLine(line, path, 7);
    expect(e).toBeNull();
    expect(takeWarnings()[0]).toContain(`${path}:7`);
  });

  test("the same cut taken out of the real fixture record", () => {
    // Cut immediately after `server_tool_use`'s nested object closes.
    const at = CLEAN.indexOf("}", CLEAN.indexOf('"server_tool_use":{')) + 1;
    expect(at).toBeGreaterThan(0);
    const e = parseJsonLine(CLEAN.slice(0, at), "/t/fixturecut.jsonl", 3);
    expect(e).toBeNull();
  });

  test("a complete record followed by a truncated one warns rather than yielding a fragment", () => {
    const path = "/t/completethentorn.jsonl";
    const a = JSON.stringify({ type: "assistant", uuid: "complete-A", gitBranch: "feature-x" });
    const b = '{"type":"assistant","uuid":"partial-B","message":{"in":1}';
    const e = parseJsonLine(a + b, path, 9);
    expect(e).toBeNull();
    expect(takeWarnings()).toHaveLength(1);
  });

  test("an array element is not a record boundary either", () => {
    // First element: the candidate follows `[`.
    const line = '{"type":"assistant","content":[{"type":"text","text":"hi"}';
    const e = parseJsonLine(line, "/t/array.jsonl", 2);
    expect(e).toBeNull();
  });

  test("nor is a LATER array element, which follows a comma", () => {
    // The `,` arm of the filter, which nothing else here reaches: cut so the
    // second element is the rightmost parseable thing on the line. Without that
    // arm this returns {"type":"tool_use","name":"Bash"} — a non-record — and
    // says nothing about it.
    const path = "/t/array2.jsonl";
    const line =
      '{"type":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","name":"Bash"}';
    const e = parseJsonLine(line, path, 2);
    expect(e).toBeNull();
    expect(takeWarnings()[0]).toContain(`${path}:2`);
  });
});

describe("parseJsonLine — what stays broken, and what it says", () => {
  test("a truncated final line is dropped silently", () => {
    // A live agent mid-append always has one. Normal, not corruption.
    const e = parseJsonLine(TRUNCATED, "/t/live.jsonl", FIXTURE.length, { isLast: true });
    expect(e).toBeNull();
    expect(takeWarnings()).toEqual([]);
  });

  test("an unrecoverable line mid-file still warns, naming path and line", () => {
    const path = "/t/broken.jsonl";
    const e = parseJsonLine(TRUNCATED, path, 4);
    expect(e).toBeNull();
    const [w, ...rest] = takeWarnings();
    expect(rest).toEqual([]);
    expect(w).toContain(`${path}:4`);
    expect(w).toContain("Skipped unparseable JSON");
  });

  test("garbage that is not JSON at all warns rather than recovering something", () => {
    const e = parseJsonLine('not json {"nor":"this', "/t/garbage.jsonl", 2);
    expect(e).toBeNull();
    expect(takeWarnings()).toHaveLength(1);
  });

  test("but garbage in FRONT of an intact record hands back the record, quietly", () => {
    // Accepted by design, and worth pinning because it is a real behaviour
    // change: nothing distinguishes a severed write from any other unparseable
    // prefix, so this reads as a torn append. The intact record is worth more
    // than a diagnostic about the noise ahead of it.
    const e = parseJsonLine('SEGFAULT at 0x41 {"type":"assistant","uuid":"x"}', "/t/prefix.jsonl", 3);
    expect(e?.uuid).toBe("x");
    expect(takeWarnings()).toEqual([]);
  });

  test("a line of nothing but torn stumps gives up instead of guessing", () => {
    // 250 join-shaped candidates, none of which parses. Every one of them is
    // tried — there is no attempt cap — and the answer is still "no" rather
    // than a guess.
    const path = "/t/stumps.jsonl";
    const e = parseJsonLine('{"type":"assistant","text":"cut here'.repeat(250), path, 5);
    expect(e).toBeNull();
    expect(takeWarnings()).toHaveLength(1);
  });

  test("at most one warning per file, however many lines are bad", () => {
    const path = "/t/capped.jsonl";
    for (const line of [4, 5, 6, 7]) expect(parseJsonLine(TRUNCATED, path, line)).toBeNull();
    const warned = takeWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(`${path}:4`);
  });

  test("the cap is per file, so a second file still reports", () => {
    parseJsonLine(TRUNCATED, "/t/capA.jsonl", 1);
    parseJsonLine(TRUNCATED, "/t/capB.jsonl", 1);
    expect(takeWarnings()).toHaveLength(2);
  });
});

describe("parseJsonLine — recovery has no attempt ceiling", () => {
  test("recovers past 200 filter-surviving candidates inside the tail record", () => {
    // Not every in-tail candidate is filtered out: a string value ENDING in `{`
    // — a line of code in a tool result — is followed by its own closing quote,
    // so `{"` matches and the preceding char is not `:`/`,`/`[`. They sit to the
    // RIGHT of the true boundary, and the walk goes right-to-left, so an attempt
    // cap would spend itself on them and discard the record it was looking for.
    // At the old cap of 200 this returned null from 201 candidates onward.
    const content = Array.from({ length: 400 }, (_, i) => ({ type: "text", text: `function f${i}() {` }));
    const tail = JSON.stringify({ type: "user", uuid: "TAIL", message: { content } });
    const e = parseJsonLine('{"type":"assistant","signature":"AAAABBBB' + tail, "/t/nocap.jsonl", 4);
    expect(e?.uuid).toBe("TAIL");
    expect(takeWarnings()).toEqual([]);
  });
});

describe("a walk over the fixture, as a reader does it", () => {
  test("keeps every intact record and reports once", () => {
    const path = "/t/walk.jsonl";
    const kept: string[] = [];
    for (let i = 0; i < FIXTURE.length; i++) {
      const e = parseJsonLine(FIXTURE[i], path, i + 1, { isLast: i === FIXTURE.length - 1 });
      if (e && typeof e === "object") kept.push(e.uuid);
    }
    // Two clean records plus the one salvaged from the torn line. Before
    // recovery the middle entry was lost with the stump it was stuck to.
    expect(kept).toEqual([
      "11111111-1111-4111-8111-111111111111",
      TORN_TAIL_UUID,
      "22222222-2222-4222-8222-222222222222",
    ]);
    // Lines 4 and 5 are unrecoverable, line 6 is the live trailing write.
    expect(takeWarnings()).toHaveLength(1);
  });
});

// `messageOf` is what every error site prints; the e2e suite only ever hands it
// real Errors, so the shapes it exists for — a thrown string, a thrown object,
// one JSON cannot serialise — never reach it there.
describe("messageOf", () => {
  test("an Error's message, a string as itself, anything else as JSON", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
    expect(messageOf("plain")).toBe("plain");
    expect(messageOf({ code: 7 })).toBe('{"code":7}');
    expect(messageOf(null)).toBe("null");
  });

  test("what JSON cannot say falls back to String(): undefined, a cycle, a bigint", () => {
    expect(messageOf(undefined)).toBe("undefined");
    const loop: { self?: unknown } = {};
    loop.self = loop;
    expect(messageOf(loop)).toBe("[object Object]");
    expect(messageOf(10n)).toBe("10");
  });
});
