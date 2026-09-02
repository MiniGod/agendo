import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commonParent, globalOrchestratorCwd } from "../src/repos.ts";
import { roleLabel, repoOrchestrators, KIND_COL } from "../src/cli/orchestrators.ts";

// Pure path/label arithmetic behind the global orchestrator, unit-tested here
// because the e2e suite cannot reach the interesting inputs: every fixture repo
// lives under one mock home, so "roots that share nothing but /" and "exactly one
// repo, so the common parent IS that repo" never arise there — and those are the
// two cases where a wrong answer drops a session that must belong to NO repo into
// the middle of one.

describe("commonParent", () => {
  test("finds the deepest shared directory", () => {
    expect(commonParent(["/home/me/git/a", "/home/me/git/b"])).toBe("/home/me/git");
    // Nested repos: the shallower one IS the answer.
    expect(commonParent(["/home/me/git/a", "/home/me/git/a/vendor/b"])).toBe("/home/me/git/a");
  });

  test("a partial segment match is not a shared directory", () => {
    // `/home/me/git` and `/home/me/github` share the characters "git" but not the
    // segment; a character-wise prefix would answer "/home/me/git" and put the
    // orchestrator in a repo's own root.
    expect(commonParent(["/home/me/git", "/home/me/github"])).toBe("/home/me");
  });

  test("nothing in common, and nothing at all, are both null", () => {
    expect(commonParent(["/home/me/a", "/srv/b"])).toBeNull();
    expect(commonParent([])).toBeNull();
  });

  test("duplicate and trailing slashes don't create empty segments", () => {
    expect(commonParent(["/home/me/git/a/", "/home//me/git/b"])).toBe("/home/me/git");
  });
});

describe("globalOrchestratorCwd", () => {
  const FALLBACK = "/tmp/where-i-was";
  // A real checkout on disk, for the paths that ask the filesystem rather than
  // the caller's list of known roots — a fresh launcher has no roots to compare
  // against, so `.git` is the only evidence there is.
  let REPO_DIR = "";
  beforeAll(() => {
    REPO_DIR = mkdtempSync(join(tmpdir(), "agendo-globalcwd-"));
    mkdirSync(join(REPO_DIR, "a", ".git"), { recursive: true });
  });
  afterAll(() => rmSync(REPO_DIR, { recursive: true, force: true }));

  test("the launcher's scope root wins outright", () => {
    // It is literally the user's declared "everything I'm working on", so no
    // amount of repo arithmetic should second-guess it.
    expect(globalOrchestratorCwd(["/home/me/git/a"], FALLBACK, "/home/me/work")).toBe("/home/me/work");
  });

  test("a scope root that IS a repo root steps up like any other", () => {
    // Judged from the DISK, because a declared scope root gets no credit from the
    // caller's root list — see the contaminated-list case below for why.
    // `agendo ~/git/myrepo` declares a scope root that is a checkout. Honouring it
    // verbatim would park the global orchestrator inside a repo while its own
    // prompt tells it it is not in one — the same trap the single-repo case below
    // avoids, reached by the other route.
    expect(globalOrchestratorCwd([], FALLBACK, join(REPO_DIR, "a"))).toBe(REPO_DIR);
    // A trailing slash is the same directory, so it must not defeat the check.
    expect(globalOrchestratorCwd([], FALLBACK, `${join(REPO_DIR, "a")}/`)).toBe(REPO_DIR);
  });

  test("a scope root is NOT judged by the caller's repo-root list", () => {
    // The TUI seeds its scoped repo list with the scope root itself, so that the
    // user's declared directory can't fall off the picker (`ensureRepoAtTop`).
    // Trusting membership would then read every scoped launcher's root as a
    // checkout: `agendo ~/git` + `G` would coordinate from `~`, one level above
    // the directory the user pointed at.
    expect(
      globalOrchestratorCwd(["/home/me/git", "/home/me/git/a", "/home/me/git/b"], FALLBACK, "/home/me/git"),
    ).toBe("/home/me/git");
  });

  test("nested checkouts are walked all the way out", () => {
    // `$HOME` under chezmoi/yadm is a checkout, so one step out of a repo in it
    // lands in another repo — and "not inside a checkout" is the whole property.
    mkdirSync(join(REPO_DIR, "outer", "inner", ".git"), { recursive: true });
    mkdirSync(join(REPO_DIR, "outer", ".git"), { recursive: true });
    expect(globalOrchestratorCwd([], FALLBACK, join(REPO_DIR, "outer", "inner"))).toBe(REPO_DIR);
  });

  test("a scope root that holds repos is kept as-is", () => {
    expect(globalOrchestratorCwd(["/home/me/git/a", "/home/me/git/b"], FALLBACK, "/home/me/git")).toBe("/home/me/git");
  });

  test("several repos resolve to the directory holding them", () => {
    expect(globalOrchestratorCwd(["/home/me/git/a", "/home/me/git/b"], FALLBACK)).toBe("/home/me/git");
  });

  test("a single repo steps UP, so the session doesn't look like it lives there", () => {
    // Sitting in a repo root is what invites a global orchestrator to start
    // running git in it — the one thing its prompt forbids.
    expect(globalOrchestratorCwd(["/home/me/git/a"], FALLBACK)).toBe("/home/me/git");
  });

  test("degenerate inputs fall back to the caller's cwd", () => {
    expect(globalOrchestratorCwd([], FALLBACK)).toBe(FALLBACK);
    // Unrelated roots share only "/", which is no vantage point at all.
    expect(globalOrchestratorCwd(["/home/me/a", "/srv/b"], FALLBACK)).toBe(FALLBACK);
    // A repo checked out at the root's first level would step up to "/".
    expect(globalOrchestratorCwd(["/work"], FALLBACK)).toBe(FALLBACK);
  });

  test("the fallback is stepped out of a checkout too", () => {
    // The degenerate routes above are the ones most likely to be taken on a fresh
    // install — nothing indexed yet — and the cwd they fall back to is wherever
    // the user typed the command, which is most often a repo they were working
    // in. Exempting the fallback from the step-out would put the orchestrator in
    // a checkout by exactly the route that arises first.
    expect(globalOrchestratorCwd([], join(REPO_DIR, "a"))).toBe(REPO_DIR);
    expect(globalOrchestratorCwd(["/home/me/a", "/srv/b"], join(REPO_DIR, "a"))).toBe(REPO_DIR);
    // A known root needs no disk at all — the same test, without a checkout on it.
    expect(globalOrchestratorCwd(["/home/me/git/a", "/srv/b"], "/home/me/git/a")).toBe("/home/me/git");
  });

  test("a fallback that cannot be stepped out of is kept rather than answering /", () => {
    // Nowhere left to go: "/" is not a vantage point, and the checkout at least
    // exists. The prompt's "you are not in a repo" is weakened, never the cwd.
    expect(globalOrchestratorCwd(["/work"], "/work")).toBe("/work");
  });
});

