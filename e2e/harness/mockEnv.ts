// Assembles a fully isolated environment for one launcher run:
//   • a throwaway temp dir used as $HOME (sessions + config live here)
//   • the fake-bin shims (az/tmux/git/claude/xdg-open) first on $PATH
//   • a mock Azure DevOps server, wired in via ADO_BASE_URL / ADO_VSSPS_URL
//   • fake-tmux state + call-log files for deterministic "running" state and
//     post-hoc assertions on what the launcher tried to spawn
// Nothing here touches the real machine: no real tmux server, no az login, no
// git repos, no network. `cleanup()` tears it all down.
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { materializeHome, tmuxState as initialTmuxState } from "./fixtures.ts";
import { startAdoServer, type AdoServer, type RawFault } from "./adoServer.ts";
import { trackDir, untrackDir } from "./reaper.ts";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HARNESS_DIR, "..", ".."); // e2e/harness -> repo root
const FAKE_BIN = join(REPO_ROOT, "e2e", "fakebin");

export interface MockEnv {
  /** Env to hand the launcher process (HOME, PATH, ADO_*, FAKE_*; TMUX unset). */
  env: Record<string, string>;
  home: string;
  tmpDir: string;
  ado: AdoServer;
  /** Overwrite the fake-tmux state (e.g. to flip a session to "running"). */
  setTmuxState(state: unknown): Promise<void>;
  /** Read the fake-tmux state back — mutating commands (new-window, kill-window)
   *  write to it, so this is how a test asserts what is still live afterwards. */
  getTmuxState(): Promise<any>;
  /** Overwrite the fake-`gh` state (auth flag + user + issue/PR/GraphQL fixtures).
   *  Also clears the fake's GraphQL sequence counter, so re-seeding mid-test
   *  starts any array fixture from its first element again — without that, a
   *  second `setGhState` in one test would resume the previous call count and
   *  overrun a fresh sequence immediately. */
  setGhState(state: unknown): Promise<void>;
  /** Switch the persisted backend (writes ~/.agendo/state.json). */
  setProvider(name: "ado" | "github"): Promise<void>;
  /** Patch an ADO PR's mutable fields at runtime (status/isDraft/title/…), so a
   *  test can change them between reloads to prove the app re-fetches PR state. */
  setAdoPr(id: number, patch: Record<string, unknown>): void;
  /** Force the mock ADO server's response for paths matching `match` — used to
   *  reproduce backend states the fixtures can't express (an endpoint that 404s,
   *  an empty collection). In-process like setAdoPr, so it takes effect on the
   *  launcher's very next request and can be changed between reloads. */
  setAdoResponse(match: RegExp, response: { status?: number; body?: unknown }): void;
  /** Like setAdoResponse but the body is sent VERBATIM — for a response that
   *  deliberately isn't JSON (an HTML sign-in page), or that needs `times` /
   *  `delayMs` to let an automatic retry succeed or stay observable. */
  setAdoRaw(match: RegExp, response: RawFault): void;
  /** Argv arrays of every fake-tmux invocation, in order. */
  tmuxLog(): Promise<string[][]>;
  /** Raw lines of the shared call log (az/gh/git/claude/xdg-open invocations). */
  callLog(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export async function createMockEnv(): Promise<MockEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), "agendo-e2e-"));
  trackDir(tmpDir); // reaped on abnormal exit if cleanup() never runs
  const home = join(tmpDir, "home");
  await materializeHome(home);

  const tmuxStatePath = join(tmpDir, "tmux-state.json");
  const tmuxLogPath = join(tmpDir, "tmux-log.txt");
  const callLogPath = join(tmpDir, "call-log.txt");
  const ghStatePath = join(tmpDir, "gh-state.json");
  await writeFile(tmuxStatePath, JSON.stringify(initialTmuxState, null, 2));
  await writeFile(tmuxLogPath, "");
  await writeFile(callLogPath, "");
  // Default: GitHub CLI present but not logged in. ADO-mode tests only hit this
  // on the Settings page (its per-provider auth probe), where it must be a
  // deterministic "not authenticated" rather than whatever the real `gh` reports.
  await writeFile(ghStatePath, JSON.stringify({ authed: false }, null, 2));

  const ado = await startAdoServer();

  // Start from a clean slate: only the vars the launcher needs, real PATH dirs
  // kept (so `bun`, `node`, `bash` resolve) but with the fake bin FIRST so our
  // shims win. TMUX is deliberately absent → the app takes its outside-tmux path.
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${FAKE_BIN}:${process.env.PATH ?? ""}`,
    TERM: "xterm-256color",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ADO_BASE_URL: ado.baseUrl,
    ADO_VSSPS_URL: ado.vsspsUrl,
    ADO_GRAPH_URL: ado.graphUrl,
    FAKE_TMUX_STATE: tmuxStatePath,
    FAKE_TMUX_LOG: tmuxLogPath,
    FAKE_CALL_LOG: callLogPath,
    FAKE_GH_STATE: ghStatePath,
    // Force interactive color so Ink emits ANSI even though stdout is a PTY pipe.
    FORCE_COLOR: "3",
  };

  const parseLog = async (path: string): Promise<string[]> => {
    const raw = await readFile(path, "utf-8").catch(() => "");
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  };

  return {
    env,
    home,
    tmpDir,
    ado,
    setTmuxState: (state) => writeFile(tmuxStatePath, JSON.stringify(state, null, 2)),
    getTmuxState: async () => JSON.parse(await readFile(tmuxStatePath, "utf-8")),
    setGhState: async (state) => {
      // Order matters: drop the counters first, so a `gh` call that races the
      // re-seed can only ever see (old state, old counter) or (new, reset) —
      // never the new fixtures indexed by the old call count.
      await rm(`${ghStatePath}.seq`, { recursive: true, force: true });
      await writeFile(ghStatePath, JSON.stringify(state, null, 2));
    },
    setProvider: (name) => writeFile(join(home, ".agendo", "state.json"), JSON.stringify({ provider: name }, null, 2)),
    setAdoPr: (id, patch) => ado.setPr(id, patch),
    setAdoResponse: (match, response) => ado.setResponse(match, response),
    setAdoRaw: (match, response) => ado.setRaw(match, response),
    tmuxLog: async () => (await parseLog(tmuxLogPath)).map((l) => JSON.parse(l) as string[]),
    callLog: () => parseLog(callLogPath),
    async cleanup() {
      await ado.close();
      // `maxRetries` rides out a transient `ENOTEMPTY`/`EBUSY` if a just-killed
      // launcher writes into the tree as we delete it (belt-and-suspenders — the
      // terminal is already awaited to full exit in WebTerminal.close).
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      untrackDir(tmpDir);
    },
  };
}
