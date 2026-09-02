// Bun runtime plugin that instruments `src/**` for coverage while a test suite
// runs the real app. Loaded with `bun run --preload scripts/crap/preload.ts …`
// (or `bun test --preload …`), never by the product itself: `package.json`
// ships only `src/`, and nothing in `src/` knows this file exists.
//
// Why a plugin and not `bun --coverage`: bun's own coverage exists only for
// `bun test`, and the behaviour suite is Playwright driving `bun run
// src/index.tsx` as a child process — a PTY for the TUI, spawnSync for the CLI.
// The plugin hooks bun's module loader inside THOSE processes and hands it an
// istanbul-instrumented copy of every `src/` module, so the counters land in
// the same `__coverage__` object istanbul tooling expects. Positions in the
// output refer to the ORIGINAL source (babel parses the TypeScript directly, no
// transpile step in between), which is what lets scripts/crap/score.ts line the
// statements up against the function spans oxlint reports.
//
// The instrumented text is cached on disk by content hash. The suite starts the
// app several hundred times, and instrumenting ~145 files from scratch costs
// about 1.5 s per process; with the cache a process pays only for files that
// changed since the last one.
//
// Configuration is one environment variable, AGENDO_CRAP_COVERAGE_DIR: where to
// write the counters on exit. Unset, this file does nothing at all.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT_DIR = process.env.AGENDO_CRAP_COVERAGE_DIR;
const ROOT = resolve(import.meta.dir, "..", "..");
const SRC = join(ROOT, "src") + "/";
// Bump when the instrumenter's options change; stale cache entries are otherwise
// indistinguishable from fresh ones.
const CACHE_VERSION = "1";

type Instrumenter = { instrumentSync(code: string, filename: string): string };
let instrumenter: Promise<Instrumenter> | undefined;
function getInstrumenter(): Promise<Instrumenter> {
  instrumenter ??= import("istanbul-lib-instrument").then((m) =>
    m.createInstrumenter({
      esModules: true,
      compact: false,
      produceSourceMap: false,
      parserPlugins: ["typescript", "jsx", "topLevelAwait", "importAttributes"],
    }),
  );
  return instrumenter;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Instrumented source for `path`, from the on-disk cache when the content matches. */
async function instrumented(path: string, cacheDir: string): Promise<string> {
  const source = readFileSync(path, "utf-8");
  const key = createHash("sha1").update(`${CACHE_VERSION}\0${path}\0`).update(source).digest("hex");
  const cached = join(cacheDir, key);
  try {
    return readFileSync(cached, "utf-8");
  } catch {
    /* miss */
  }
  const out = (await getInstrumenter()).instrumentSync(source, path);
  mkdirSync(cacheDir, { recursive: true });
  // Write-then-rename so a parallel process never reads a half-written entry.
  const tmp = `${cached}.${process.pid}.tmp`;
  writeFileSync(tmp, out);
  renameSync(tmp, cached);
  return out;
}

function install(outDir: string): void {
  const cacheDir = join(outDir, ".cache");
  Bun.plugin({
    name: "crap-coverage",
    setup(build) {
      build.onLoad({ filter: new RegExp(`^${escapeRegExp(SRC)}.*(?<!\\.d)\\.tsx?$`) }, async ({ path }) => ({
        contents: await instrumented(path, cacheDir),
        loader: path.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  });

  const target = join(outDir, `${process.pid}-${Date.now()}.json`);
  const dump = (): void => {
    const cov = (globalThis as { __coverage__?: unknown }).__coverage__;
    if (!cov) return;
    try {
      mkdirSync(outDir, { recursive: true });
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, JSON.stringify(cov));
      renameSync(tmp, target);
    } catch {
      /* a dump that fails must never take the app down with it */
    }
  };
  process.on("exit", dump);

  // A process killed by a signal never reaches "exit". The harness ends the TUI
  // with SIGHUP (node-pty's kill) and the CLI with SIGTERM (child.kill), so
  // those runs would otherwise vanish. Dump, then hand the signal back: if we
  // are the only listener, drop out and re-raise so the process still dies of
  // the signal exactly as it would have; if the app registered its own
  // handler, leave the decision to it.
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"] as const) {
    const handler = (): void => {
      dump();
      if (process.listenerCount(sig) === 1) {
        process.removeListener(sig, handler);
        process.kill(process.pid, sig);
      }
    };
    process.on(sig, handler);
  }
}

if (OUT_DIR) install(OUT_DIR);