describe("roleLabel", () => {
  test("the coordination role wins over how the session was launched", () => {
    // Every orchestrator is launched as a background session, so reading the kind
    // would report the coordinator of a repo as an ordinary `bg` row — exactly
    // what this column exists to prevent.
    expect(roleLabel("global", "background")).toBe("global");
    expect(roleLabel("repo", "background")).toBe("orch");
  });

  test("a session with no role falls back to its launch kind, then to a dash", () => {
    expect(roleLabel(null, "background")).toBe("bg");
    expect(roleLabel(null, null)).toBe("-");
  });

  test("the column is wide enough for the labels a reader scans for", () => {
    for (const label of [roleLabel("global", null), roleLabel("repo", null)]) {
      expect(label.length).toBeLessThanOrEqual(KIND_COL);
    }
  });
});

describe("repoOrchestrators", () => {
  const row = (shortId: string, cwd: string, role: "repo" | "global" | null) =>
    ({ shortId, cwd, role, running: true });

  test("worktrees fold back onto the repo they belong to", () => {
    // Otherwise every worktree would list as an unmanaged repo of its own, which
    // is the exact opposite of the question this answers. `/tmp` is used as a
    // stand-in root: it is not a checkout, so `repoRootForCwd` returns it as-is
    // for both rows and they group together.
    const out = repoOrchestrators([row("aaa", "/tmp", "repo"), row("bbb", "/tmp", null)]);
    expect(out).toHaveLength(1);
    expect(out[0].orchestrators).toEqual([{ shortId: "aaa", running: true }]);
  });

  test("the global orchestrator belongs to no repo and is left out", () => {
    // It coordinates repo orchestrators, not a checkout; folding it into whatever
    // directory it happens to sit in would report that repo as managed when it is
    // not.
    expect(repoOrchestrators([row("ggg", "/tmp", "global")])).toEqual([]);
  });

  test("a repo with no orchestrator is still reported — that IS the finding", () => {
    const out = repoOrchestrators([row("aaa", "/tmp", null)]);
    expect(out).toHaveLength(1);
    expect(out[0].orchestrators).toEqual([]);
  });

  test("an orchestrator that is not running keeps its running flag, not its row", () => {
    // "Remembered but idle" and "coordinating right now" are different answers —
    // the first means resume this one, the second means leave it alone — so the
    // flag has to survive the grouping rather than be collapsed into presence.
    const idle = { shortId: "aaa", cwd: "/tmp", role: "repo" as const, running: false };
    expect(repoOrchestrators([idle])[0].orchestrators).toEqual([{ shortId: "aaa", running: false }]);
  });
});
