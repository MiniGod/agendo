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
import { detectProviders, resolveInitialProvider, detectRepoProvider, PROVIDER_INFO } from "../src/provider.ts";
import { parseGithubRemote } from "../src/github.ts";

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

test.describe("detectRepoProvider: force GitHub from a path context's git remote", () => {
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

  test("an Azure DevOps origin → null (leave the configured default untouched)", () => {
    withGitOrigin("https://dev.azure.com/innovamps/proj/_git/appweb", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
    withGitOrigin("git@ssh.dev.azure.com:v3/innovamps/proj/appweb", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
    withGitOrigin("https://innovamps.visualstudio.com/proj/_git/appweb", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
  });

  test("a look-alike host is not mistaken for github.com", () => {
    // The host must be exactly github.com, delimited — not a substring.
    withGitOrigin("https://evilgithub.com/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
    withGitOrigin("https://github.com.example.org/ada/appweb.git", () =>
      expect(detectRepoProvider("/repo")).toBeNull(),
    );
  });

  test("no origin remote / not a git repo → null", () => {
    withGitOrigin(null, () => expect(detectRepoProvider("/repo")).toBeNull());
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

  test("a forced provider whose CLI is missing falls back (never strands the user)", () => {
    // github detected but gh not installed → don't force; keep the working default.
    withPath(["az"], () => expect(resolveInitialProvider("ado", "github")).toBe("ado"));
  });
});
