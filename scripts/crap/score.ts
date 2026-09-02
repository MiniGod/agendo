// The scoring itself, kept free of I/O so test/crap.test.ts can pin the math.
//
//   CRAP(m) = cc(m)^2 * (1 - cov(m))^3 + cc(m)
//
// (Savoia & Dunlop's Change Risk Anti-Patterns). cc is the cyclomatic
// complexity oxlint reports; cov is the fraction of the function's OWN
// statements that ran under the test suites — statements inside a nested
// function are that function's, the same way eslint's complexity rule does not
// charge an outer function for branches in an inner one. A function with no
// statements of its own (an empty body) falls back to whether it was entered.
import type { FileCoverage, FunctionCc, Pos, Range, ScoredFunction } from "./types.ts";

export function crap(cc: number, coverage: number): number {
  return cc * cc * (1 - coverage) ** 3 + cc;
}

function before(a: Pos, b: Pos): boolean {
  return a.line < b.line || (a.line === b.line && a.column < b.column);
}

/** Half-open containment: `start <= p < end`. */
export function contains(range: Range, p: Pos): boolean {
  return !before(p, range.start) && before(p, range.end);
}

function within(outer: Range, inner: Range): boolean {
  return (
    outer !== inner &&
    !before(inner.start, outer.start) &&
    !before(outer.end, inner.end) &&
    (before(outer.start, inner.start) || before(inner.end, outer.end))
  );
}

export function displayName(fn: FunctionCc): string {
  return fn.name ?? `(anonymous L${fn.range.start.line})`;
}

/** Score every function in one file against that file's coverage (undefined
 *  when no test ever loaded the file, which scores as zero coverage). */
export function scoreFile(fns: FunctionCc[], cov: FileCoverage | undefined): ScoredFunction[] {
  const statements = cov ? Object.entries(cov.statementMap).map(([id, range]) => ({ pos: range.start, hits: cov.s[id] ?? 0 })) : [];
  const entered = cov ? Object.entries(cov.fnMap).map(([id, fn]) => ({ pos: fn.decl.start, hits: cov.f[id] ?? 0 })) : [];
  return fns.map((fn) => {
    const nested = fns.filter((other) => within(fn.range, other.range)).map((o) => o.range);
    const own = statements.filter((s) => contains(fn.range, s.pos) && !nested.some((n) => contains(n, s.pos)));
    const covered = own.filter((s) => s.hits > 0).length;
    let coverage: number;
    if (own.length > 0) coverage = covered / own.length;
    else if (!cov) coverage = 0;
    else coverage = entered.some((e) => contains(fn.range, e.pos) && !nested.some((n) => contains(n, e.pos)) && e.hits > 0) ? 1 : 0;
    return {
      file: fn.file,
      name: displayName(fn),
      line: fn.range.start.line,
      cc: fn.cc,
      statements: own.length,
      covered,
      coverage,
      crap: crap(fn.cc, coverage),
    };
  });
}

export function scoreAll(fns: FunctionCc[], coverage: Map<string, FileCoverage>): ScoredFunction[] {
  const byFile = new Map<string, FunctionCc[]>();
  for (const fn of fns) {
    let list = byFile.get(fn.file);
    if (!list) byFile.set(fn.file, (list = []));
    list.push(fn);
  }
  const out: ScoredFunction[] = [];
  for (const [file, list] of byFile) out.push(...scoreFile(list, coverage.get(file)));
  return out.sort((a, b) => b.crap - a.crap || a.file.localeCompare(b.file) || a.line - b.line);
}
