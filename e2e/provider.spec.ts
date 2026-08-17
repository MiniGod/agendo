// Unit coverage for the provider abstraction added by cc05391 (the GitHub backend
// alongside Azure DevOps). Two deterministic, browser-free concerns:
//   1. `vocab(provider)` — the per-backend UI terminology the whole TUI renders
//      through. A wrong string here silently mislabels every view.
//   2. `detectProviders` / `resolveInitialProvider` — which backend the app boots
//      into. The tie-break (GitHub wins when both CLIs are installed) and the
//      persisted-choice / fallback rules decide this, and getting them wrong flips
//      the entire app to the wrong backend (exactly the failure the e2e harness has
//      to pin its provider against). We drive these through a self-contained fake
//      PATH — a stub `which` + stub `gh`/`az` — so the test never sees the real
//      CLIs that happen to be installed on the machine.
import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vocab } from "../src/vocab.ts";
import {
  detectProviders,
  resolveInitialProvider,
  detectRepoProvider,
  detectScopeProvider,
  PROVIDER_INFO,
  getProvider,
} from "../src/provider.ts";
import { parseGithubRemote, githubIssueUrl, githubPullRequestUrl } from "../src/github.ts";
import { adoPullRequestUrl, adoWorkItemUrl } from "../src/ado.ts";
import type { RepoInfo } from "../src/repos.ts";

test.describe("vocab: per-backend UI terminology", () => {
  test("ADO speaks work-items / sprint / '!' PRs", () => {
    const v = vocab("ado");
    expect(v.prPrefix).toBe("!");
    expect(v.itemsTab).toBe("Work items");
    expect(v.primaryHeader).toBe("Current sprint");
    expect(v.primaryShowsIteration).toBe(true);
    expect(v.secondaryToggle).toBe("Everything else assigned");
    expect(v.linkedHeader).toBe("PRs on your work items");
    expect(v.orphanHeader).toBe("PRs without a work item");
    expect(v.repoScopedFresh).toBe(false); // ADO ids are globally unique
  });

  test("GitHub speaks issues / created-by-me / '#' PRs", () => {
    const v = vocab("github");
    expect(v.prPrefix).toBe("#");
    expect(v.itemsTab).toBe("Issues");
    expect(v.primaryHeader).toBe("Created by me");
    expect(v.primaryShowsIteration).toBe(false);
    expect(v.secondaryToggle).toBe("In your repos");
    expect(v.linkedHeader).toBe("PRs on your issues");
    expect(v.orphanHeader).toBe("PRs without an issue");
    expect(v.repoScopedFresh).toBe(true); // issue/PR numbers collide across repos
  });

  test("an unknown provider falls back to the ADO vocab (never throws)", () => {
    // vocab() returns GitHub only for the exact "github" string; anything else is
    // ADO. Guards the resolver against a corrupt persisted provider value.
    expect(vocab("ado")).toBe(vocab("ado"));
    expect(vocab(undefined as never).itemsTab).toBe("Work items");
  });
});

// ── fake PATH for the CLI-detection tests ────────────────────────────────────
// Build an isolated bin dir containing a stub `which` (so `hasCli`'s spawn-based
// probe resolves under a PATH that has ONLY this dir — no real gh/az leaks in) and
// a stub for each CLI we want to appear "installed". Stubs are executable so the
// Bun.which fast path (if the runner is Bun) finds them too.
function fakePath(installed: string[], gitOrigin?: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "agendo-provider-"));
  // A `which <cmd>` that succeeds iff a file named <cmd> exists in this same dir.
  // The dir is baked in so it works regardless of how $0 is resolved.
  writeFileSync(join(dir, "which"), `#!/bin/sh\n[ -e "${dir}/$1" ] && exit 0 || exit 1\n`);
  chmodSync(join(dir, "which"), 0o755);
  for (const cli of installed) {
    writeFileSync(join(dir, cli), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, cli), 0o755);
  }
  // A stub `git` for detectRepoProvider: `remote get-url origin` prints the given
  // origin URL, or exits non-zero (undefined/null) to mimic a no-remote / non-repo.
  const git =
    gitOrigin == null
      ? "#!/bin/sh\nexit 1\n"
      : `#!/bin/sh\ncase "$*" in *"remote get-url origin"*) echo "${gitOrigin}"; exit 0;; esac\nexit 0\n`;
  writeFileSync(join(dir, "git"), git);
  chmodSync(join(dir, "git"), 0o755);
  return dir;
}

