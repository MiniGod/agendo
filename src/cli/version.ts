// `agendo --version` / `-v` / `version`: print the running build's version.
//
// The number is read from package.json at RUNTIME rather than imported, so
// there is nothing to keep in sync and no second copy to go stale. The release
// workflow bumps package.json and nothing else; a build reports whatever that
// file says, including in a git checkout run through `bunx github:…`.
//
// package.json sits one level above `src/`, and this module two levels below
// the package root, in the published tree exactly as in the repo (`files` ships
// `src/`, and npm always includes package.json).
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PACKAGE_JSON = join(import.meta.dir, "..", "..", "package.json");

/**
 * The version string, or "unknown" when package.json is missing, unreadable or
 * has no string `version`.
 *
 * Answering "unknown" rather than throwing is deliberate: a version probe is the
 * one command that must survive a half-broken install, since "what am I even
 * running" is the first question asked of one. An agent parsing this gets a line
 * either way instead of a stack trace on stderr.
 */
export function readVersion(pkgPath: string = PACKAGE_JSON): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
    const version = (parsed as { version?: unknown }).version;
    return typeof version === "string" && version !== "" ? version : "unknown";
  } catch {
    return "unknown";
  }
}
