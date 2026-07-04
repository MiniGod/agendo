// "wterm" — a web terminal for end-to-end testing a TUI in a real browser,
// built on @wterm/dom (Vercel Labs' Zig→WASM DOM terminal emulator).
//
// How it works:
//   1. The launcher is spawned in a pseudo-terminal (node-pty) at a fixed size,
//      so Ink sees a real TTY and emits its normal ANSI frames.
//   2. The test page hosts a @wterm/dom `WTerm` (one long-lived instance backed
//      by the WASM VT state machine).
//   3. PTY output is streamed to that terminal as it arrives — byte deltas are
//      forwarded in order (writes are serialized) so the emulator state always
//      matches what a real terminal would show.
//   4. The screen is read straight from the WASM grid (`bridge.getCell`), and
//      keystrokes are written straight to the PTY.
//
// Playwright drives and asserts against the launcher's UI as it actually renders
// in a browser, and can screenshot the DOM terminal.
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { trackPty, untrackPty, trackDir } from "./reaper.ts";

const require = createRequire(import.meta.url);
// node-pty is a CJS native addon — require() avoids ESM-interop pitfalls.
const pty = require("node-pty") as typeof import("node-pty");

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
// @wterm/dom's exports map doesn't expose package.json, so derive the package
// root from its main entry (…/@wterm/dom/dist/index.js → …/@wterm/dom).
const wtermDomDir = join(dirname(require.resolve("@wterm/dom")), "..");
const WTERM_CSS = readFileSync(join(wtermDomDir, "src", "terminal.css"), "utf-8");

// The @wterm/dom + @wterm/core ESM (with its inlined WASM) bundled for the
// browser via bun. Built once per process, lazily, and cached.
let cachedBundle: string | null = null;
function browserBundle(): string {
  if (cachedBundle) return cachedBundle;
  const dir = mkdtempSync(join(tmpdir(), "wterm-bundle-"));
  trackDir(dir); // removed on process exit (it's only needed in-memory after read)
  const out = join(dir, "bundle.js");
  execFileSync(
    "bun",
    ["build", join(HARNESS_DIR, "wterm-browser-entry.ts"), "--target=browser", "--outfile", out],
    { stdio: "pipe" },
  );
  cachedBundle = readFileSync(out, "utf-8");
  return cachedBundle;
}

/** Key escape sequences to write to the PTY. */
export const KEY = {
  enter: "\r",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  tab: "\t",
  shiftTab: "\x1b[Z",
  escape: "\x1b",
  backspace: "\x7f",
  ctrlC: "\x03",
} as const;

/** One merged run of same-styled cells, as read from the WASM bridge. */
interface StyleRun {
  text: string;
  fg: number;
  bg: number;
  flags: number;
}

// wterm uses 256 for the terminal default fg/bg; 0-15 are the ANSI palette.
const COLOR: Record<number, string> = {
  0: "black", 1: "red", 2: "green", 3: "yellow", 4: "blue", 5: "magenta",
  6: "cyan", 7: "white", 8: "gray", 9: "brightRed", 10: "brightGreen",
  11: "brightYellow", 12: "brightBlue", 13: "brightMagenta", 14: "brightCyan",
  15: "brightWhite", 256: "default",
};
const colorName = (n: number) => COLOR[n] ?? `c${n}`;

// Inline style tag for a run, e.g. `⟨blue,bold⟩` — empty when fully default.
function styleTag(run: StyleRun): string {
  const parts: string[] = [];
  if (run.fg !== 256) parts.push(colorName(run.fg));
  if (run.bg !== 256) parts.push(`bg:${colorName(run.bg)}`);
  if (run.flags & 1) parts.push("bold");
  if (run.flags & 2) parts.push("dim");
  return parts.length ? `⟨${parts.join(",")}⟩` : "";
}

function formatStyledRow(runs: StyleRun[]): string {
  let line = "";
  for (const run of runs) {
    const tag = styleTag(run);
    line += tag ? run.text + tag : run.text;
  }
  return line.replace(/\s+$/, ""); // drop trailing default padding
}