// Run `fn` with PATH pointed at a fake bin dir whose stub `git` reports the given
// origin URL (or null = no remote / not a repo), then restore PATH.
function withGitOrigin(origin: string | null, fn: () => void): void {
  const saved = process.env.PATH;
  process.env.PATH = fakePath(["gh", "az"], origin);
  try {
    fn();
  } finally {
    process.env.PATH = saved;
  }
}

// Like withGitOrigin, but the stub `git` answers per `-C <path>`: listed paths
// print their origin, anything else exits non-zero (no remote / not a repo).
// detectScopeProvider needs that — its whole point is a parent folder with no
// remote of its own whose repos do have one.
function withGitOrigins(origins: Record<string, string>, fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), "agendo-provider-"));
  writeFileSync(join(dir, "which"), `#!/bin/sh\n[ -e "${dir}/$1" ] && exit 0 || exit 1\n`);
  chmodSync(join(dir, "which"), 0o755);
  for (const cli of ["gh", "az"]) {
    writeFileSync(join(dir, cli), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, cli), 0o755);
  }
  const cases = Object.entries(origins)
    .map(([p, url]) => `    "${p}") echo "${url}"; exit 0;;`)
    .join("\n");
  const git = `#!/bin/sh\ncase "$*" in\n  *"remote get-url origin"*)\n  case "$2" in\n${cases}\n  esac\n  exit 1;;\nesac\nexit 0\n`;
  writeFileSync(join(dir, "git"), git);
  chmodSync(join(dir, "git"), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    fn();
  } finally {
    process.env.PATH = saved;
  }
}

// Run `fn` with process.env.PATH pointed only at a fake bin dir, then restore it.
// detectProviders reads PATH at call time, so swapping it is enough.
function withPath(installed: string[], fn: () => void): void {
  const saved = process.env.PATH;
  process.env.PATH = fakePath(installed);
  try {
    fn();
  } finally {
    process.env.PATH = saved;
  }
}

test.describe("detectProviders / resolveInitialProvider: which backend boots", () => {
  test("PROVIDER_INFO lists GitHub first (so it wins auto-detect ties)", () => {
    expect(PROVIDER_INFO.map((p) => p.name)).toEqual(["github", "ado"]);
    expect(PROVIDER_INFO.find((p) => p.name === "github")?.cli).toBe("gh");
    expect(PROVIDER_INFO.find((p) => p.name === "ado")?.cli).toBe("az");
  });

  test("detects exactly the installed CLIs", () => {
    withPath(["gh", "az"], () => expect([...detectProviders()].sort()).toEqual(["ado", "github"]));
    withPath(["az"], () => expect([...detectProviders()]).toEqual(["ado"]));
    withPath(["gh"], () => expect([...detectProviders()]).toEqual(["github"]));
    withPath([], () => expect([...detectProviders()]).toEqual([]));
  });

  test("with both installed and no saved choice, GitHub wins the tie", () => {
    withPath(["gh", "az"], () => {
      expect(resolveInitialProvider()).toBe("github"); // first in PROVIDER_INFO
      expect(resolveInitialProvider("ado")).toBe("ado"); // a saved+installed choice is honored
      expect(resolveInitialProvider("github")).toBe("github");
    });
  });

  test("a saved choice whose CLI vanished falls back to the first installed one", () => {
    withPath(["az"], () => {
      expect(resolveInitialProvider()).toBe("ado"); // only az installed
      expect(resolveInitialProvider("github")).toBe("ado"); // gh gone → first installed
    });
  });

  test("with nothing installed it still returns a provider (persisted, else the default)", () => {
    withPath([], () => {
      expect(resolveInitialProvider("github")).toBe("github"); // last-resort: the saved value
      expect(resolveInitialProvider("ado")).toBe("ado");
      expect(resolveInitialProvider()).toBe("github"); // last-resort: PROVIDER_INFO[0]
    });
  });
});

