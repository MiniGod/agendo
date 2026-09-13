// `agendo --version` reads its number out of package.json at runtime
// (src/cli/version.ts). The e2e suite runs the flag end to end and proves the
// real package resolves; what it cannot reach is the half-broken install —
// package.json missing, truncated mid-write, or shipped without a version — and
// those are exactly the states a version probe exists to survive. Each one is a
// temp file here.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_JSON, readVersion } from "../src/cli/version.ts";

/** A package.json holding `body`, in a directory of its own. */
function pkgWith(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "agendo-version-")), "package.json");
  writeFileSync(path, body);
  return path;
}

describe("readVersion", () => {
  test("reads the version of the real package", () => {
    // Not pinned to a literal: the release workflow bumps this file, and a test
    // that has to be edited on every release is a test that gets edited without
    // being read. What matters is that the default path resolves at all and
    // yields something version-shaped.
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("the default path points at the package root", () => {
    // src/cli/version.ts is two levels below it. A refactor that moves the file
    // deeper without fixing the `..` count would otherwise only show up as
    // "unknown" on an installed copy, which no suite here runs.
    expect(PACKAGE_JSON).toBe(join(import.meta.dir, "..", "package.json"));
  });

  test("answers unknown when package.json is absent", () => {
    expect(readVersion(join(tmpdir(), "agendo-no-such-dir", "package.json"))).toBe("unknown");
  });

  test("answers unknown on a truncated file rather than throwing", () => {
    expect(readVersion(pkgWith('{"name":"agendo","vers'))).toBe("unknown");
  });

  test("answers unknown when there is no version field", () => {
    expect(readVersion(pkgWith('{"name":"agendo"}'))).toBe("unknown");
  });

  test("answers unknown when version is not a string", () => {
    // JSON permits it, so the cast in readVersion cannot assume otherwise.
    expect(readVersion(pkgWith('{"version":2}'))).toBe("unknown");
  });

  test("answers unknown on an empty version rather than printing a blank line", () => {
    expect(readVersion(pkgWith('{"version":""}'))).toBe("unknown");
  });

  test("returns a prerelease version verbatim", () => {
    expect(readVersion(pkgWith('{"version":"1.2.3-rc.1"}'))).toBe("1.2.3-rc.1");
  });
});
