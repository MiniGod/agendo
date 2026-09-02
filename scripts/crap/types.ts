/** A position in a source file: 1-based line, 0-based UTF-16 column — istanbul's convention. */
export interface Pos {
  line: number;
  column: number;
}

export interface Range {
  start: Pos;
  end: Pos;
}

/** One function as oxlint's `complexity` rule sees it. */
export interface FunctionCc {
  /** Path relative to the repo root, e.g. `src/cli/send.ts`. */
  file: string;
  /** oxlint's name for the function, or null when it reports it anonymously. */
  name: string | null;
  range: Range;
  cc: number;
}

/** The subset of an istanbul file-coverage record the scorer reads. */
export interface FileCoverage {
  path: string;
  statementMap: Record<string, Range>;
  s: Record<string, number>;
  fnMap: Record<string, { name: string; decl: Range; loc: Range; line: number }>;
  f: Record<string, number>;
  hash?: string;
}

export type CoverageMap = Record<string, FileCoverage>;

export interface ScoredFunction {
  file: string;
  /** oxlint's name, or `(anonymous L<line>)` for a function it reports nameless. */
  name: string;
  line: number;
  cc: number;
  /** Statements that belong to this function and not to one nested inside it. */
  statements: number;
  covered: number;
  /** covered / statements, or the function's own hit flag when it has no statements. */
  coverage: number;
  crap: number;
}