test.describe("detectRepoProvider: force the backend from a path context's git remote", () => {
  test("a github.com origin → github (both HTTPS and SSH forms)", () => {
    withGitOrigin("https://github.com/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBe("github"),
    );
    withGitOrigin("git@github.com:ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBe("github"),
    );
    withGitOrigin("ssh://git@github.com/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBe("github"),
    );
    // GitHub's SSH-over-HTTPS host with an explicit port, and a capitalized host.
    withGitOrigin("ssh://git@ssh.github.com:443/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBe("github"),
    );
    withGitOrigin("https://GitHub.com/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBe("github"),
    );
  });

  test("an Azure DevOps origin → ado (HTTPS, SSH and the legacy visualstudio.com forms)", () => {
    // Detection has to run both ways: a persisted GitHub default pointed at an
    // ADO target would filter ADO PRs against `owner/repo` slugs and show nothing.
    withGitOrigin("https://dev.azure.com/innovamps/proj/_git/appweb", () =>
      expect(detectRepoProvider("/repo")).toBe("ado"),
    );
    withGitOrigin("git@ssh.dev.azure.com:v3/innovamps/proj/appweb", () =>
      expect(detectRepoProvider("/repo")).toBe("ado"),
    );
    withGitOrigin("https://innovamps.visualstudio.com/proj/_git/appweb", () =>
      expect(detectRepoProvider("/repo")).toBe("ado"),
    );
    withGitOrigin("git@vs-ssh.visualstudio.com:v3/innovamps/proj/appweb", () =>
      expect(detectRepoProvider("/repo")).toBe("ado"),
    );
  });

  test("a look-alike host is not mistaken for either backend", () => {
    // The host must be exactly the real one, delimited — not a substring.
    withGitOrigin("https://evilgithub.com/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
    withGitOrigin("https://github.com.example.org/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
    withGitOrigin("https://evilvisualstudio.com/proj/_git/appweb", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
    withGitOrigin("https://dev.azure.com.example.org/org/proj/_git/appweb", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
  });

  test("an unrelated host → null (leave the configured default untouched)", () => {
    withGitOrigin("git@gitlab.com:ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
  });

  test("no origin remote / not a git repo → null", () => {
    withGitOrigin(null, () => expect(detectRepoProvider("/repo")).toBeNull());
  });
});

test.describe("detectScopeProvider: a parent folder inherits its repos' tracker", () => {
  const repo = (root: string): RepoInfo => ({ root, name: root, total: 0, claude: 0, copilot: 0, codex: 0 });

  test("a folder with no origin of its own is decided by the repos inside it", () => {
    // The plain parent folder itself has no remote, so detectRepoProvider alone
    // returns null — a persisted ADO default would stay put and then be filtered
    // against GitHub-derived repo keys (a half-empty ADO view).
    withGitOrigins({ "/parent/appweb": "git@github.com:ada/appweb.git" }, () => {
      expect(detectRepoProvider("/parent")).toBeNull();
      expect(detectScopeProvider("/parent", [repo("/parent/appweb")])).toBe("github");
    });
  });

  test("no repos inside → null (nothing to infer from, keep the default)", () => {
    withGitOrigins({ "/parent/appweb": "git@github.com:ada/appweb.git" }, () =>
      expect(detectScopeProvider("/parent", [])).toBeNull(),
    );
  });

  test("ADO repos inside force ADO (the mirror case, not one-directional)", () => {
    withGitOrigins({ "/parent/appweb": "https://dev.azure.com/innovamps/proj/_git/appweb" }, () =>
      expect(detectScopeProvider("/parent", [repo("/parent/appweb")])).toBe("ado"),
    );
  });

  test("a repo with no usable origin doesn't veto the ones that have one", () => {
    // Repos come in name order, so a scratch `git init` (or a clone from some
    // unrelated host) can sort first. Consulting only that one would report
    // "nothing to infer" and leave the persisted default in place — while the
    // scope keys still come from the GitHub clones, filtering the view empty.
    withGitOrigins({ "/parent/zz-appweb": "git@github.com:ada/appweb.git" }, () => {
      expect(detectRepoProvider("/parent/aaa-scratch")).toBeNull(); // no origin
      expect(
        detectScopeProvider("/parent", [repo("/parent/aaa-scratch"), repo("/parent/zz-appweb")]),
      ).toBe("github");
    });
    withGitOrigins(
      {
        "/parent/aaa-scratch": "git@gitlab.com:ada/scratch.git", // known host, unknown backend
        "/parent/zz-appweb": "https://dev.azure.com/innovamps/proj/_git/appweb",
      },
      () =>
        expect(
          detectScopeProvider("/parent", [repo("/parent/aaa-scratch"), repo("/parent/zz-appweb")]),
        ).toBe("ado"),
    );
  });

  test("repos in scope but none of them recognizable → null, never the path", () => {
    // The enclosing-checkout hazard again: if no repo can answer we still don't
    // fall back to `git -C <parent>`, which would report the dotfiles repo.
    withGitOrigins({ "/parent": "git@github.com:ada/dotfiles.git" }, () =>
      expect(detectScopeProvider("/parent", [repo("/parent/scratch")])).toBeNull(),
    );
  });

  test("the discovered repos outvote an enclosing checkout's origin", () => {
    // `git -C <parent>` answers from whatever checkout *encloses* the parent — a
    // $HOME tracked as dotfiles on GitHub, say — even though the repos actually
    // in scope are ADO. Letting that win would force GitHub and then filter the
    // ADO views against slugs their bare repo names can never match (empty view).
    withGitOrigins(
      {
        "/parent": "git@github.com:ada/dotfiles.git",
        "/parent/appweb": "https://dev.azure.com/innovamps/proj/_git/appweb",
      },
      () => {
        expect(detectRepoProvider("/parent")).toBe("github");
        expect(detectScopeProvider("/parent", [repo("/parent/appweb")])).toBe("ado");
      },
    );
  });
});

test.describe("parseGithubRemote: origin URL → owner/repo (host-anchored, port-aware)", () => {
  test("SSH and HTTPS forms, with and without .git / trailing slash", () => {
    expect(parseGithubRemote("git@github.com:ada/appweb.git")).toEqual({ owner: "ada", repo: "appweb" });
    expect(parseGithubRemote("https://github.com/ada/appweb.git")).toEqual({ owner: "ada", repo: "appweb" });
    expect(parseGithubRemote("https://github.com/ada/appweb")).toEqual({ owner: "ada", repo: "appweb" });
    expect(parseGithubRemote("ssh://git@github.com/ada/appweb.git")).toEqual({ owner: "ada", repo: "appweb" });
    expect(parseGithubRemote("https://github.com/ada/appweb/")).toEqual({ owner: "ada", repo: "appweb" });
  });

  test("REGRESSION: SSH-over-HTTPS with a port → owner is the org, not the port", () => {
    // `ssh://git@ssh.github.com:443/owner/repo` used to parse owner="443".
    expect(parseGithubRemote("ssh://git@ssh.github.com:443/ada/appweb")).toEqual({ owner: "ada", repo: "appweb" });
    expect(parseGithubRemote("https://github.com:443/ada/appweb.git")).toEqual({ owner: "ada", repo: "appweb" });
  });

  test("case-insensitive host", () => {
    expect(parseGithubRemote("https://GitHub.com/ada/appweb.git")).toEqual({ owner: "ada", repo: "appweb" });
  });

  test("look-alike hosts are rejected (null), not silently mis-parsed", () => {
    expect(parseGithubRemote("https://mygithub.com/ada/appweb.git")).toBeNull();
    expect(parseGithubRemote("https://github.com.evil.org/ada/appweb.git")).toBeNull();
    expect(parseGithubRemote("git@gitlab.com:ada/appweb.git")).toBeNull();
  });
});

test.describe("resolveInitialProvider: a repo-detected provider overrides the default", () => {
  test("a forced github overrides a persisted ado when gh is installed", () => {
    withPath(["gh", "az"], () => expect(resolveInitialProvider("ado", "github")).toBe("github"));
  });

  test("no forced provider keeps the persisted default", () => {
    withPath(["gh", "az"], () => expect(resolveInitialProvider("ado", null)).toBe("ado"));
  });

  test("a forced ado overrides a persisted github when az is installed", () => {
    withPath(["gh", "az"], () => expect(resolveInitialProvider("github", "ado")).toBe("ado"));
  });

  test("a forced provider whose CLI is missing falls back (never strands the user)", () => {
    // github detected but gh not installed → don't force; keep the working default.
    withPath(["az"], () => expect(resolveInitialProvider("ado", "github")).toBe("ado"));
    withPath(["gh"], () => expect(resolveInitialProvider("github", "ado")).toBe("github"));
  });
});

// ── Canonical entity URLs ────────────────────────────────────────────────────
// The one place PR / work-item links are built (Provider.urls, implemented by
// ado.ts + github.ts). Hand-assembled links are a bug factory — ADO alone has
// three live host shapes and work-item URLs differ from PR URLs — so the exact
// strings are pinned here for every shape, including the percent-encoding that
// ADO project names (frequently containing spaces) depend on.
test.describe("entity URLs: Azure DevOps", () => {
  const DEV_AZURE = "https://dev.azure.com/innovamps";
  const LEGACY = "https://innovamps.visualstudio.com";

  test("dev.azure.com form: work item + pull request", () => {
    // Work-item links are ORG-level (no project segment) so they resolve for an
    // item in any project; PR links are project + repo scoped.
    expect(adoWorkItemUrl(DEV_AZURE, 234309)).toBe(
      "https://dev.azure.com/innovamps/_workitems/edit/234309",
    );
    expect(adoPullRequestUrl(DEV_AZURE, "MC", "mc-applications", 72031)).toBe(
      "https://dev.azure.com/innovamps/MC/_git/mc-applications/pullrequest/72031",
    );
  });

  test("legacy visualstudio.com form keeps the same paths under a different host", () => {
    expect(adoWorkItemUrl(LEGACY, 226140)).toBe(
      "https://innovamps.visualstudio.com/_workitems/edit/226140",
    );
    expect(adoPullRequestUrl(LEGACY, "MC", "mc-applications", 76896)).toBe(
      "https://innovamps.visualstudio.com/MC/_git/mc-applications/pullrequest/76896",
    );
  });

  test("a custom base (self-hosted / proxied, i.e. ADO_BASE_URL) is honoured verbatim", () => {
    const onPrem = "https://tfs.example.com/tfs/DefaultCollection";
    expect(adoWorkItemUrl(onPrem, 12)).toBe(
      "https://tfs.example.com/tfs/DefaultCollection/_workitems/edit/12",
    );
    expect(adoPullRequestUrl(onPrem, "Widgets", "appweb", 5001)).toBe(
      "https://tfs.example.com/tfs/DefaultCollection/Widgets/_git/appweb/pullrequest/5001",
    );
  });

  test("a trailing slash on the base never doubles up", () => {
    expect(adoWorkItemUrl("https://dev.azure.com/innovamps/", 7)).toBe(
      "https://dev.azure.com/innovamps/_workitems/edit/7",
    );
    expect(adoPullRequestUrl("https://dev.azure.com/innovamps//", "MC", "repo", 7)).toBe(
      "https://dev.azure.com/innovamps/MC/_git/repo/pullrequest/7",
    );
  });

  test("project / repo names with spaces or non-ASCII are percent-encoded", () => {
    // ADO project names very often contain spaces; unescaped they produce a link
    // that 404s (or silently truncates at the space when pasted into a chat).
    expect(adoPullRequestUrl(DEV_AZURE, "Marel Innova", "hmi framework", 42)).toBe(
      "https://dev.azure.com/innovamps/Marel%20Innova/_git/hmi%20framework/pullrequest/42",
    );
    expect(adoPullRequestUrl(DEV_AZURE, "Ísland", "þjónusta", 9)).toBe(
      "https://dev.azure.com/innovamps/%C3%8Dsland/_git/%C3%BEj%C3%B3nusta/pullrequest/9",
    );
    // A `/` inside a name must be escaped too — it would otherwise invent a path
    // segment and point the link at a different repo entirely.
    expect(adoPullRequestUrl(DEV_AZURE, "A/B", "repo", 1)).toBe(
      "https://dev.azure.com/innovamps/A%2FB/_git/repo/pullrequest/1",
    );
  });
});

test.describe("entity URLs: GitHub", () => {
  test("pull request + issue for an owner/repo slug", () => {
    expect(githubPullRequestUrl("MiniGod/agendo", 13)).toBe("https://github.com/MiniGod/agendo/pull/13");
    expect(githubIssueUrl("MiniGod/agendo", 16)).toBe("https://github.com/MiniGod/agendo/issues/16");
  });

  test("slug segments are percent-encoded, but the owner/repo separator survives", () => {
    expect(githubPullRequestUrl("Ada Lovelace/app web", 1)).toBe(
      "https://github.com/Ada%20Lovelace/app%20web/pull/1",
    );
    expect(githubIssueUrl("ada/þjónusta", 2)).toBe("https://github.com/ada/%C3%BEj%C3%B3nusta/issues/2");
  });

  test("the provider exposes the builders, and returns null without a repo scope", () => {
    // GitHub numbers issues and PRs per repo, so a reference with no slug has no
    // URL at all — null, never a plausible-looking link to the wrong repo.
    const { urls } = getProvider("github");
    expect(urls.pullRequest({ id: 401, repositoryId: "ada/appweb" })).toBe(
      "https://github.com/ada/appweb/pull/401",
    );
    expect(urls.workItem({ id: 301, project: "ada/appweb" })).toBe(
      "https://github.com/ada/appweb/issues/301",
    );
    expect(urls.pullRequest({ id: 401, repositoryId: "" })).toBeNull();
    expect(urls.workItem({ id: 301 })).toBeNull();
  });

  test("Azure DevOps exposes its builders through the same interface", () => {
    // Wiring check only: the ADO builders read the module's configured org /
    // project / ADO_BASE_URL, which the pure-function tests above pin exactly.
    const { urls } = getProvider("ado");
    expect(urls.workItem({ id: 234309 })).toContain("/_workitems/edit/234309");
    expect(urls.pullRequest({ id: 72031, repositoryId: "guid", repositoryName: "mc-applications" }))
      .toContain("/_git/mc-applications/pullrequest/72031");
  });
});
