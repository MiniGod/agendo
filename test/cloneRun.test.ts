// The clone runner against a stand-in `git` on PATH. The e2e suite clones real
// local remotes, so the success path is covered there; what it never reaches is
// the cancel path — soft, immediate, and soft-then-immediate on teardown — the
// failure classification of git's stderr, and a git that cannot be spawned.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startClone } from "../src/clone/run.ts";

// Writes a `.git` the way a real clone does (origin before refs), reports
// progress on stderr, then behaves per FAKE_GIT: exits 0, fails like a rejected
// SSH handshake, or hangs (as the process itself, so a signal ends it and closes
// the pipe — a shell child left behind would hold stderr open).
const FAKE_GIT = `#!/bin/sh
dest="$5"
mkdir -p "$dest/.git"
printf 'Cloning into %s...\\r 10%%\\r 42%% done\\n' "$dest" >&2
case "$FAKE_GIT" in
  ok) exit 0 ;;
  fail) printf 'git@github.com: Permission denied (publickey).\\nfatal: Could not read from remote repository.\\n' >&2; exit 128 ;;
esac
exec sleep 30
`;

let root: string;
let bin: string;
const savedPath = process.env.PATH;
const savedMode = process.env.FAKE_GIT;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agendo-clone-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "git"), FAKE_GIT);
  chmodSync(join(bin, "git"), 0o755);
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
});

afterAll(() => {
  process.env.PATH = savedPath;
  if (savedMode === undefined) delete process.env.FAKE_GIT;
  else process.env.FAKE_GIT = savedMode;
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function run(mode: string, opts: { preExisted?: boolean } = {}) {
  process.env.FAKE_GIT = mode;
  const dest = join(root, `dest-${n++}`);
  if (opts.preExisted) mkdirSync(dest);
  const progress: string[] = [];
  // Resolves once the stand-in has written `.git` — spawn is asynchronous, so a
  // cancel issued before this sees nothing on disk to clean up.
  let onStarted!: () => void;
  const started = new Promise<void>((r) => (onStarted = r));
  const clone = startClone("ssh://example.invalid/repo", dest, (l) => {
    progress.push(l);
    onStarted();
  });
  return { dest, progress, started, ...clone };
}

describe("startClone", () => {
  test("forwards the newest progress line and keeps a finished clone", async () => {
    const c = run("ok");
    expect(await c.done).toEqual({ ok: true });
    expect(c.progress).toEqual(["42% done"]);
    expect(existsSync(join(c.dest, ".git"))).toBe(true);
  });

  test("a failed clone is classified from git's own words and its directory removed", async () => {
    const c = run("fail");
    expect(await c.done).toEqual({ ok: false, failure: "auth", error: "git@github.com: Permission denied (publickey)." });
    expect(existsSync(c.dest)).toBe(false);
  });

  test("a directory that already existed is emptied, not removed", async () => {
    const c = run("fail", { preExisted: true });
    expect((await c.done).ok).toBe(false);
    expect(existsSync(c.dest)).toBe(true);
    expect(readdirSync(c.dest)).toEqual([]);
  });

  test("a soft cancel ends the clone, reports it, and cleans up once git has gone; a repeat is a no-op", async () => {
    const c = run("hang");
    c.cancel();
    c.cancel();
    expect(await c.done).toEqual({ ok: false, canceled: true, error: "cancelled" });
    expect(existsSync(c.dest)).toBe(false);
  });

  test("an immediate cancel kills hard and cleans up synchronously", async () => {
    const c = run("hang");
    await c.started;
    c.cancel({ immediate: true });
    expect(existsSync(c.dest)).toBe(false);
    expect((await c.done).canceled).toBe(true);
  });

  test("an immediate cancel after a soft one still escalates", async () => {
    const c = run("hang");
    await c.started;
    c.cancel();
    expect(existsSync(c.dest)).toBe(true); // git has not answered SIGTERM yet
    c.cancel({ immediate: true });
    expect(existsSync(c.dest)).toBe(false);
    expect((await c.done).canceled).toBe(true);
  });

  test("a cancel after git has already exited does not throw", async () => {
    const c = run("ok");
    await c.done;
    expect(() => c.cancel({ immediate: true })).not.toThrow();
  });

  test("a git that cannot be run is a failure, not a hang", async () => {
    const path = process.env.PATH;
    process.env.PATH = join(root, "nowhere");
    try {
      const c = run("ok");
      const out = await c.done;
      expect(out.ok).toBe(false);
      expect(out.failure).toBe("other");
      expect(out.error).toStartWith("could not run git:");
      expect(existsSync(c.dest)).toBe(false);
    } finally {
      process.env.PATH = path;
    }
  });
});
