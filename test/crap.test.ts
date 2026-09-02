// The CRAP scorer's math and its gate contract. Both are pure, and both are
// invisible to e2e: the suite that PRODUCES the coverage cannot also be the
// test of what is done with it.
import { describe, expect, test } from "bun:test";
import { bytePos, parseDiagnostics } from "../scripts/crap/cc.ts";
import { check, rounded, type CrapConfig } from "../scripts/crap/check.ts";
import { mergeCoverage } from "../scripts/crap/coverage.ts";
import { contains, crap, scoreFile } from "../scripts/crap/score.ts";
import type { FileCoverage, FunctionCc, ScoredFunction } from "../scripts/crap/types.ts";

const pos = (line: number, column: number) => ({ line, column });
const range = (l1: number, c1: number, l2: number, c2: number) => ({ start: pos(l1, c1), end: pos(l2, c2) });

describe("crap()", () => {
  test("is cc^2 * (1 - cov)^3 + cc", () => {
    expect(crap(1, 0)).toBe(2);
    expect(crap(5, 0)).toBe(30);
    expect(crap(10, 0.5)).toBeCloseTo(22.5);
    expect(crap(4, 0.75)).toBeCloseTo(4.25);
  });
  test("full coverage leaves only the complexity", () => {
    for (const cc of [1, 7, 34, 47]) expect(crap(cc, 1)).toBe(cc);
  });
  test("the target: CRAP <= 7 at zero coverage means cc <= 2", () => {
    expect(crap(2, 0)).toBe(6);
    expect(crap(3, 0)).toBe(12);
  });
});

describe("scoreFile()", () => {
  // outer() spans lines 1-10 and owns statements on lines 2, 3 and 9;
  // inner() is nested on lines 4-8 and owns the statements on lines 5 and 6.
  const outer: FunctionCc = { file: "src/a.ts", name: "outer", range: range(1, 0, 10, 1), cc: 4 };
  const inner: FunctionCc = { file: "src/a.ts", name: null, range: range(4, 2, 8, 3), cc: 2 };
  const coverage: FileCoverage = {
    path: "/repo/src/a.ts",
    statementMap: {
      "0": range(2, 2, 2, 20),
      "1": range(3, 2, 3, 20),
      "2": range(5, 4, 5, 20),
      "3": range(6, 4, 6, 20),
      "4": range(9, 2, 9, 20),
    },
    s: { "0": 3, "1": 0, "2": 0, "3": 0, "4": 1 },
    fnMap: {
      "0": { name: "outer", decl: range(1, 9, 1, 14), loc: range(1, 17, 10, 1), line: 1 },
      "1": { name: "(anonymous_1)", decl: range(4, 2, 4, 3), loc: range(4, 8, 8, 3), line: 4 },
    },
    f: { "0": 3, "1": 0 },
  };

  test("a nested function's statements are its own, not the enclosing function's", () => {
    const [o, i] = scoreFile([outer, inner], coverage);
    expect(o).toMatchObject({ name: "outer", cc: 4, statements: 3, covered: 2 });
    expect(o.coverage).toBeCloseTo(2 / 3);
    expect(o.crap).toBeCloseTo(4 * 4 * (1 / 3) ** 3 + 4);
    expect(i).toMatchObject({ name: "(anonymous L4)", cc: 2, statements: 2, covered: 0, coverage: 0, crap: 6 });
  });

  test("a file no test ever loaded scores every function at zero coverage", () => {
    const [o] = scoreFile([outer], undefined);
    expect(o).toMatchObject({ statements: 0, covered: 0, coverage: 0, crap: 20 });
  });

  test("a function with no statements of its own is covered iff it was entered", () => {
    const empty: FunctionCc = { file: "src/a.ts", name: "noop", range: range(20, 0, 20, 30), cc: 1 };
    const enteredOnce: FileCoverage = {
      ...coverage,
      statementMap: {},
      s: {},
      fnMap: { "0": { name: "noop", decl: range(20, 9, 20, 13), loc: range(20, 16, 20, 30), line: 20 } },
      f: { "0": 1 },
    };
    expect(scoreFile([empty], enteredOnce)[0]).toMatchObject({ statements: 0, coverage: 1, crap: 1 });
    expect(scoreFile([empty], { ...enteredOnce, f: { "0": 0 } })[0]).toMatchObject({ coverage: 0, crap: 2 });
  });

  test("containment is half-open and column-aware", () => {
    const r = range(3, 4, 5, 2);
    expect(contains(r, pos(3, 4))).toBe(true);
    expect(contains(r, pos(3, 3))).toBe(false);
    expect(contains(r, pos(4, 0))).toBe(true);
    expect(contains(r, pos(5, 1))).toBe(true);
    expect(contains(r, pos(5, 2))).toBe(false);
  });
});

