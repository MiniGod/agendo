// Unit coverage for cloning a repo the user doesn't have on disk (docs/cloning.md).
// Browser-free and git-free: everything here is either pure string work or real
// temp directories, so the whole "what does this URL mean, and where would it
// land" decision is pinned without a network or a git binary in sight.
//
// URL inference is the part worth pinning hardest. It's the surface a user pastes
// arbitrary text into, it decides what gets handed to `git clone`, and Azure
// DevOps in particular has four different shapes for the same repo. A regression
// here is either "agendo can't clone the thing I pasted" or — much worse — "agendo
// cloned something else".
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRepoUrl,
  repoUrlLabel,
  cloneDirName,
  enclosingCheckout,
  findMatchingCheckout,
  freeCloneDest,
} from "../src/clone.ts";

// Just the identity, for the cases where the remote isn't what's under test.
const key = (url: string) => parseRepoUrl(url)?.key ?? null;

test.describe("parseRepoUrl: GitHub", () => {
  test("clone URLs — HTTPS and SSH, with and without .git / trailing slash", () => {
    for (const u of [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo.git",
      "https://github.com/owner/repo/",
      "git@github.com:owner/repo.git",
      "ssh://git@github.com/owner/repo.git",
    ]) {
      expect(key(u), u).toBe("github:owner/repo");
    }
  });

  test("web URLs — the trailing path a user actually has in their clipboard", () => {
    // A repo page is rarely what gets copied; a file at a branch or a PR is.
    for (const u of [
      "https://github.com/owner/repo/tree/main",
      "https://github.com/owner/repo/tree/main/src/deep/file.ts",
      "https://github.com/owner/repo/pull/12",
      "https://github.com/owner/repo/blob/abc123/README.md",
      "https://github.com/owner/repo/issues",
    ]) {
      expect(key(u), u).toBe("github:owner/repo");
    }
  });

  test("REGRESSION: SSH-over-HTTPS with a port — owner is the org, not the port", () => {
    expect(key("ssh://git@ssh.github.com:443/owner/repo")).toBe("github:owner/repo");
    expect(key("https://github.com:443/owner/repo.git")).toBe("github:owner/repo");
  });

  test("the scheme family is preserved, but the URL is canonicalized", () => {
    // A web URL is not a clone URL, so the remote is rebuilt — while staying on
    // the transport the user pasted, since that's the credential path they have.
    expect(parseRepoUrl("https://github.com/owner/repo/tree/main")?.remote)
      .toBe("https://github.com/owner/repo.git");
    expect(parseRepoUrl("git@github.com:owner/repo.git")?.remote)
      .toBe("git@github.com:owner/repo.git");
    expect(parseRepoUrl("ssh://git@github.com/owner/repo.git")?.remote)
      .toBe("git@github.com:owner/repo.git");
  });

  test("an alternate SSH host/port survives — it's why that URL was pasted", () => {
    // `ssh.github.com:443` is what you use when your network blocks port 22.
    // Canonicalizing it to `git@github.com:` would hang until TCP timed out.
    // It needs the explicit ssh:// form — the scp-like form can't carry a port.
    expect(parseRepoUrl("ssh://git@ssh.github.com:443/owner/repo")?.remote)
      .toBe("ssh://git@ssh.github.com:443/owner/repo.git");
  });

  test("pasted HTTPS credentials survive, exactly as they do for Azure DevOps", () => {
    // Someone with no credential helper configured pasted a token URL because
    // it's the only form that works for them; rebuilding it away turns a URL
    // that clones in their shell into one that fails in agendo.
    const u = parseRepoUrl("https://x-access-token:ghp_SECRET@github.com/acme/private.git")!;
    expect(u.remote).toBe("https://x-access-token:ghp_SECRET@github.com/acme/private.git");
    expect(u.displayRemote).toBe("https://x-access-token:***@github.com/acme/private.git");
    // A bare token in the username position is masked whole — there's no
    // username convention on github.com that would vouch for it.
    expect(parseRepoUrl("https://ghp_SECRET@github.com/acme/private")?.displayRemote)
      .toBe("https://***@github.com/acme/private.git");
  });

  test("look-alike hosts are rejected, not silently mis-parsed", () => {
    expect(parseRepoUrl("https://mygithub.com/owner/repo")).toBeNull();
    expect(parseRepoUrl("https://github.com.evil.org/owner/repo")).toBeNull();
    expect(parseRepoUrl("git@gitlab.com:owner/repo.git")).toBeNull();
  });

  test("an owner with no repo is not a repo URL", () => {
    expect(parseRepoUrl("https://github.com/owner")).toBeNull();
    expect(parseRepoUrl("https://github.com/")).toBeNull();
  });

  test("github.com SITE pages are not repos, however much they look like owner/repo", () => {
    // These parse structurally (two path segments on the right host) but are
    // reserved GitHub routes. Accepting them means the user is told "repository
    // not found" for a URL that was never a repository.
    for (const u of [
      "https://github.com/orgs/anthropics/repositories",
      "https://github.com/features/copilot",
      "https://github.com/settings/profile",
      "https://github.com/marketplace/actions/checkout",
      "https://github.com/search?q=agendo",
      "https://github.com/topics/typescript",
      "https://github.com/sponsors/someone",
    ]) {
      expect(parseRepoUrl(u), u).toBeNull();
    }
  });
});

