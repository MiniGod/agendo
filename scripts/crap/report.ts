// Human-readable rendering of a scored run. The JSON next to it is the record;
// this is the glance.
import type { CheckResult } from "./check.ts";
import { rounded } from "./check.ts";
import type { ScoredFunction } from "./types.ts";

const pct = (x: number): string => `${Math.round(x * 100)}%`;

function row(fn: ScoredFunction): string {
  const where = `${fn.file}:${fn.line}`.padEnd(40);
  const name = fn.name.padEnd(28);
  return `  ${rounded(fn.crap).toFixed(2).padStart(9)}  ${String(fn.cc).padStart(3)}  ${pct(fn.coverage).padStart(5)}  ${where} ${name}`;
}

export function summary(scored: ScoredFunction[], top = 25): string {
  const lines = [`  ${"CRAP".padStart(9)}  ${"cc".padStart(3)}  ${"cov".padStart(5)}  ${"where".padEnd(40)} function`];
  for (const fn of scored.slice(0, top)) lines.push(row(fn));
  const over7 = scored.filter((f) => rounded(f.crap) > 7).length;
  const uncovered = scored.filter((f) => f.coverage === 0).length;
  lines.push("", `  ${scored.length} functions scored; ${over7} above CRAP 7; ${uncovered} with no coverage at all.`);
  return lines.join("\n");
}

export function verdict(result: CheckResult, sharedMax: number): string {
  const lines: string[] = [];
  for (const { fn, max } of result.failures) {
    lines.push(`  FAIL  ${fn.file}:${fn.line} ${fn.name} — CRAP ${rounded(fn.crap).toFixed(2)} > ${max} (cc ${fn.cc}, cov ${pct(fn.coverage)})`);
  }
  for (const o of result.orphanOverrides) {
    lines.push(`  FAIL  .craprc.jsonc pins ${o.file} ${o.function}, which no longer exists — delete the override`);
  }
  for (const { override, crap } of result.staleOverrides) {
    lines.push(`  NOTE  ${override.file} ${override.function} is at ${rounded(crap).toFixed(2)}, inside the shared max ${sharedMax} — its override can go`);
  }
  const worst = result.worstShared;
  if (worst && rounded(worst.crap) < sharedMax) {
    lines.push(`  NOTE  shared max is ${sharedMax} but the worst function it covers is ${worst.name} at ${rounded(worst.crap).toFixed(2)} — lower it`);
  }
  if (result.failures.length === 0 && result.orphanOverrides.length === 0) lines.push("  OK    every function is within its pin");
  return lines.join("\n");
}
