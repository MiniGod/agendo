// Which of two entries for one session id survives the index (src/sessions.ts).
// The e2e fixtures never hold the same transcript under two profiles, so the
// collision path is entered by no spec at all; the symlink it exists for is
// made here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownsLogPath, preferredDuplicate } from "../src/sessions.ts";
import type { AgentSession } from "../src/types.ts";

let dir = "";
let owned = "";
let linked = "";
beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agendo-dup-")));
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));
  owned = join(dir, "a", "s.jsonl");
  linked = join(dir, "b", "s.jsonl");
  writeFileSync(owned, "");
  symlinkSync(owned, linked);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const session = (logPath: string | undefined, lastUsed: number): AgentSession => ({
  id: "s", source: "claude", cwd: dir, title: "s", lastUsed: new Date(lastUsed), logPath,
});

describe("ownsLogPath", () => {
  test("true for the real file, false through a symlink, for a missing file, and with no path", async () => {
    expect(await ownsLogPath(session(owned, 1))).toBe(true);
    expect(await ownsLogPath(session(linked, 1))).toBe(false);
    expect(await ownsLogPath(session(join(dir, "nope.jsonl"), 1))).toBe(false);
    expect(await ownsLogPath(session(undefined, 1))).toBe(false);
  });
});

describe("preferredDuplicate", () => {
  test("the owner wins from either side, however old; otherwise the most recently used, the first on a tie", async () => {
    const oldOwner = session(owned, 1);
    const newAlias = session(linked, 9);
    expect(await preferredDuplicate(oldOwner, newAlias)).toBe(oldOwner);
    expect(await preferredDuplicate(newAlias, oldOwner)).toBe(oldOwner);
    const a = session(linked, 1);
    const b = session(linked, 2);
    expect(await preferredDuplicate(a, b)).toBe(b);
    expect(await preferredDuplicate(b, a)).toBe(b);
    const tie = session(linked, 2);
    expect(await preferredDuplicate(b, tie)).toBe(b);
    const ownerA = session(owned, 1);
    const ownerB = session(owned, 5);
    expect(await preferredDuplicate(ownerA, ownerB)).toBe(ownerB);
  });
});
