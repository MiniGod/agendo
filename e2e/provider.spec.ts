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
import { detectProviders, resolveInitialProvider, PROVIDER_INFO } from "../src/provider.ts";

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
function fakePath(installed: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "clops-provider-"));
  // A `which <cmd>` that succeeds iff a file named <cmd> exists in this same dir.
  // The dir is baked in so it works regardless of how $0 is resolved.
  writeFileSync(join(dir, "which"), `#!/bin/sh\n[ -e "${dir}/$1" ] && exit 0 || exit 1\n`);
  chmodSync(join(dir, "which"), 0o755);
  for (const cli of installed) {
    writeFileSync(join(dir, cli), "#!/bin/sh\nexit 0\n");
    chmodSync(join(dir, cli), 0o755);
  }
  return dir;
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
