// The fence test/preload.ts puts around every unit test (scripts/hermetic.ts).
// test/listNav.test.ts once resumed a real session from a key-handler test,
// opening a live `cl-claude-s1` window on the developer's tmux server; these pin
// that the fence is up, and that it catches that exact call.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { AGENT_BINARIES, DEAD_TMUX_TMPDIR, isEscape, readCalls, removeDir, tmuxCommands } from "../scripts/hermetic.ts";
import { openSession } from "../src/launch/index.ts";
import { guardBinDir, takeGuardCalls } from "./preload.ts";

describe("tmuxCommands / isEscape", () => {
  test("finds the subcommand past global flags and after every `;`", () => {
    expect(tmuxCommands(["-L", "x", "-f", "/dev/null", "new-window", "-n", "w"])).toEqual(["new-window"]);
    expect(tmuxCommands(["select-window", "-t", "p", ";", "select-pane", "-t", "p"])).toEqual(["select-window", "select-pane"]);
    expect(tmuxCommands(["-V"])).toEqual(["-V"]);
    expect(tmuxCommands(["-u"])).toEqual([]);
    // tmux also ends a command at an argument that ends in an unescaped `;`.
    expect(tmuxCommands(["list-windows", "-F", "x;", "kill-server"])).toEqual(["list-windows", "kill-server"]);
    expect(tmuxCommands(["new-window;", "list-panes"])).toEqual(["new-window", "list-panes"]);
    expect(tmuxCommands(["display-message", "a\\;", "kill-server"])).toEqual(["display-message"]);
  });

  test("reads pass; anything that changes a server, or any agent run, escapes", () => {
    expect(isEscape(["tmux", "list-windows", "-a", "-F", "#{window_name}"])).toBe(false);
    expect(isEscape(["tmux", "display-message", "-p", "#{socket_path}"])).toBe(false);
    expect(isEscape(["tmux", "capture-pane", "-p", "-t", "x"])).toBe(false);
    // Without -p these two act on the server: a paste buffer, a client's status line.
    expect(isEscape(["tmux", "display-message", "-t", "x", "hello"])).toBe(true);
    expect(isEscape(["tmux", "capture-pane", "-t", "x"])).toBe(true);
    expect(isEscape(["tmux", "display-message", "-p", "x", ";", "capture-pane", "-t", "y"])).toBe(true);
    expect(isEscape(["tmux", "-V"])).toBe(false);
    expect(isEscape(["tmux", "new-session", "-d", "-s", "cl-claude-s1"])).toBe(true);
    expect(isEscape(["tmux", "list-windows", ";", "kill-window", "-t", "x"])).toBe(true);
    expect(isEscape(["tmux", "-u"])).toBe(true); // bare tmux attaches or starts a server
    for (const agent of AGENT_BINARIES) expect(isEscape([agent, "--resume", "s1"])).toBe(true);
  });
});

describe("readCalls", () => {
  test("consumes whole records oldest first, and leaves one still being written", () => {
    const calls = mkdtempSync(join(tmpdir(), "agendo-calls-"));
    const us = String.fromCharCode(0x1f);
    writeFileSync(join(calls, "2.1"), `tmux${us}new-window${us}`);
    writeFileSync(join(calls, "1.1"), `tmux${us}list-windows${us}-F${us}a\nb${us}`);
    writeFileSync(join(calls, "3.1.part"), `tmux${us}kill-`);
    expect(readCalls(calls)).toEqual([["tmux", "list-windows", "-F", "a\nb"], ["tmux", "new-window"]]);
    expect(readCalls(calls)).toEqual([]);
    writeFileSync(join(calls, "3.1.part"), `tmux${us}kill-window${us}`);
    renameSync(join(calls, "3.1.part"), join(calls, "3.1"));
    expect(readCalls(calls)).toEqual([["tmux", "kill-window"]]);
    removeDir(calls);
  });
});

describe("the preload's fence", () => {
  test("no tmux server is reachable from the environment", () => {
    expect(process.env.TMUX).toBeUndefined();
    expect(process.env.TMUX_PANE).toBeUndefined();
    expect(process.env.TMUX_TMPDIR).toBe(DEAD_TMUX_TMPDIR);
  });

  const unguardedPath = process.env.PATH!.split(delimiter).filter((d) => d !== guardBinDir).join(delimiter);
  test.skipIf(!Bun.which("tmux", { PATH: unguardedPath }))("even the real tmux can reach no server: it fails rather than fall back to /tmp", () => {
    const real = spawnSync("tmux", ["list-sessions"], { env: { ...process.env, PATH: unguardedPath }, encoding: "utf-8" });
    expect(real.status).toBe(1);
    expect(real.stderr).toContain("couldn't create directory");
  });

  test("Bun.which follows the live PATH, as src/providers' installed-check relies on", () => {
    expect(Bun.which("claude")).toBe(join(guardBinDir, "claude"));
  });

  test("Bun.spawn and Bun.spawnSync see the fenced environment, not the one bun started with", async () => {
    const probe = ["sh", "-c", 'echo "$TMUX_TMPDIR $TMUX $(command -v tmux)"'];
    const expected = `${DEAD_TMUX_TMPDIR}  ${guardBinDir}/tmux`;
    expect(Bun.spawnSync(probe).stdout.toString().trim()).toBe(expected);
    expect(Bun.spawnSync({ cmd: probe }).stdout.toString().trim()).toBe(expected);
    expect((await new Response(Bun.spawn(probe, { stdout: "pipe" }).stdout).text()).trim()).toBe(expected);
    // An explicit env is the caller's, untouched.
    expect(Bun.spawnSync(["sh", "-c", 'echo "$TMUX_TMPDIR"'], { env: { TMUX_TMPDIR: "own" } }).stdout.toString().trim()).toBe("own");
  });

  test("tmux and every agent CLI resolve to the guard's fakes", () => {
    const fakes = ["tmux", ...AGENT_BINARIES].map((b) => dirname(Bun.which(b)!));
    expect(fakes).toEqual(fakes.map(() => guardBinDir));
    expect(spawnSync("tmux", ["new-window"]).status).toBe(1);
    expect(takeGuardCalls()).toEqual([["tmux", "new-window"]]);
  });

  test("an argument with a newline stays one argument of one call", () => {
    expect(spawnSync("tmux", ["list-windows", "-F", "a\nb", ""]).status).toBe(1);
    expect(takeGuardCalls()).toEqual([["tmux", "list-windows", "-F", "a\nb", ""]]);
  });

  test("an unstubbed resume is recorded instead of opening a window", () => {
    // This one really calls the launch path, so it must not run unfenced.
    if (dirname(Bun.which("tmux") ?? "") !== guardBinDir) throw new Error("guard fakes are not first on PATH");
    openSession({ id: "s1", source: "claude", cwd: "/w", title: "t", lastUsed: new Date() } as any);
    const escapes = takeGuardCalls().filter(isEscape);
    expect(escapes.map((argv) => argv.slice(0, 5))).toEqual([["tmux", "new-session", "-d", "-s", "cl-claude-s1"]]);
  });
});