test.describe("parseRepoUrl: Azure DevOps", () => {
  test("dev.azure.com — web, clone (with userinfo), and deep web paths", () => {
    for (const u of [
      "https://dev.azure.com/org/proj/_git/repo",
      "https://dev.azure.com/org/proj/_git/repo/",
      "https://dev.azure.com/org/proj/_git/repo.git",
      "https://org@dev.azure.com/org/proj/_git/repo", // the "Clone" button's URL
      "https://dev.azure.com/org/proj/_git/repo?path=/src/x.ts&version=GBmain",
      "https://dev.azure.com/org/proj/_git/repo/pullrequest/42",
      "https://dev.azure.com/org/proj/_git/repo/commit/abc123",
    ]) {
      expect(key(u), u).toBe("ado:org/proj/repo");
    }
  });

  test("the legacy visualstudio.com host, with and without a collection segment", () => {
    expect(key("https://org.visualstudio.com/proj/_git/repo")).toBe("ado:org/proj/repo");
    expect(key("https://org.visualstudio.com/DefaultCollection/proj/_git/repo")).toBe("ado:org/proj/repo");
  });

  test("SSH — the v3/{org}/{project}/{repo} triple, both hosts", () => {
    expect(key("git@ssh.dev.azure.com:v3/org/proj/repo")).toBe("ado:org/proj/repo");
    expect(key("ssh://git@ssh.dev.azure.com:22/v3/org/proj/repo")).toBe("ado:org/proj/repo");
    expect(key("org@vs-ssh.visualstudio.com:v3/org/proj/repo")).toBe("ado:org/proj/repo");
    // The legacy SSH host must not be read as an ORG named "vs-ssh" by the
    // {org}.visualstudio.com pattern — the two overlap, so order matters.
    expect(parseRepoUrl("org@vs-ssh.visualstudio.com:v3/org/proj/repo")?.owner).toBe("org");
  });

  test("every form of the same repo shares one identity", () => {
    const forms = [
      "https://dev.azure.com/org/proj/_git/repo",
      "https://org@dev.azure.com/org/proj/_git/repo",
      "https://org.visualstudio.com/proj/_git/repo",
      "git@ssh.dev.azure.com:v3/org/proj/repo",
    ];
    // This is what lets an existing checkout be recognized however it was cloned.
    expect(new Set(forms.map(key)).size).toBe(1);
  });

  test("a project-less URL names the project after the repo (ADO's own shorthand)", () => {
    const u = parseRepoUrl("https://dev.azure.com/org/_git/repo");
    expect(u).toMatchObject({ owner: "org", project: "repo", repo: "repo" });
    expect(u?.remote).toBe("https://dev.azure.com/org/repo/_git/repo");
  });

  test("percent-encoding is decoded for the identity, kept in the remote", () => {
    const u = parseRepoUrl("https://dev.azure.com/org/My%20Proj/_git/My%20Repo");
    expect(u).toMatchObject({ project: "My Proj", repo: "My Repo" });
    // git has to send the encoded form.
    expect(u?.remote).toBe("https://dev.azure.com/org/My%20Proj/_git/My%20Repo");
    expect(cloneDirName(u!.repo)).toBe("My-Repo");
  });

  test("userinfo is preserved in the remote — it's the account the creds are for", () => {
    expect(parseRepoUrl("https://org@dev.azure.com/org/proj/_git/repo")?.remote)
      .toBe("https://org@dev.azure.com/org/proj/_git/repo");
  });

  test("an embedded PAT still clones, but is never the string shown on screen", () => {
    // ADO hands out `https://org:<PAT>@dev.azure.com/…`, and people paste it.
    const u = parseRepoUrl("https://org:sup3rs3cr3t@dev.azure.com/org/proj/_git/repo")!;
    // git gets the real thing — dropping it would break a clone the user
    // explicitly authenticated.
    expect(u.remote).toContain("sup3rs3cr3t");
    // The UI does not. The username survives; only the secret half is masked.
    expect(u.displayRemote).toBe("https://org:***@dev.azure.com/org/proj/_git/repo");
    expect(u.displayRemote).not.toContain("sup3rs3cr3t");
  });

  test("a token in the USERNAME position is masked too — but the org isn't", () => {
    // `https://<something>@dev.azure.com/…` is structurally ambiguous: ADO's own
    // Clone button puts the ORG there, and a bare PAT looks identical. Only a
    // name we can vouch for is shown.
    expect(parseRepoUrl("https://sup3rs3cr3t@dev.azure.com/org/proj/_git/repo")?.displayRemote)
      .toBe("https://***@dev.azure.com/org/proj/_git/repo");
    expect(parseRepoUrl("https://org@dev.azure.com/org/proj/_git/repo")?.displayRemote)
      .toBe("https://org@dev.azure.com/org/proj/_git/repo");
    // `git` is the SSH user in every scp form, so it's never mistaken for a token.
    expect(parseRepoUrl("git@ssh.dev.azure.com:v3/org/proj/repo")?.displayRemote)
      .toBe("git@ssh.dev.azure.com:v3/org/proj/repo");
  });

  test("no `_git` segment means it isn't a repo URL", () => {
    expect(parseRepoUrl("https://dev.azure.com/org/proj")).toBeNull();
    expect(parseRepoUrl("https://dev.azure.com/org")).toBeNull();
    expect(parseRepoUrl("https://org.visualstudio.com/proj")).toBeNull();
  });

  test("the host must be the real host, not a username or a path segment", () => {
    // `dev.azure.com` as USERINFO — the actual host is evil.example.
    expect(parseRepoUrl("https://dev.azure.com@evil.example/org/proj/_git/repo")).toBeNull();
    // `dev.azure.com` as a PATH segment — the actual host is evil.example.
    expect(parseRepoUrl("https://evil.example/dev.azure.com/org/proj/_git/repo")).toBeNull();
    expect(parseRepoUrl("https://notdev.azure.com.evil.org/org/proj/_git/repo")).toBeNull();
  });
});

