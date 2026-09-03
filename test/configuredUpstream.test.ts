// Reading a branch's upstream out of the repo's config file (src/gitrefs.ts
// `configuredUpstream`), on scratch git dirs. The e2e fixtures' checkouts are
// made by a real `git clone`, so their config is always the plain
// `[branch "x"]\n\tremote = origin\n\tmerge = refs/heads/x` shape; they never
// carry a key on the header line, an upper-case section keyword, an escaped
// quote in the branch name, a local upstream (`remote = .`), a section missing
// one of the two keys, or a bare merge ref.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuredUpstream, trackingRef } from "../src/gitrefs.ts";

let root: string;
let n = 0;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agendo-upstream-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fresh common dir (the cache is per path, so each config gets its own) holding `config`. */
function commonDir(config: string): string {
  const dir = join(root, `g${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "config"), config);
  return dir;
}

describe("trackingRef", () => {
  test("names the remote-tracking ref, strips refs/heads/, and refuses incomplete or local pairs", () => {
    expect(trackingRef("origin", "refs/heads/feat")).toBe("refs/remotes/origin/feat");
    expect(trackingRef("up", "feat")).toBe("refs/remotes/up/feat");
    expect(trackingRef(".", "refs/heads/main")).toBeNull();
    expect(trackingRef("origin", undefined)).toBeNull();
    expect(trackingRef(undefined, "refs/heads/x")).toBeNull();
  });
});

describe("configuredUpstream", () => {
  test("the plain clone shape, and only the section for the branch asked about", () => {
    const dir = commonDir('[core]\n\tbare = false\n[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n[branch "feat"]\n\tremote = fork\n\tmerge = refs/heads/feat\n');
    expect(configuredUpstream(dir, "main")).toBe("refs/remotes/origin/main");
    expect(configuredUpstream(dir, "feat")).toBe("refs/remotes/fork/feat");
    expect(configuredUpstream(dir, "other")).toBeNull();
  });

  test("a key on the header line, an upper-case keyword, a comment and an escaped quote all parse", () => {
    const dir = commonDir('[BRANCH "we\\"ird"] remote = origin ; trailing\n\tmerge = "refs/heads/weird" # quoted\n');
    expect(configuredUpstream(dir, 'we"ird')).toBe("refs/remotes/origin/weird");
  });

  test("a local upstream, a section missing a key, and no config at all are null", () => {
    expect(configuredUpstream(commonDir('[branch "x"]\n\tremote = .\n\tmerge = refs/heads/y\n'), "x")).toBeNull();
    expect(configuredUpstream(commonDir('[branch "x"]\n\tremote = origin\n'), "x")).toBeNull();
    expect(configuredUpstream(join(root, "missing"), "x")).toBeNull();
  });

  test("the config is read once per common dir for the process", () => {
    const dir = commonDir('[branch "x"]\n\tremote = origin\n\tmerge = refs/heads/x\n');
    expect(configuredUpstream(dir, "x")).toBe("refs/remotes/origin/x");
    writeFileSync(join(dir, "config"), '[branch "x"]\n\tremote = other\n\tmerge = refs/heads/x\n');
    expect(configuredUpstream(dir, "x")).toBe("refs/remotes/origin/x");
  });
});
