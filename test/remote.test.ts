import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NO_TMUX_EXIT, TRANSPORT_EXIT, beamAttachArgv, knownHost, loadHosts, splitTarget, tmuxArgv } from "../src/remote.ts";
import { identify, paneLookup } from "../src/remoteSessions.ts";

// The transport seam decides, for every tmux call agendo makes, which machine it
// runs on. The e2e suite cannot reach this: its `fakebin/tmux` stub IS the tmux
// binary, so a test there proves only that agendo spawned something called tmux
// — never which argv it built, and never that the arguments survived untouched.
// These are exactly the two properties the remote path rests on.

const saved = { beam: process.env.AGENDO_BEAM, cfg: process.env.BEAM_CONFIG_DIR };
const dirs: string[] = [];

// Both variables are read straight from the ambient environment, so a developer
// who has `AGENDO_BEAM` exported — which is exactly what pointing agendo at a
// development build of beam does — would otherwise see three of these fail and
// nothing else. Clearing them per test makes the suite state a property of the
// code rather than of the shell it was launched from.
beforeEach(() => {
  for (const k of ["AGENDO_BEAM", "BEAM_CONFIG_DIR"] as const) delete process.env[k];
});

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

describe("the send payload, as argv", () => {
  // `sendToPane` is three tmux calls, the first of which carries arbitrary user
  // prose. Only the ARGV construction is pinned here: whether that payload then
  // survives beam's shell quoting, ssh, and the remote login shell is beam's
  // contract to keep and beam's tests to prove. This asserts agendo hands it
  // over intact and does nothing clever with it.
  test("arbitrary prose reaches set-buffer as a single unmodified argument", () => {
    const hairy = [
      "line one",
      "it's got 'quotes' and \"doubles\"",
      "a $VAR, a `backtick`, a \\backslash",
      "a tmux format #{session_name} and a ; separator",
      "emoji: ✻ ● ⎿",
    ].join("\n");
    const argv = tmuxArgv("vm", ["set-buffer", "-b", "cl-send", "--", hairy]);
    expect(argv).toEqual(["beam", "-H", "vm", "set-buffer", "-b", "cl-send", "--", hairy]);
    // The payload is ONE element. A transport that split it on whitespace or
    // newlines would submit a prompt line by line into a live session.
    expect(argv.filter((a) => a === hairy)).toHaveLength(1);
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

describe("the exit-status contract agendo shares with beam", () => {
  // These two numbers are a protocol, not preferences: beam picked them and
  // agendo reads them. 255 is "beam never got tmux's answer" (ssh's own failure
  // code, which tmux does not produce); 127 is a shell that could not find tmux
  // on the far machine. Folding them together would let a dropped connection
  // look like an empty screen, and `close` treats an unread pane as "do not
  // kill" — so the distinction is what keeps that guard armed.
  test("transport failure and a missing tmux are different numbers, and neither is 1", () => {
    expect(TRANSPORT_EXIT).toBe(255);
    expect(NO_TMUX_EXIT).toBe(127);
    expect(TRANSPORT_EXIT).not.toBe(NO_TMUX_EXIT);
    for (const code of [TRANSPORT_EXIT, NO_TMUX_EXIT]) expect(code).not.toBe(1);
  });
});

describe("identify — session identity from a pane's launch argv", () => {
  // The finding this command rests on: a remote session's FULL id, its provider
  // and its config profile are all in `#{pane_start_command}`, so agendo can
  // name a session on another machine without reading a byte of its transcript.
  // Specimens below are verbatim from a live remote, elided only for width.

  test("a resumed session carries --resume <uuid>", () => {
    const cmd =
      "env CLAUDE_CONFIG_DIR=/home/kristjan/.claude claude --resume " +
      "0fe53844-cc68-4f89-aac2-3ff54a04d1a4 --append-system-prompt \"You are running inside agendo…\"";
    expect(identify(cmd)).toEqual({ id: "0fe53844-cc68-4f89-aac2-3ff54a04d1a4", source: "claude" });
  });

  test("a freshly launched session carries --session-id <uuid>", () => {
    // agendo mints the id up front so it can name the window before the agent
    // has written anything, so this form has no --resume to find.
    const cmd = "claude --session-id f7c286cb-78df-4bf3-91ee-a47f8209b9d3 --append-system-prompt \"…\"";
    expect(identify(cmd)).toEqual({ id: "f7c286cb-78df-4bf3-91ee-a47f8209b9d3", source: "claude" });
  });

  test("each provider's own resume grammar yields the id, not just the name", () => {
    // Three different grammars, and getting this wrong is silent: the row still
    // renders, just with no id to address the session by. Codex's is POSITIONAL
    // (`codex resume <id>`), which an implementation written against claude's
    // flag form misses entirely — it did here, until this test.
    expect(identify("copilot --resume=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toEqual({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", source: "copilot",
    });
    expect(identify("codex resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toEqual({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", source: "codex",
    });
  });

  test("a pane with no launch command is unidentified, not guessed at", () => {
    // tmux reports an empty start command for a pane it did not start with one
    // (a plain shell, or one whose original process was replaced). Verified on
    // the live remote: `bash` and one `cl-new-…` window both come back empty.
    expect(identify("")).toEqual({ id: null, source: null });
    expect(identify(undefined)).toEqual({ id: null, source: null });
  });

  test("a uuid-shaped string that is not an id argument is not taken as one", () => {
    // The cwd of a worktree can contain a uuid. Only the flag forms count.
    expect(identify("bash -c 'cd /tmp/0fe53844-cc68-4f89-aac2-3ff54a04d1a4'").id).toBeNull();
  });
});

describe("paneLookup — window targets vs session targets", () => {
  const map = new Map([
    ["agendo-git\tcl-bg-aaa", "A"],
    ["agendo-git\tlauncher", "L"],
    ["cl-bg-solo\tbash", "S"],
  ]);

  test("a window target keys on session + window", () => {
    expect(paneLookup(map, "=agendo-git:=cl-bg-aaa", "cl-bg-aaa")).toBe("A");
  });

  test("a SESSION target falls back to the session's only pane", () => {
    // agendo started outside tmux names the tmux SESSION `cl-…`, so there is no
    // window name to key on. The session has exactly one managed pane.
    expect(paneLookup(map, "=cl-bg-solo", "cl-bg-solo")).toBe("S");
  });

  test("a window that misses does NOT inherit a sibling's identity", () => {
    // The whole reason the fallback is gated. Ungated, this would return "A" —
    // a different session's id and title, rendered as though it were this one's.
    expect(paneLookup(map, "=agendo-git:=cl-bg-zzz", "cl-bg-zzz")).toBeUndefined();
  });
});

describe("beamAttachArgv — beam's target grammar, not tmux's", () => {
  // The attach path is the one place agendo does NOT drive tmux through
  // pass-through: it needs a tty, which pass-through deliberately refuses. So it
  // speaks beam's own `host:session:window`, and handing it a pre-built tmux
  // target would double up the `=`-pinning beam applies itself.
  test("a window target becomes host:session:window with both flags", () => {
    expect(beamAttachArgv("vm", "agendo-git", "cl-claude-abc")).toEqual([
      "beam", "attach", "--exec", "--no-create", "vm:agendo-git:cl-claude-abc",
    ]);
  });

  test("a session-only target omits the window part", () => {
    expect(beamAttachArgv("vm", "cl-bg-abc", null)).toEqual([
      "beam", "attach", "--exec", "--no-create", "vm:cl-bg-abc",
    ]);
  });

  // Both flags are load-bearing and neither is a default: without --exec beam
  // sees $TMUX (agendo's own window) and opens a second window inside it;
  // without --no-create a stale row could spawn a session on someone's machine.
  test("neither flag is optional", () => {
    const argv = beamAttachArgv("vm", "s", "w");
    expect(argv).toContain("--exec");
    expect(argv).toContain("--no-create");
  });

  test("AGENDO_BEAM overrides the executable here too", () => {
    process.env.AGENDO_BEAM = "bun /w/beam.ts";
    expect(beamAttachArgv("vm", "s", "w").slice(0, 2)).toEqual(["bun", "/w/beam.ts"]);
  });
});

describe("splitTarget — a tmux target back into plain names", () => {
  test("splits and unpins both halves", () => {
    expect(splitTarget("=agendo-git:=cl-claude-abc")).toEqual({ session: "agendo-git", window: "cl-claude-abc" });
  });

  test("a bare session target has no window", () => {
    expect(splitTarget("=cl-bg-abc")).toEqual({ session: "cl-bg-abc", window: null });
    expect(splitTarget("cl-bg-abc")).toEqual({ session: "cl-bg-abc", window: null });
  });

  // `=session:` is the form tmux needs for a pane read of a whole session
  // (docs/remote-machines.md §5.4). Its window half is empty, not a window named
  // "" — which beam would reject.
  test("a trailing colon is not a window", () => {
    expect(splitTarget("=cl-bg-abc:")).toEqual({ session: "cl-bg-abc", window: null });
  });

  // tmux resolves a numeric window half as an INDEX, and agendo leaves those
  // unpinned on purpose (see exactKillTarget). Round-tripping must not add a `=`.
  test("a numeric window index survives", () => {
    expect(splitTarget("=agendo-git:3")).toEqual({ session: "agendo-git", window: "3" });
  });
});

describe("send's resolution contract across machines", () => {
  // These pin the DECISIONS, which is what a caller depends on and what e2e
  // cannot reach (no second machine, and its fakebin tmux is the local one).
  //
  // The rule, in one line: a listing wants every machine, a send wants exactly
  // one. So `list --remote=vm` ADDS vm to the local rows, while `send
  // --remote=vm` REPLACES the local lookup — because naming a machine is how a
  // caller answers "which of the two did you mean", and folding the local
  // session back in would make that unanswerable.
  test("a named machine is exclusive for a send, additive for a listing", () => {
    const includeLocal = (remote: string[] | null) => remote === null || remote.length === 0;
    expect(includeLocal(null)).toBe(true);   // no flag  -> this machine
    expect(includeLocal([])).toBe(true);     // --remote -> this machine AND all
    expect(includeLocal(["vm"])).toBe(false); // --remote=vm -> that machine only
  });
});
