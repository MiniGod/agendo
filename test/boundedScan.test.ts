// The session index's bounded reads (src/shared/lines.ts, src/shared/pool.ts,
// and the streamed scans in src/sessions/claude.ts and codex.ts). Every e2e
// fixture transcript is a few hundred bytes, so a spec never sees a line that
// spans two reads, a multi-byte character cut by a read, a field that sits
// megabytes into a transcript, a codex head cut mid-line, or more transcripts
// than the pool admits at once. Each of those is here.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachLine } from "../src/shared/lines.ts";
import { forEachPooled, INDEX_CONCURRENCY } from "../src/shared/pool.ts";
import { parseClaudeMeta, scanClaudeMeta } from "../src/sessions/claude.ts";
import { parseCodexHead, readCodexHead } from "../src/sessions/codex.ts";
import { resetTranscriptWarnings, takeWarnings } from "../src/shared/errors.ts";

const dir = mkdtempSync(join(tmpdir(), "agendo-bounded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
function file(content: string | Buffer): string {
  const p = join(dir, `f${n++}.jsonl`);
  writeFileSync(p, content);
  return p;
}

async function collect(path: string, opts?: Parameters<typeof forEachLine>[2]) {
  const out: [string, number, boolean][] = [];
  const read = await forEachLine(path, (t, i, last) => void out.push([t, i, last]), opts);
  return { out, read };
}

/** What `split("\n")` delivers, minus the blank trailing "" a terminated file ends in. */
function splitLike(text: string): [string, number, boolean][] {
  const parts = text.split("\n");
  const out = parts.map((t, i): [string, number, boolean] => [t, i + 1, i === parts.length - 1]);
  return parts.at(-1) === "" ? out.slice(0, -1) : out;
}

describe("forEachLine", () => {
  const cases: Record<string, string> = {
    "terminated": "a\nbb\n\nccc\n",
    "unterminated": "a\nbb\nccc",
    "empty": "",
    "only newlines": "\n\n",
    "CRLF": "a\r\nb\r\n",
    "multi-byte everywhere": "þú ert\n😀😀😀😀\nŒuvre — ok\nend",
  };
  for (const [name, text] of Object.entries(cases)) {
    test(`matches split("\\n") at every read size: ${name}`, async () => {
      const p = file(text);
      // Chunk sizes of 1–7 bytes put every line boundary and every multi-byte
      // sequence across a read boundary at some point.
      for (const chunkBytes of [1, 2, 3, 5, 7, 1024]) {
        const { out, read } = await collect(p, { chunkBytes });
        expect(out).toEqual(splitLike(text));
        expect(read).toBe(Buffer.byteLength(text));
      }
    });
  }

  test("maxBytes yields exactly the split of the head decoded whole, cut tail included", async () => {
    const text = "first\nsecond 😀 line\nthird";
    const bytes = Buffer.from(text);
    const p = file(bytes);
    for (let max = 1; max <= bytes.length; max++) {
      const { out, read } = await collect(p, { maxBytes: max, chunkBytes: 4 });
      expect(out).toEqual(splitLike(bytes.subarray(0, max).toString("utf-8")));
      expect(read).toBe(max);
    }
  });

  test("a sink returning true stops the read", async () => {
    const p = file("a\nb\nc\nd\n");
    const seen: string[] = [];
    await forEachLine(p, (t) => (seen.push(t), t === "b"), { chunkBytes: 1 });
    expect(seen).toEqual(["a", "b"]);
  });

  test("a missing file is null, not an empty read", async () => {
    expect(await forEachLine(join(dir, "nope.jsonl"), () => {})).toBeNull();
  });
});

describe("parseClaudeMeta, streamed", () => {
  beforeEach(() => {
    takeWarnings();
    resetTranscriptWarnings();
  });

  // ~2 MB of padding records between the regions, so every field below sits in
  // a different 256 KB read: the firsts at the head, an ai-title and a workflow
  // launch in the middle, and the rename, the feature branch and the
  // notification at the tail.
  const pad = (k: number) => Array.from({ length: k }, (_, i) => JSON.stringify({ type: "assistant", gitBranch: "master", message: { content: "x".repeat(20_000 + i) } }));
  const rec = (r: Record<string, unknown>) => JSON.stringify(r);
  const transcript = [
    rec({ timestamp: "garbage" }),
    rec({ cwd: "/w/repo", timestamp: "2026-09-01T10:00:00Z", gitBranch: "master" }),
    ...pad(50),
    rec({ type: "ai-title", aiTitle: "Early summary" }),
    rec({ toolUseResult: { taskType: "local_workflow", runId: "wf_1", taskId: "t1", workflowName: "review" }, timestamp: "2026-09-01T11:00:00Z" }),
    "{not json",
    ...pad(50),
    rec({ type: "custom-title", customTitle: "Renamed late" }),
    rec({ gitBranch: "feat/late", cwd: "/elsewhere" }),
    rec({ content: "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n</task-notification>" }),
    rec({ gitBranch: "main" }),
    '{"half-written',
  ].join("\n");

  test("finds every field wherever it sits, and agrees with the in-memory scan", async () => {
    const p = file(transcript);
    expect(Buffer.byteLength(transcript)).toBeGreaterThan(4 * 256 * 1024);
    const streamed = await parseClaudeMeta(p);
    const streamedWarnings = takeWarnings();
    resetTranscriptWarnings();
    const whole = scanClaudeMeta(readFileSync(p, "utf-8"), p);
    expect(streamed).toEqual(whole);
    expect(streamedWarnings).toEqual(takeWarnings());
    expect(streamed).toMatchObject({
      cwd: "/w/repo",
      createdAt: new Date("2026-09-01T10:00:00Z"),
      branch: "feat/late",
      title: "Renamed late",
      workflows: [{ runId: "wf_1", taskId: "t1", notifiedStatus: "completed" }],
    });
    // The broken middle line warns, by its line number; the unterminated last does not.
    expect(streamedWarnings).toHaveLength(1);
    expect(streamedWarnings[0]).toContain(`${p}:55`);
  });

  test("an unreadable transcript is null", async () => {
    expect(await parseClaudeMeta(join(dir, "gone.jsonl"))).toBeNull();
  });
});

describe("readCodexHead", () => {
  const meta = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "session_meta", payload: { id: "0195a1b2-0000-4000-8000-000000000001", cwd: "/w/repo", timestamp: "2026-09-01T10:00:00Z", ...extra } });
  const user = (text: string) => JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });

  test("a title past the first read, but inside the head, is found", async () => {
    const head = [meta({ base_instructions: "i".repeat(150_000) }), user("the real ask")].join("\n");
    const p = file(head + "\n" + user("later"));
    expect(await readCodexHead(p)).toEqual(parseCodexHead(head));
    expect((await readCodexHead(p))?.title).toBe("the real ask");
  });

  test("nothing past CODEX_HEAD_BYTES is read: a title beyond it stays unknown, exactly as the cut head says", async () => {
    const content = [meta(), user("x".repeat(300_000)), user("too late")].join("\n");
    const p = file(content);
    const got = await readCodexHead(p);
    expect(got).toEqual(parseCodexHead(Buffer.from(content).subarray(0, 256 * 1024).toString("utf-8")));
    expect(got?.cwd).toBe("/w/repo");
    expect(got?.title).toBeUndefined();
  });

  test("an empty or missing rollout is undefined (uncached), a non-session is null", async () => {
    expect(await readCodexHead(file(""))).toBeUndefined();
    expect(await readCodexHead(join(dir, "nope.jsonl"))).toBeUndefined();
    expect(await readCodexHead(file('{"type":"x"}\n'))).toBeNull();
  });
});