test.describe("parseRepoUrl: junk in, null out", () => {
  test("anything that isn't a supported forge URL is rejected", () => {
    for (const u of [
      "",
      "   ",
      "not a url",
      "repo",
      "/home/me/git/repo",
      "~/git/repo",
      "file:///etc/passwd",
      "https://example.com/owner/repo",
      "https://bitbucket.org/owner/repo",
      "http://localhost:8080/owner/repo",
      "ssh://git@internal.example/owner/repo",
      // Nothing that could be read as an argument may survive to `git clone`
      // (which is also invoked with `--`, belt and braces).
      "--upload-pack=touch /tmp/pwned",
      "-u ext::sh -c whoami",
      "ext::sh -c whoami",
      // A supported host as a *query parameter* of an unsupported one: the token
      // is the evil host's URL, and everything from `?` on is dropped.
      "https://evil.example/?redirect=https://github.com/owner/repo",
    ]) {
      expect(parseRepoUrl(u), JSON.stringify(u)).toBeNull();
    }
  });

  test("paste decoration is tolerated, not treated as part of the URL", () => {
    for (const u of [
      "  https://github.com/owner/repo  ",
      "<https://github.com/owner/repo>",
      '"https://github.com/owner/repo"',
      "https://github.com/owner/repo#readme",
      "(https://github.com/owner/repo)",
    ]) {
      expect(key(u), u).toBe("github:owner/repo");
    }
  });

  test("a whole command line pasted out of a README still works", () => {
    // Only a *token* that is itself a URL on a recognized host parses, and the
    // remote handed to git is rebuilt from that parse — never from the text.
    expect(key("git clone https://github.com/owner/repo")).toBe("github:owner/repo");
    expect(key("git clone --depth 1 git@github.com:owner/repo.git")).toBe("github:owner/repo");
    expect(parseRepoUrl("git clone https://github.com/owner/repo/tree/main x")?.remote)
      .toBe("https://github.com/owner/repo.git");
  });
});

