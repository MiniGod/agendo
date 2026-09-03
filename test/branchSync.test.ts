// A checkout's branch against its remote (src/gitrefs.ts `branchSync`), on
// scratch git dirs. The e2e fixtures are real clones: every branch there has
// its own tracking ref, loose, at the local tip. They never show a worktree
// branch whose configured upstream is the base branch while `origin/<branch>`
// sits packed at the tip, a tip that differs from the only remote ref there
// is, no remote ref at all, a detached HEAD, or an unborn branch.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { branchSync, remoteCandidates } from "../src/gitrefs.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);

let root: string;
let n = 0;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agendo-branchsync-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** A fresh main checkout (the ref caches are per git dir, so each shape gets its own). */
function checkout(opts: { head?: string; refs?: Record<string, string>; packed?: string[]; config?: string }): string {
  const repo = join(root, `r${n++}`);
  const git = join(repo, ".git");
  mkdirSync(git, { recursive: true });
  writeFileSync(join(git, "HEAD"), opts.head ?? "ref: refs/heads/feat\n");
  for (const [ref, sha] of Object.entries(opts.refs ?? {})) {
    mkdirSync(dirname(join(git, ref)), { recursive: true });
    writeFileSync(join(git, ref), `${sha}\n`);
  }
  if (opts.packed) writeFileSync(join(git, "packed-refs"), `# pack-refs with: peeled fully-peeled sorted\n${opts.packed.join("\n")}\n`);
  if (opts.config) writeFileSync(join(git, "config"), opts.config);
  return repo;
}
const tracking = (branch: string, upstream = branch) => `[branch "${branch}"]\n\tremote = origin\n\tmerge = refs/heads/${upstream}\n`;

describe("remoteCandidates", () => {
  test("the configured upstream first, then origin/<branch> unless that is the upstream already", () => {
    expect(remoteCandidates("refs/remotes/origin/master", "feat")).toEqual(["refs/remotes/origin/master", "refs/remotes/origin/feat"]);
    expect(remoteCandidates("refs/remotes/origin/feat", "feat")).toEqual(["refs/remotes/origin/feat"]);
    expect(remoteCandidates(null, "feat")).toEqual(["refs/remotes/origin/feat"]);
  });
});

describe("branchSync", () => {
  test("a pushed branch: the local tip is its configured upstream", () => {
    const repo = checkout({ refs: { "refs/heads/feat": A, "refs/remotes/origin/feat": A }, config: tracking("feat") });
    expect(branchSync(repo)).toEqual({ branch: "feat", upstream: "origin/feat", upstreamConfigured: true, hasRemoteRef: true, unpushed: false });
  });

  test("a worktree branch tracking the base, pushed under its own name and packed away, reads as pushed", () => {
    const repo = checkout({
      refs: { "refs/heads/feat": A, "refs/remotes/origin/master": B },
      packed: [`${A} refs/remotes/origin/feat`],
      config: tracking("feat", "master"),
    });
    expect(branchSync(repo)).toEqual({ branch: "feat", upstream: "origin/feat", upstreamConfigured: false, hasRemoteRef: true, unpushed: false });
  });

  test("a tip that differs from the only remote ref there is, and one with no remote ref at all", () => {
    const behind = checkout({ refs: { "refs/heads/feat": A, "refs/remotes/origin/master": B }, config: tracking("feat", "master") });
    expect(branchSync(behind)).toEqual({ branch: "feat", upstream: "origin/master", upstreamConfigured: true, hasRemoteRef: true, unpushed: true });
    const alone = checkout({ refs: { "refs/heads/feat": A } });
    expect(branchSync(alone)).toEqual({ branch: "feat", upstream: "origin/feat", upstreamConfigured: false, hasRemoteRef: false, unpushed: true });
  });

  test("a detached HEAD, an unborn branch and a directory that is no checkout are unknown", () => {
    expect(branchSync(checkout({ head: `${A}\n`, refs: { "refs/heads/feat": A } }))).toBeNull();
    expect(branchSync(checkout({ head: "ref: refs/heads/new\n" }))).toBeNull();
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(branchSync(plain)).toBeNull();
  });
});