describe("check()", () => {
  const fn = (file: string, name: string, crapValue: number): ScoredFunction => ({
    file,
    name,
    line: 1,
    cc: 1,
    statements: 1,
    covered: 1,
    coverage: 1,
    crap: crapValue,
  });

  test("fails a function above the shared max and passes one at it", () => {
    const result = check([fn("src/a.ts", "over", 31.26), fn("src/a.ts", "at", 31.25)], { max: 31.25 });
    expect(result.failures.map((f) => f.fn.name)).toEqual(["over"]);
  });

  test("compares the value the report prints, not the raw float", () => {
    expect(rounded(31.254)).toBe(31.25);
    expect(check([fn("src/a.ts", "f", 31.254)], { max: 31.25 }).failures).toHaveLength(0);
    expect(check([fn("src/a.ts", "f", 31.255)], { max: 31.25 }).failures).toHaveLength(1);
  });

  test("an override replaces the shared max for exactly the function it names", () => {
    const config: CrapConfig = { max: 10, overrides: [{ file: "src/a.ts", function: "big", max: 100 }] };
    const result = check([fn("src/a.ts", "big", 99), fn("src/b.ts", "big", 11), fn("src/a.ts", "small", 3)], config);
    expect(result.failures.map((f) => `${f.fn.file} ${f.fn.name}`)).toEqual(["src/b.ts big"]);
    expect(result.worstShared?.name).toBe("big");
    expect(result.worstShared?.file).toBe("src/b.ts");
  });

  test("an override for a function that no longer exists is a failure", () => {
    const config: CrapConfig = { max: 10, overrides: [{ file: "src/a.ts", function: "gone", max: 100 }] };
    const result = check([fn("src/a.ts", "here", 1)], config);
    expect(result.orphanOverrides).toEqual(config.overrides!);
  });

  test("an override whose function now fits the shared max is reported as stale", () => {
    const config: CrapConfig = { max: 10, overrides: [{ file: "src/a.ts", function: "shrunk", max: 100 }] };
    const result = check([fn("src/a.ts", "shrunk", 9)], config);
    expect(result.staleOverrides.map((s) => s.override.function)).toEqual(["shrunk"]);
    expect(result.failures).toHaveLength(0);
  });
});

describe("oxlint diagnostics", () => {
  test("byte offsets map to lines and UTF-16 columns past non-ASCII text", () => {
    const src = Buffer.from("// — dash\nconst x = 1;\nfunction f() {}\n", "utf-8");
    expect(bytePos(src, 0)).toEqual(pos(1, 0));
    // "— " is 3 bytes + 1; the `d` of dash is byte 7 but UTF-16 column 5.
    expect(bytePos(src, 7)).toEqual(pos(1, 5));
    const fnOffset = src.indexOf("function");
    expect(bytePos(src, fnOffset)).toEqual(pos(3, 0));
    expect(bytePos(src, fnOffset + "function f() {}".length)).toEqual(pos(3, 15));
  });

  test("reads the name, the number and the span; ignores every other rule", () => {
    const src = Buffer.from("export function f() {\n  return 1;\n}\nconst g = () => 2;\n", "utf-8");
    const json = JSON.stringify({
      diagnostics: [
        { message: "function `f` has a complexity of 1. Maximum allowed is 0.", code: "eslint(complexity)", filename: "src/x.ts", labels: [{ span: { offset: 7, length: 28 } }] },
        { message: "async function has a complexity of 3. Maximum allowed is 0.", code: "eslint(complexity)", filename: "src/x.ts", labels: [{ span: { offset: 46, length: 7 } }] },
        { message: "class field initializer has a complexity of 2. Maximum allowed is 0.", code: "eslint(complexity)", filename: "src/x.ts", labels: [{ span: { offset: 0, length: 1 } }] },
        { message: "unused", code: "eslint(no-unused-vars)", filename: "src/x.ts", labels: [{ span: { offset: 0, length: 1 } }] },
      ],
    });
    const fns = parseDiagnostics(json, () => src);
    expect(fns).toHaveLength(3);
    expect(fns[0]).toEqual({ file: "src/x.ts", name: "f", cc: 1, range: range(1, 7, 3, 1) });
    expect(fns[1]).toMatchObject({ name: null, cc: 3, range: { start: pos(4, 10) } });
    expect(fns[2]).toMatchObject({ name: null, cc: 2 });
  });
});

describe("mergeCoverage()", () => {
  const fc = (s: Record<string, number>, hash = "h1"): FileCoverage => ({
    path: "/repo/src/a.ts",
    statementMap: { "0": range(1, 0, 1, 5) },
    s,
    fnMap: {},
    f: { "0": s["0"] ?? 0 },
    hash,
  });

  test("sums counters across processes", () => {
    const merged = mergeCoverage([{ "/repo/src/a.ts": fc({ "0": 2 }) }, { "/repo/src/a.ts": fc({ "0": 3 }) }]);
    expect(merged["/repo/src/a.ts"].s).toEqual({ "0": 5 });
    expect(merged["/repo/src/a.ts"].f).toEqual({ "0": 5 });
  });

  test("does not sum dumps of two different versions of a file", () => {
    const warnings: string[] = [];
    const merged = mergeCoverage([{ "/repo/src/a.ts": fc({ "0": 2 }) }, { "/repo/src/a.ts": fc({ "0": 3 }, "h2") }], (m) => warnings.push(m));
    expect(merged["/repo/src/a.ts"].s).toEqual({ "0": 2 });
    expect(warnings).toHaveLength(1);
  });

  test("does not mutate its inputs", () => {
    const a = { "/repo/src/a.ts": fc({ "0": 2 }) };
    mergeCoverage([a, { "/repo/src/a.ts": fc({ "0": 3 }) }]);
    expect(a["/repo/src/a.ts"].s).toEqual({ "0": 2 });
  });
});