test.describe("repoUrlLabel / cloneDirName", () => {
  test("the label names the repo the way its host does", () => {
    expect(repoUrlLabel(parseRepoUrl("https://github.com/owner/repo")!)).toBe("owner/repo");
    expect(repoUrlLabel(parseRepoUrl("https://dev.azure.com/org/proj/_git/repo")!)).toBe("org/proj/repo");
  });

  test("a directory name can never be hidden, empty, or a literal .git", () => {
    expect(cloneDirName("repo")).toBe("repo");
    expect(cloneDirName("my.repo-2")).toBe("my.repo-2");
    expect(cloneDirName("My Repo")).toBe("My-Repo");
    expect(cloneDirName("a/b")).toBe("a-b");
    expect(cloneDirName(".git")).toBe("git");
    expect(cloneDirName("...")).toBe("repo");
    expect(cloneDirName("")).toBe("repo");
  });
});

test.describe("where the clone lands", () => {
  let dir: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agendo-clone-"));
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Make `<dir>/<rel>` a checkout (a `.git` marker is all the scan looks for). */
  const checkout = (rel: string) => mkdirSync(join(dir, rel, ".git"), { recursive: true });

  test("freeCloneDest: a name nobody has taken is used as-is", () => {
    expect(freeCloneDest(dir, "repo")).toBe(join(dir, "repo"));
  });

  test("freeCloneDest: an EMPTY directory is free — git clones into those", () => {
    mkdirSync(join(dir, "repo"));
    expect(freeCloneDest(dir, "repo")).toBe(join(dir, "repo"));
  });

  test("freeCloneDest: a non-empty directory is stepped over, not clobbered", () => {
    mkdirSync(join(dir, "repo"));
    writeFileSync(join(dir, "repo", "something-of-mine.txt"), "x");
    expect(freeCloneDest(dir, "repo")).toBe(join(dir, "repo-2"));

    mkdirSync(join(dir, "repo-2"));
    writeFileSync(join(dir, "repo-2", "also-mine.txt"), "x");
    expect(freeCloneDest(dir, "repo")).toBe(join(dir, "repo-3"));
  });

  test("freeCloneDest: gives up legibly rather than inventing a name", () => {
    for (let n = 1; n <= 20; n++) {
      const name = n === 1 ? "repo" : `repo-${n}`;
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "taken.txt"), "x");
    }
    expect(freeCloneDest(dir, "repo")).toBeNull();
  });

  test("findMatchingCheckout: an existing clone of the same repo wins, whatever it's called", () => {
    checkout("some-other-folder-name");
    const origins: Record<string, string> = {
      [join(dir, "some-other-folder-name")]: "git@github.com:owner/repo.git",
    };
    // Pasted as an HTTPS web URL; on disk it was cloned over SSH. Same repo.
    const url = parseRepoUrl("https://github.com/owner/repo/tree/main")!;
    expect(findMatchingCheckout(dir, url.key, (d) => origins[d] ?? null))
      .toBe(join(dir, "some-other-folder-name"));
  });

  test("findMatchingCheckout: the target directory ITSELF counts", () => {
    mkdirSync(join(dir, ".git"));
    const url = parseRepoUrl("https://dev.azure.com/org/proj/_git/repo")!;
    expect(findMatchingCheckout(dir, url.key, () => "https://org.visualstudio.com/proj/_git/repo"))
      .toBe(dir);
  });

  test("findMatchingCheckout: a DIFFERENT repo is not a match", () => {
    checkout("repo");
    const url = parseRepoUrl("https://github.com/owner/repo")!;
    // Same folder name, different owner — a fork, or an unrelated project.
    expect(findMatchingCheckout(dir, url.key, () => "https://github.com/someone-else/repo.git"))
      .toBeNull();
  });

  test("findMatchingCheckout: a linked WORKTREE is not mistaken for the checkout", () => {
    // A linked worktree has a `.git` FILE, not a directory — but `git remote
    // get-url origin` inside it answers with the main repo's origin, so matching
    // on origin alone would hand back the worktree as if it were the repo root
    // (and `git worktree add` would then nest a worktree inside a worktree).
    mkdirSync(join(dir, "repo-feature"));
    writeFileSync(join(dir, "repo-feature", ".git"), "gitdir: /elsewhere/.git/worktrees/feature\n");
    const url = parseRepoUrl("https://github.com/owner/repo")!;
    expect(findMatchingCheckout(dir, url.key, () => "https://github.com/owner/repo.git")).toBeNull();

    // The real checkout, added afterwards so it sorts LATER, is still found.
    checkout("the-real-one");
    expect(findMatchingCheckout(dir, url.key, () => "https://github.com/owner/repo.git"))
      .toBe(join(dir, "the-real-one"));
  });

  test("enclosingCheckout: finds the repo a path sits in, at any depth", () => {
    mkdirSync(join(dir, "myrepo", ".git"), { recursive: true });
    mkdirSync(join(dir, "myrepo", "src", "deep"), { recursive: true });
    expect(enclosingCheckout(join(dir, "myrepo"), dir)).toBe(join(dir, "myrepo"));
    expect(enclosingCheckout(join(dir, "myrepo", "src", "deep"), dir)).toBe(join(dir, "myrepo"));
    // A plain folder of checkouts is exactly where cloning belongs.
    expect(enclosingCheckout(dir, dir)).toBeNull();
  });

  test("enclosingCheckout: a dotfiles repo at $HOME does not swallow the whole machine", () => {
    // Keeping dotfiles in a git repo at ~ is a common setup. An unbounded
    // walk-up would find `~/.git` from every directory the user owns and
    // silently disable cloning everywhere.
    mkdirSync(join(dir, ".git")); // `dir` stands in for $HOME here
    mkdirSync(join(dir, "git", "projects"), { recursive: true });
    expect(enclosingCheckout(join(dir, "git"), dir)).toBeNull();
    expect(enclosingCheckout(join(dir, "git", "projects"), dir)).toBeNull();
    // A real project checkout under it is still found.
    mkdirSync(join(dir, "git", "projects", "app", ".git"), { recursive: true });
    expect(enclosingCheckout(join(dir, "git", "projects", "app"), dir))
      .toBe(join(dir, "git", "projects", "app"));
  });

  test("findMatchingCheckout: non-repos and origin-less checkouts are skipped, not crashed on", () => {
    mkdirSync(join(dir, "just-a-folder"));
    checkout("no-origin");
    const url = parseRepoUrl("https://github.com/owner/repo")!;
    expect(findMatchingCheckout(dir, url.key, () => null)).toBeNull();
  });
});
