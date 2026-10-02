// Loaded before every `bun test` file (bunfig.toml). Makes the unit suite
// hermetic with respect to tmux and the agent CLIs, and fails the test that
// breaks that — see scripts/hermetic.ts for why it has to.
//
//   • `$TMUX`/`$TMUX_PANE` are dropped and `$TMUX_TMPDIR` points somewhere no
//     tmux server can live, so nothing can target the server the suite was
//     started from — not even the real tmux, if a call gets past the fakes.
//   • `Bun.spawn`, `Bun.spawnSync` and `Bun.which` are made to read that
//     environment too; left alone they use the one the process started with,
//     and skip all of this.
//   • fake `tmux`, `claude`, `codex` and `copilot` go first on PATH. They record
//     their argv and exit 1, so a launch path that slips past a stub runs
//     nothing at all.
//   • after every test, any recorded call that would have created, killed or
//     sent to a tmux target, or run an agent, fails THAT test by name; one made
//     outside any test body fails the run at the end.
import { afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { bunWithLiveEnv, isEscape, isolateTmux, readCalls, removeDir, writeGuardBin } from "../scripts/hermetic.ts";

isolateTmux(process.env);
bunWithLiveEnv();
const root = mkdtempSync(join(tmpdir(), "agendo-guard-"));
const guard = writeGuardBin(root);
/** Where the fakes live, so a test can check the fence is up before leaning on it. */
export const guardBinDir = guard.dir;
process.env.PATH = `${guard.dir}${delimiter}${process.env.PATH ?? ""}`;

/** Everything the fakes recorded since the last call, then forget it. A test
 *  that provokes an escape on purpose (to prove the guard) drains it here. */
export function takeGuardCalls(): string[][] {
  return readCalls(guard.calls);
}

const describeEscapes = (escapes: string[][]) => escapes.map((argv) => `  ${argv.join(" ")}`).join("\n");

/** Escapes recorded while no test was running — at a file's top level, in a
 *  `beforeAll`/`afterAll`, or by a child an earlier test left running, when
 *  its call lands between tests. Blaming the next test for them would point at
 *  the wrong code, so they are held for the end of the run. A straggler whose
 *  call lands DURING a later test is indistinguishable from that test's own
 *  call, and is reported against it — hence the hint in that message. */
const unattributed: string[][] = [];

beforeEach(() => {
  unattributed.push(...takeGuardCalls().filter(isEscape));
});

afterEach(() => {
  const escapes = takeGuardCalls().filter(isEscape);
  if (escapes.length === 0) return;
  throw new Error(
    "test reached tmux or an agent CLI outside the test's control (or a child an earlier test left running did) — stub the launch path instead:\n" +
      describeEscapes(escapes),
  );
});

// Once, after the last file: bun test never emits the process `exit` event.
afterAll(() => {
  unattributed.push(...takeGuardCalls().filter(isEscape));
  removeDir(root);
  if (unattributed.length === 0) return;
  process.exitCode = 1;
  throw new Error(
    "something outside a test body reached tmux or an agent CLI (a file's top level, a beforeAll/afterAll, or a child an earlier test left running):\n" +
      describeEscapes(unattributed),
  );
});
