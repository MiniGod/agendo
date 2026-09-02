// Cyclomatic complexity per function, taken from oxlint rather than recomputed:
// the `complexity` rule in .oxlintrc.json and the cc in a CRAP score must be
// the same number, or a function can pass one gate and fail the other for no
// reason a reader can see. Running oxlint with the threshold at 0 makes it
// report every function, and `--format json` includes the number and the span.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FunctionCc, Pos } from "./types.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const CONFIG = join(import.meta.dir, "oxlint-cc.json");
// "function `foo` has…", "async function has…", "method `bar` has…", "class
// field initializer has…", "getter `x` has…": a kind, an optional name, a number.
const MESSAGE = /^[a-z ]+?(?: `(.+?)`)? has a complexity of (\d+)\./;

interface Diagnostic {
  message: string;
  code: string;
  filename: string;
  labels: { span: { offset: number; length: number } }[];
}

/** oxlint spans are UTF-8 byte offsets; istanbul positions are lines and UTF-16 columns. */
export function bytePos(source: Buffer, offset: number): Pos {
  const text = source.subarray(0, offset).toString("utf-8");
  const nl = text.lastIndexOf("\n");
  return { line: (text.match(/\n/g)?.length ?? 0) + 1, column: text.length - (nl + 1) };
}

export function parseDiagnostics(json: string, readSource: (file: string) => Buffer): FunctionCc[] {
  const { diagnostics } = JSON.parse(json) as { diagnostics: Diagnostic[] };
  const sources = new Map<string, Buffer>();
  const out: FunctionCc[] = [];
  for (const d of diagnostics) {
    if (d.code !== "eslint(complexity)") continue;
    const m = MESSAGE.exec(d.message);
    const span = d.labels[0]?.span;
    if (!m || !span) throw new Error(`unrecognised oxlint complexity diagnostic: ${JSON.stringify(d)}`);
    let src = sources.get(d.filename);
    if (!src) sources.set(d.filename, (src = readSource(d.filename)));
    out.push({
      file: d.filename,
      name: m[1] ?? null,
      range: { start: bytePos(src, span.offset), end: bytePos(src, span.offset + span.length) },
      cc: Number(m[2]),
    });
  }
  return out;
}

/** Every function under `src/`, with its complexity. */
export async function measureComplexity(): Promise<FunctionCc[]> {
  const proc = Bun.spawn(["./node_modules/.bin/oxlint", "-c", CONFIG, "--format", "json", "src/"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  if (!stdout.trimStart().startsWith("{")) throw new Error(`oxlint produced no JSON:\n${stdout}\n${stderr}`);
  return parseDiagnostics(stdout, (file) => readFileSync(join(ROOT, file)));
}
