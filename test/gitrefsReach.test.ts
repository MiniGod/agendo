import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";

// The invariant: nothing the TUI's rescan timer can reach may pull in
// src/gitrefs.ts.
//
// Reading a checkout's ref files is cheap once — that is the whole reason
// gitrefs.ts exists instead of spawning `git` — and ruinous when it happens per
// session, every two seconds, across the whole session corpus. `agendo status`
// and `agendo list` are one-shot commands and may read all they like. The TUI
// may not.
//
// e2e/cli.spec.ts already pins a PROXY for this: it whitelists the files under
// src/ allowed to write `from ".../gitrefs.ts"`, and the whitelist is
// `["index.tsx"]`. That check is cheap and it works, but it is one hop deep and
// filename-shaped — it answers "who typed the import" rather than "what can
// reach the reader". The two come apart in both directions:
//
//   - A false alarm: `import type { BranchSync }` is erased at runtime and puts
//     nothing on any timer, but reads to that regex exactly like a real import.
//   - A false pass: the whitelist says nothing about what index.tsx itself is
//     reachable FROM. Nothing imports the entrypoint today, and if something
//     ever did, every module behind it would inherit the reader silently.
//
// So this walks the actual import graph from the modules the rescan path is
// built out of, and fails if gitrefs.ts is reachable from any of them. When
// this test and the e2e whitelist disagree, THIS one is describing the bug.

const SRC = resolve(import.meta.dir, "..", "src");
const READER = join(SRC, "gitrefs.ts");

/** The modules a running TUI is made of, and the ones its 2s rescan drives. */
const RESCAN_ROOTS = [
  "cli/menu.tsx",
  "ui/App.tsx",
  "model.ts",
  "sessions.ts",
  "activity.ts",
];

/**
 * Relative-import targets of one module, resolved to absolute paths.
 *
 * Matches `export … from` as well as `import … from`, so a re-export cannot
 * launder the reader through a barrel module.
 *
 * The one shape it would NOT follow is a dynamic `import("…")`. There are none
 * anywhere in src/ today, and if one ever appears the honest fix is to teach
 * this function about it — not to assume the graph is still fully walked.
 */
function importsOf(file: string): string[] {
  const src = readFileSync(file, "utf-8");
  const out: string[] = [];
  // Every import in this repo carries its extension, so no resolution guessing
  // is needed — and a bare-specifier package import can never reach src/.
  for (const m of src.matchAll(/from\s+"(\.[^"]+)"/g)) out.push(resolve(dirname(file), m[1]));
  return out;
}

/**
 * Every module reachable from `roots`, with the path that got there — so a
 * failure names the chain rather than just the destination.
 */
function reachable(roots: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: Array<{ file: string; path: string[] }> = roots.map((r) => ({
    file: join(SRC, r),
    path: [r],
  }));
  while (queue.length) {
    const { file, path } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, path);
    for (const next of importsOf(file)) {
      if (seen.has(next)) continue;
      queue.push({ file: next, path: [...path, relative(SRC, next)] });
    }
  }
  return seen;
}

describe("the rescan path cannot reach the git-ref reader", () => {
  test("the roots exist and actually import things", () => {
    // Guards the test itself: a renamed entry module would otherwise make this
    // pass by walking nothing at all.
    for (const root of RESCAN_ROOTS) {
      expect(importsOf(join(SRC, root)).length).toBeGreaterThan(0);
    }
  });

  test("src/gitrefs.ts is not reachable from any of them", () => {
    const seen = reachable(RESCAN_ROOTS);
    const chain = seen.get(READER);
    expect(chain ? chain.join(" → ") : null).toBeNull();
  });

  test("the walk is real — it reaches the modules it should", () => {
    // If `reachable` silently stopped at the roots, the assertion above would
    // pass for the wrong reason. sessions.ts is several hops in from the UI.
    const seen = reachable(["ui/App.tsx"]);
    expect(seen.has(join(SRC, "sessions.ts"))).toBe(true);
    expect(seen.size).toBeGreaterThan(10);
  });

  test("the reader is still wired up somewhere", () => {
    // The mirror of the e2e check's own `importers.length > 0`: an invariant
    // about what must NOT import gitrefs.ts is satisfied trivially by deleting
    // its last caller, which would be a regression wearing a green suite.
    const seen = reachable(["index.tsx"]);
    expect(seen.has(READER)).toBe(true);
  });
});
