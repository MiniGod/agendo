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
import { startAdoServer, type AdoServer } from "./adoServer.ts";
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
  /** Overwrite the fake-`gh` state (auth flag + user + issue/PR fixtures). */
  setGhState(state: unknown): Promise<void>;
  /** Switch the persisted backend (writes ~/.clops/state.json). */
  setProvider(name: "ado" | "github"): Promise<void>;
  /** Argv arrays of every fake-tmux invocation, in order. */
  tmuxLog(): Promise<string[][]>;
  /** Raw lines of the shared call log (az/gh/git/claude/xdg-open invocations). */
  callLog(): Promise<string[]>;
  cleanup(): Promise<void>;
}

export async function createMockEnv(): Promise<MockEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), "clops-e2e-"));
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
    setGhState: (state) => writeFile(ghStatePath, JSON.stringify(state, null, 2)),
    setProvider: (name) => writeFile(join(home, ".clops", "state.json"), JSON.stringify({ provider: name }, null, 2)),
    tmuxLog: async () => (await parseLog(tmuxLogPath)).map((l) => JSON.parse(l) as string[]),
    callLog: () => parseLog(callLogPath),
    async cleanup() {
      await ado.close();
      await rm(tmpDir, { recursive: true, force: true });
      untrackDir(tmpDir);
    },
  };
}
