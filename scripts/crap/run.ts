// `bun run crap` — measure, score, report, gate.
//
//   bun run crap                 run both suites under coverage, then score
//   bun run crap --report-only   score the counters from the last run
//   bun run crap -- --workers 2  anything after the known flags goes to playwright
//
// Exit status is the gate: 0 when every function is within its pin in
// .craprc.jsonc, 1 otherwise. The JSON record of the run lands in
// coverage/crap/report.json.
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { check, type CrapConfig } from "./check.ts";
import { measureComplexity } from "./cc.ts";
import { loadCoverage, relativize } from "./coverage.ts";
import { summary, verdict } from "./report.ts";
import { scoreAll } from "./score.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const OUT = join(ROOT, "coverage", "crap");
const PRELOAD = join(import.meta.dir, "preload.ts");
const CONFIG = join(ROOT, ".craprc.jsonc");

interface Args {
  reportOnly: boolean;
  playwright: string[];
}

function parseArgs(argv: string[]): Args {
  const args: Args = { reportOnly: false, playwright: [] };
  for (const a of argv) {
    if (a === "--report-only") args.reportOnly = true;
    else if (a !== "--") args.playwright.push(a);
  }
  return args;
}

async function run(cmd: string[], env: Record<string, string | undefined>): Promise<number> {
  const proc = Bun.spawn(cmd, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "inherit", stderr: "inherit" });
  return proc.exited;
}

/** A `bun` that every process the e2e suite spawns resolves to first, and that
 *  adds the coverage preload to `bun run`. The harness builds its environment
 *  from scratch — only PATH survives from ours — so PATH is the one channel
 *  that reaches the app under test without editing e2e/. */
function writeShim(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "bun");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      `export AGENDO_CRAP_COVERAGE_DIR=${JSON.stringify(OUT)}`,
      `if [ "$1" = run ]; then shift; exec ${JSON.stringify(process.execPath)} run --preload ${JSON.stringify(PRELOAD)} "$@"; fi`,
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
}

async function measure(playwrightArgs: string[]): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const env = { AGENDO_CRAP_COVERAGE_DIR: OUT };

  console.log("crap: unit suite under coverage");
  const unit = await run(["bun", "test", "--preload", PRELOAD, "test/"], env);
  if (unit !== 0) throw new Error(`bun test exited ${unit}`);

  const shimDir = join(OUT, "bin");
  writeShim(shimDir);
  console.log("crap: e2e suite under coverage");
  const e2e = await run(["./node_modules/.bin/playwright", "test", ...playwrightArgs], {
    ...env,
    PATH: `${shimDir}:${process.env.PATH ?? ""}`,
  });
  if (e2e !== 0) throw new Error(`playwright exited ${e2e}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.reportOnly) await measure(args.playwright);

  const config = (await import(CONFIG, { with: { type: "jsonc" } })).default as CrapConfig;
  const fns = await measureComplexity();
  const coverage = relativize(loadCoverage(OUT), ROOT);
  if (coverage.size === 0) throw new Error(`no coverage under ${OUT}; run without --report-only first`);
  const scored = scoreAll(fns, coverage);
  const result = check(scored, config);

  mkdirSync(OUT, { recursive: true });
  const reportPath = join(OUT, "report.json");
  writeFileSync(reportPath, JSON.stringify({ config, functions: scored }, null, 2));

  console.log(summary(scored));
  console.log("");
  console.log(verdict(result, config.max));
  console.log(`\n  full table: ${reportPath}`);
  return result.failures.length === 0 && result.orphanOverrides.length === 0 ? 0 : 1;
}

process.exit(await main());
