import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectInitDest, rankParentDirs, repoNameError, resolveParentInput } from "../src/initRepo.ts";

// The pure half of the new-local-repo flow (docs/new-local-repo.md). The e2e
// suite drives the screens, but every fixture repo it has lives in ONE parent
// folder, so the ranking — the reason the candidate list exists — is exactly
// the thing a green e2e run says nothing about. It is pinned here instead.

describe("rankParentDirs — the candidate list", () => {
  test("dedupes parents and puts the one holding most checkouts first", () => {
    expect(rankParentDirs(["/h/git/a", "/h/git/b", "/h/work/c", "/h/git/d"])).toEqual(["/h/git", "/h/work"]);
  });

  test("breaks ties on the path, so the order is stable across reloads", () => {
    expect(rankParentDirs(["/h/work/c", "/h/git/a"])).toEqual(["/h/git", "/h/work"]);
    expect(rankParentDirs(["/h/git/a", "/h/work/c"])).toEqual(["/h/git", "/h/work"]);
  });

  test("the same checkout spelled two ways counts once", () => {
    // A recorded session cwd and a resolved CLI arg routinely differ this way.
    expect(rankParentDirs(["/h/git/a", "/h/git/a/", "/h/git/./a", "/h/work/b", "/h/work/c"])).toEqual([
      "/h/work",
      "/h/git",
    ]);
  });

  test("relative, empty and root inputs contribute nothing", () => {
    expect(rankParentDirs(["", "git/a", ".", "/"])).toEqual([]);
    // …and a checkout directly under the root has the root as its parent.
    expect(rankParentDirs(["/a"])).toEqual(["/"]);
  });

  test("no known repos → an empty list (first run)", () => {
    expect(rankParentDirs([])).toEqual([]);
  });
});

describe("resolveParentInput — the typed path", () => {
  const home = "/home/ada";

  test("expands ~ and ~/…", () => {
    expect(resolveParentInput("~", home)).toBe(home);
    expect(resolveParentInput("~/", home)).toBe(home);
    expect(resolveParentInput("~/git", home)).toBe("/home/ada/git");
    expect(resolveParentInput("  ~/git/  ", home)).toBe("/home/ada/git");
  });

  test("keeps an absolute path, normalized", () => {
    expect(resolveParentInput("/srv/repos/", home)).toBe("/srv/repos");
    expect(resolveParentInput("/srv//repos/../code", home)).toBe("/srv/code");
  });

  test("refuses anything relative or empty — it would resolve against a cwd the user can't see", () => {
    for (const s of ["", "   ", "git", "./git", "../git", "~ada/git", "$HOME/git"]) {
      expect(resolveParentInput(s, home), JSON.stringify(s)).toBeNull();
    }
  });
});

describe("repoNameError — the folder name", () => {
  test("accepts an ordinary folder name, including non-ASCII", () => {
    for (const n of ["my-project", "Þróun", "a.b", ".hidden", "with space", "-leading"]) {
      expect(repoNameError(n), n).toBeNull();
    }
  });

  test("refuses what cannot be a single folder name", () => {
    expect(repoNameError("")).toMatch(/name/);
    expect(repoNameError("   ")).toMatch(/name/);
    expect(repoNameError("a/b")).toMatch(/slash/);
    expect(repoNameError("/abs")).toMatch(/slash/);
    expect(repoNameError(".")).toMatch(/not a folder name/);
    expect(repoNameError("..")).toMatch(/not a folder name/);
  });
});

describe("inspectInitDest — what is already there", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agendo-init-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("nothing there → free", () => {
    expect(inspectInitDest(dir, "newthing")).toEqual({ dest: join(dir, "newthing"), state: "free", parent: "dir" });
  });

  test("an empty folder is usable; one with anything in it is not", () => {
    mkdirSync(join(dir, "empty"));
    expect(inspectInitDest(dir, "empty").state).toBe("empty");
    mkdirSync(join(dir, "busy"));
    writeFileSync(join(dir, "busy", "notes.txt"), "x");
    expect(inspectInitDest(dir, "busy").state).toBe("nonempty");
  });

  test("a folder carrying .git is a repo — whether .git is a directory or a worktree's file", () => {
    mkdirSync(join(dir, "main", ".git"), { recursive: true });
    expect(inspectInitDest(dir, "main").state).toBe("repo");
    mkdirSync(join(dir, "linked"));
    writeFileSync(join(dir, "linked", ".git"), "gitdir: /elsewhere\n");
    expect(inspectInitDest(dir, "linked").state).toBe("repo");
  });

  test("a file in the way, and a parent that is a file", () => {
    writeFileSync(join(dir, "afile"), "x");
    expect(inspectInitDest(dir, "afile").state).toBe("file");
    expect(inspectInitDest(join(dir, "afile"), "child").parent).toBe("file");
  });

  test("a parent that doesn't exist yet is reported, not refused", () => {
    const r = inspectInitDest(join(dir, "not", "yet"), "newthing");
    expect(r).toEqual({ dest: join(dir, "not", "yet", "newthing"), state: "free", parent: "missing" });
  });

  test("the name is trimmed and the parent normalized", () => {
    expect(inspectInitDest(`${dir}/`, "  newthing ").dest).toBe(join(dir, "newthing"));
  });
});