describe("forEachPooled", () => {
  test("never runs more than the limit at once, and runs every item", async () => {
    let inFlight = 0;
    let peak = 0;
    const done: number[] = [];
    const items = Array.from({ length: 50 }, (_, i) => i);
    await forEachPooled(items, 4, async (i) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, i % 3));
      inFlight--;
      done.push(i);
    });
    expect(peak).toBe(4);
    expect(done.sort((a, b) => a - b)).toEqual(items);
  });

  test("no items, and fewer items than the limit", async () => {
    await forEachPooled([], 8, async () => {
      throw new Error("never called");
    });
    const seen: number[] = [];
    await forEachPooled([1, 2], 8, async (i) => void seen.push(i));
    expect(seen.sort()).toEqual([1, 2]);
  });

  test("a rejection rejects the run, and stops further items being started", async () => {
    const started: number[] = [];
    const run = forEachPooled([0, 1, 2, 3, 4, 5], 1, async (i) => {
      started.push(i);
      if (i === 1) throw new Error("boom");
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
  });

  test("the index's bound is a small pool, not the size of the store", () => {
    expect(INDEX_CONCURRENCY).toBeGreaterThanOrEqual(1);
    expect(INDEX_CONCURRENCY).toBeLessThanOrEqual(16);
  });
});

describe("forEachLine past the collection budget", () => {
  test("reading more than 32 MB, which forces collections along the way, still delivers every line", async () => {
    const line = "z".repeat(1023);
    const count = 34 * 1024; // 34 MB of 1 KB lines
    const p = file(`${line}\n`.repeat(count));
    let seen = 0;
    let ok = true;
    const read = await forEachLine(p, (t) => {
      seen++;
      if (t !== line) ok = false;
    });
    expect(read).toBe(count * 1024);
    expect(seen).toBe(count);
    expect(ok).toBe(true);
  });

  test("a sink that throws is not mistaken for an unreadable file", async () => {
    const p = file("a\nb\n");
    await expect(forEachLine(p, () => {
      throw new Error("sink");
    })).rejects.toThrow("sink");
  });
});
