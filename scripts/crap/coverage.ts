// Reads every counter dump scripts/crap/preload.ts left behind and folds them
// into one map. The dumps come from independent processes that all loaded the
// same instrumented text, so the maps agree and merging is a sum per counter.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CoverageMap, FileCoverage } from "./types.ts";

function addCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

/** Merge dumps; a file whose instrumentation hash changed between dumps is
 *  skipped with a warning rather than mis-summed. */
export function mergeCoverage(dumps: CoverageMap[], warn: (msg: string) => void = console.warn): CoverageMap {
  const merged: CoverageMap = {};
  for (const dump of dumps) {
    for (const [path, fc] of Object.entries(dump)) {
      const have = merged[path];
      if (!have) {
        merged[path] = { ...fc, s: { ...fc.s }, f: { ...fc.f } };
        continue;
      }
      if (have.hash !== fc.hash) {
        warn(`crap: ${path} was instrumented from two different sources; keeping the first`);
        continue;
      }
      addCounts(have.s, fc.s);
      addCounts(have.f, fc.f);
    }
  }
  return merged;
}

export function loadCoverage(dir: string): CoverageMap {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return {};
  }
  const dumps = names.map((n) => JSON.parse(readFileSync(join(dir, n), "utf-8")) as CoverageMap);
  return mergeCoverage(dumps);
}

/** Coverage keyed by repo-relative path, to match the file names oxlint reports. */
export function relativize(map: CoverageMap, root: string): Map<string, FileCoverage> {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const out = new Map<string, FileCoverage>();
  for (const [path, fc] of Object.entries(map)) {
    out.set(path.startsWith(prefix) ? path.slice(prefix.length) : path, fc);
  }
  return out;
}
