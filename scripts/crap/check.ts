// The gate: compares scored functions with the pins in .craprc.jsonc.
// Pure so the contract can be tested; scripts/crap/run.ts does the printing.
import type { ScoredFunction } from "./types.ts";

export interface CrapOverride {
  file: string;
  function: string;
  max: number;
}

export interface CrapConfig {
  max: number;
  overrides?: CrapOverride[];
}

export interface CheckResult {
  /** Functions above the pin that applies to them. Non-empty means fail. */
  failures: { fn: ScoredFunction; max: number }[];
  /** Overrides naming a function that no longer exists. Also a failure: a pin
   *  nothing answers to is slack that has to be deleted, not carried. */
  orphanOverrides: CrapOverride[];
  /** Overrides whose function now fits the shared budget. Reported, not fatal —
   *  a function riding just under the shared max can cross it on coverage
   *  noise, and a warning is the right volume for that. */
  staleOverrides: { override: CrapOverride; crap: number }[];
  /** The worst function the shared budget answers for, i.e. what `max` could be. */
  worstShared: ScoredFunction | undefined;
}

function pinFor(fn: ScoredFunction, config: CrapConfig): CrapOverride | undefined {
  return config.overrides?.find((o) => o.file === fn.file && o.function === fn.name);
}

/** Two decimals is what the report prints; comparing the rounded value keeps
 *  "the table says 31.25 and the pin says 31.25" from failing on a stray bit. */
export function rounded(crap: number): number {
  return Math.round(crap * 100) / 100;
}

export function check(scored: ScoredFunction[], config: CrapConfig): CheckResult {
  const failures: CheckResult["failures"] = [];
  const staleOverrides: CheckResult["staleOverrides"] = [];
  let worstShared: ScoredFunction | undefined;
  const seen = new Set<CrapOverride>();
  for (const fn of scored) {
    const pin = pinFor(fn, config);
    if (pin) seen.add(pin);
    const max = pin?.max ?? config.max;
    if (rounded(fn.crap) > max) failures.push({ fn, max });
    if (pin && rounded(fn.crap) <= config.max) staleOverrides.push({ override: pin, crap: fn.crap });
    if (!pin && (!worstShared || fn.crap > worstShared.crap)) worstShared = fn;
  }
  const orphanOverrides = (config.overrides ?? []).filter((o) => !seen.has(o));
  return { failures, orphanOverrides, staleOverrides, worstShared };
}