export interface LaunchOptions {
  page: Page;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

function pageHtml(cols: number, rows: number, bundle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>${WTERM_CSS}
  html,body{margin:0;background:#0b0e14}
  #term{padding:8px;display:inline-block}
</style></head><body>
<div id="term"></div>
<script>${bundle}</script>
<script>
  (async () => {
    const term = new WTerm(document.getElementById('term'), {
      cols: ${cols}, rows: ${rows}, autoResize: false, cursorBlink: false,
    });
    await term.init();
    window.__term = term;
    // Write a byte delta (called in order from Node).
    window.__write = (data) => term.write(data);
    // Read the visible grid straight from the WASM bridge as plain text.
    window.__readScreen = () => {
      const core = term.bridge;
      const R = core.getRows(), C = core.getCols();
      const lines = [];
      for (let r = 0; r < R; r++) {
        let s = "";
        for (let c = 0; c < C; c++) {
          const ch = core.getCell(r, c).char;
          s += ch ? String.fromCodePoint(ch) : " ";
        }
        lines.push(s.replace(/\\s+$/, ""));
      }
      return lines.join("\\n");
    };
    // Read the grid as style runs (text + fg/bg/flags) so colors/attributes can
    // be snapshotted, not just characters. Adjacent same-style cells are merged.
    window.__readRuns = () => {
      const core = term.bridge;
      const R = core.getRows(), C = core.getCols();
      const rows = [];
      for (let r = 0; r < R; r++) {
        const runs = []; let cur = null;
        for (let c = 0; c < C; c++) {
          const cell = core.getCell(r, c);
          const ch = cell.char ? String.fromCodePoint(cell.char) : " ";
          if (cur && cur.fg === cell.fg && cur.bg === cell.bg && cur.flags === cell.flags) cur.text += ch;
          else { cur = { text: ch, fg: cell.fg, bg: cell.bg, flags: cell.flags }; runs.push(cur); }
        }
        rows.push(runs);
      }
      return rows;
    };
    window.__ready = true;
  })();
</script></body></html>`;
}

export class WebTerminal {
  private constructor(
    private readonly page: Page,
    private readonly proc: import("node-pty").IPty,
    private readonly server: Server,
    readonly cols: number,
    readonly rows: number,
  ) {}

  private raw = "";
  private flushed = 0;
  private chain: Promise<void> = Promise.resolve();
  private exited = false;
  exitCode: number | null = null;

  static async launch(opts: LaunchOptions): Promise<WebTerminal> {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    const html = pageHtml(cols, rows, browserBundle());
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" }).end(html);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;

    const proc = pty.spawn(opts.command, opts.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: opts.env,
    });

    const wt = new WebTerminal(opts.page, proc, server, cols, rows);
    trackPty(proc); // reaped on abnormal exit so a leaked PTY can't busy-spin
    proc.onData((d) => (wt.raw += d));
    proc.onExit(({ exitCode }) => {
      wt.exited = true;
      wt.exitCode = exitCode;
    });

    await opts.page.goto(`http://127.0.0.1:${port}/`);
    await opts.page.waitForFunction(() => (window as any).__ready === true);
    return wt;
  }

  /** Write raw bytes (or a KEY sequence) to the PTY. */
  write(data: string): void {
    if (!this.exited) this.proc.write(data);
  }

  /**
   * Press a key, then settle. Ink's input handler closes over the `cursor`/
   * `rows` from its last render, so two keystrokes fired before React commits
   * the first both act on stale state. A human types slower; `press` reproduces
   * that pause so multi-step navigation stays deterministic.
   */
  async press(data: string, settleMs = 200): Promise<void> {
    this.write(data);
    await this.page.waitForTimeout(settleMs);
  }

  /** Forward any not-yet-sent PTY bytes to the browser terminal, in order. */
  private flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const delta = this.raw.slice(this.flushed);
      if (!delta) return;
      this.flushed = this.raw.length;
      await this.page.evaluate((d) => (window as any).__write(d), delta);
    });
    return this.chain;
  }

  /** Flush pending output, then read the terminal's visible grid as text. */
  async screen(): Promise<string> {
    await this.flush();
    return this.page.evaluate(() => (window as any).__readScreen());
  }

  /**
   * Flush, then read the visible grid as a *styled* text grid: each line is the
   * text with inline `⟨color,attr⟩` tags on any non-default run. Deterministic
   * (read from the WASM cell buffer), so it snapshots characters AND colors with
   * readable diffs — unlike a pixel screenshot.
   */
  async styled(): Promise<string> {
    await this.flush();
    const rows: StyleRun[][] = await this.page.evaluate(() => (window as any).__readRuns());
    return rows.map(formatStyledRow).join("\n");
  }

  /** Poll until the rendered screen contains `needle`, or throw on timeout. */
  async waitForText(needle: string | RegExp, timeoutMs = 8000): Promise<string> {
    const start = Date.now();
    let last = "";
    while (Date.now() - start < timeoutMs) {
      last = await this.screen();
      const hit = typeof needle === "string" ? last.includes(needle) : needle.test(last);
      if (hit) return last;
      await this.page.waitForTimeout(80);
    }
    throw new Error(
      `waitForText timed out after ${timeoutMs}ms waiting for ${needle}\n--- last screen ---\n${last}`,
    );
  }

  /** Wait until the screen stops changing for `quietMs` (UI settled). */
  async waitForStable(quietMs = 300, timeoutMs = 5000): Promise<string> {
    const start = Date.now();
    let prev = await this.screen();
    let stableSince = Date.now();
    while (Date.now() - start < timeoutMs) {
      await this.page.waitForTimeout(80);
      const cur = await this.screen();
      if (cur === prev) {
        if (Date.now() - stableSince >= quietMs) return cur;
      } else {
        prev = cur;
        stableSince = Date.now();
      }
    }
    return prev;
  }

  /** Flush + let the DOM renderer paint, then screenshot the browser. */
  async screenshot(path: string): Promise<void> {
    await this.screen();
    await this.page.waitForTimeout(80); // let the rAF render land
    await this.page.screenshot({ path });
  }

  async close(): Promise<void> {
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    // Wait for the launcher to ACTUALLY exit before returning. Otherwise the
    // fixture's temp-dir removal (mockEnv.cleanup) can race a final write from
    // the still-dying process — most notably `captureRestore` flushing
    // `~/.agendo/restore/*.json` into the temp tree — which surfaces as an
    // intermittent `ENOTEMPTY` rmdir under CI's parallel workers. A short
    // timeout keeps teardown from hanging if exit is never reported.
    if (!this.exited) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        this.proc.onExit(done);
        setTimeout(done, 2000);
      });
    }
    untrackPty(this.proc);
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
