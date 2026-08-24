import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TRANSPORT_EXIT, knownHost, loadHosts, tmuxArgv } from "../src/remote.ts";

// The transport seam decides, for every tmux call agendo makes, which machine it
// runs on. The e2e suite cannot reach this: its `fakebin/tmux` stub IS the tmux
// binary, so a test there proves only that agendo spawned something called tmux
// — never which argv it built, and never that the arguments survived untouched.
// These are exactly the two properties the remote path rests on.

const saved = { beam: process.env.AGENDO_BEAM, cfg: process.env.BEAM_CONFIG_DIR };
const dirs: string[] = [];

afterEach(() => {
  for (const k of ["AGENDO_BEAM", "BEAM_CONFIG_DIR"] as const) delete process.env[k];
  if (saved.beam !== undefined) process.env.AGENDO_BEAM = saved.beam;
  if (saved.cfg !== undefined) process.env.BEAM_CONFIG_DIR = saved.cfg;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A throwaway beam config dir holding `contents` as its config.json. */
function beamConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agendo-beam-"));
  dirs.push(dir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), contents);
  process.env.BEAM_CONFIG_DIR = dir;
  return dir;
}

describe("tmuxArgv", () => {
  test("a null host is a DIRECT tmux spawn, not `beam -H local`", () => {
    // Load-bearing, and measured: a bun process costs 15.7ms against tmux's
    // 3.6ms, and a readiness poll is ~2N+3 calls. Routing local through beam
    // would pay ~12ms x 27 on the common path to buy uniformity nobody sees.
    expect(tmuxArgv(null, ["capture-pane", "-p"])).toEqual(["tmux", "capture-pane", "-p"]);
  });

  test("a host becomes beam pass-through, arguments untouched", () => {
    expect(tmuxArgv("vm", ["capture-pane", "-p", "-e", "-t", "=s:=w"])).toEqual([
      "beam", "-H", "vm", "capture-pane", "-p", "-e", "-t", "=s:=w",
    ]);
  });

  test("the tmux target is passed through, never folded into the host", () => {
    // A tmux target is already `=session:=window`, and beam's own target grammar
    // splits `remote:session` on the FIRST colon — so a combined
    // `vm:=session:=window` would parse as the session name `=session:=window`
    // and resolve to nothing. The host is a separate axis and must stay one.
    const argv = tmuxArgv("vm", ["-t", "=agendo-git:=cl-bg-abc123"]);
    expect(argv).toContain("=agendo-git:=cl-bg-abc123");
    expect(argv.join(" ")).not.toContain("vm:=agendo-git");
  });

  test("AGENDO_BEAM overrides the executable, and may name an interpreter", () => {
    // beam is unpublished (`npm view beam-mux` is a 404) and exists here only as
    // a `bun link` from a checkout, so agendo must be able to point at a build
    // without disturbing the linked one. That means a COMMAND, not just a path.
    process.env.AGENDO_BEAM = "bun /src/beam.ts";
    expect(tmuxArgv("vm", ["kill-window"])).toEqual([
      "bun", "/src/beam.ts", "-H", "vm", "kill-window",
    ]);
  });

  test("arguments that look like flags or are empty survive verbatim", () => {
    // `set-buffer -- <prompt>` carries arbitrary user text; nothing here may
    // reorder, drop or reinterpret it.
    expect(tmuxArgv("vm", ["set-buffer", "--", "", "-n", "a b\nc"])).toEqual([
      "beam", "-H", "vm", "set-buffer", "--", "", "-n", "a b\nc",
    ]);
  });
});

describe("loadHosts", () => {
  test("a missing config is no hosts, not an error", () => {
    process.env.BEAM_CONFIG_DIR = join(tmpdir(), "agendo-beam-does-not-exist");
    expect(loadHosts()).toEqual([]);
  });

  test("malformed JSON degrades to no hosts rather than throwing", () => {
    // This is someone else's file, in a shape agendo does not own. A hand edit
    // must not brick a command that merely wanted to know the machine list.
    beamConfig("{ not json");
    expect(loadHosts()).toEqual([]);
  });

  test("hosts come back in name order, with port when set", () => {
    beamConfig(JSON.stringify({
      remotes: {
        vm: { host: "kristjan@10.0.0.229", ip: "127.44.0.1" },
        gpu: { host: "gpu-box", port: 2222, ip: "127.44.0.2" },
      },
    }));
    expect(loadHosts()).toEqual([
      { name: "gpu", host: "gpu-box", port: 2222 },
      { name: "vm", host: "kristjan@10.0.0.229" },
    ]);
  });

  test("an entry without a usable host string is skipped, not guessed at", () => {
    beamConfig(JSON.stringify({ remotes: { ok: { host: "h" }, broken: {}, alsoBad: { host: 7 } } }));
    expect(loadHosts().map((h) => h.name)).toEqual(["ok"]);
  });

  test("a config that parses but is not a record yields no hosts", () => {
    // `JSON.parse('"oops"')` succeeds and is not an object; the same guard
    // config.ts applies to its own files.
    beamConfig('"oops"');
    expect(loadHosts()).toEqual([]);
  });

  test("knownHost answers from the same list", () => {
    beamConfig(JSON.stringify({ remotes: { vm: { host: "h" } } }));
    expect(knownHost("vm")).toBe(true);
    expect(knownHost("nope")).toBe(false);
  });
});

describe("TRANSPORT_EXIT", () => {
  test("is ssh's own failure code, which tmux does not use", () => {
    // The distinction is a safety property, not cosmetics: `readPaneState`
    // returns null on a failed read and `agendo close` treats null as "I could
    // not see this pane, so I will not kill it". A dropped connection reported
    // as an ordinary tmux failure would look like an empty screen.
    expect(TRANSPORT_EXIT).toBe(255);
  });
});
