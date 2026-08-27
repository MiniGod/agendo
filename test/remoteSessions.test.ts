import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { locateEverywhere, remoteSession, type RemoteWindow } from "../src/remoteSessions.ts";
import { isRemoteKey, liveKey, REMOTE_KEY_SEP } from "../src/model.ts";
import { ID_BEARING_NAME } from "../src/tmux.ts";
import { parseMenuArgs } from "../src/cli/args.ts";

// None of this is reachable from e2e: the suite has no second machine, and its
// `fakebin/tmux` stub IS the local tmux. What it cannot see is exactly what a
// remote row's correctness rests on — that a machine is part of a session's
// identity, and that a guessed provider never becomes an address.

const win = (over: Partial<RemoteWindow> = {}): RemoteWindow => ({
  host: "vm",
  name: "cl-claude-0fe53844cc68",
  id: "0fe53844-cc68-4f89-aac2-3ff54a04d1a4",
  source: "claude",
  title: "✳ a title",
  idleSeconds: 60,
  target: "=agendo-git:=cl-claude-0fe53844cc68",
  cwd: "/home/k/git/thing",
  readiness: "ready",
  backgroundAgents: 0,
  shells: 0,
  limitResetAt: null,
  placeholder: false,
  ...over,
});

describe("liveKey — the machine is part of the identity", () => {
  // The failure this prevents: the same session resumed on two machines carries
  // the same `cl-<source>-<shortid>` window name on both. Keyed by name alone,
  // one machine's window answers for the other's — and enter attaches you to the
  // wrong machine.
  test("the same session on two machines gets two keys", () => {
    const s = remoteSession(win());
    const other = remoteSession(win({ host: "web" }));
    expect(liveKey(s)).not.toBe(liveKey(other));
  });

  test("a local session's key is unchanged — the tmux window name, as before", () => {
    const local = { ...remoteSession(win()), host: undefined };
    expect(liveKey(local)).toBe("cl-claude-0fe53844cc68");
    expect(isRemoteKey(liveKey(local))).toBe(false);
  });

  // The live maps also hold RAW tmux names (`reconcileLive` seeds them from
  // `liveTargets`), and agendo names its own remote-attach windows `<host>/<win>`.
  // A `/` test for "is this key remote" would therefore classify the LOCAL half
  // of a remote attach as remote. A NUL cannot appear in a tmux name at all.
  test("a local window named like a remote attach is not mistaken for one", () => {
    expect(REMOTE_KEY_SEP).toBe("\u0000");
    expect(isRemoteKey("vm/cl-claude-0fe53844cc68")).toBe(false);
    expect(isRemoteKey("web/deploy")).toBe(false);
    expect(isRemoteKey(`vm${REMOTE_KEY_SEP}cl-claude-0fe53844cc68`)).toBe(true);
  });
});

describe("remoteSession — what tmux knows, and what it does not", () => {
  test("carries the five fields tmux has and leaves the file-backed ones absent", () => {
    const s = remoteSession(win());
    expect(s.id).toBe("0fe53844-cc68-4f89-aac2-3ff54a04d1a4");
    expect(s.source).toBe("claude");
    expect(s.cwd).toBe("/home/k/git/thing");
    expect(s.title).toBe("✳ a title");
    expect(s.host).toBe("vm");
    // These live in files on the far machine and must not be invented.
    expect(s.branch).toBeUndefined();
    expect(s.repository).toBeUndefined();
    expect(s.logPath).toBeUndefined();
    expect(s.createdAt).toBeUndefined();
  });

  test("lastUsed is derived from the idle age, not left at now", () => {
    const s = remoteSession(win({ idleSeconds: 3600 }));
    const ageSec = (Date.now() - s.lastUsed.getTime()) / 1000;
    expect(ageSec).toBeGreaterThan(3500);
    expect(ageSec).toBeLessThan(3700);
  });

  test("a pane with no launch argv still gets an identity, from its window name", () => {
    const s = remoteSession(win({ id: null, source: null, title: null, name: "cl-bg-abc123" }));
    expect(s.id).toBe("cl-bg-abc123");
    expect(s.title).toBe("cl-bg-abc123");
    // `cl-bg-` encodes no provider, so this is the documented guess.
    expect(s.source).toBe("claude");
  });

  test("an id-less pane whose NAME encodes a provider uses that, not the default", () => {
    expect(remoteSession(win({ id: null, source: null, name: "cl-codex-abc" })).source).toBe("codex");
    expect(remoteSession(win({ id: null, source: null, name: "cl-copilot-abc" })).source).toBe("copilot");
  });
});

describe("parseMenuArgs — --remote", () => {
  // `--remote=<name>` is validated against beam's registered machines at parse
  // time, so without a fixture config this suite would read whatever the
  // developer happens to have registered — and, worse, `process.exit(1)` on an
  // unknown name would take the test runner down with it. The fixture makes the
  // check hermetic and exercises it in both directions.
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "agendo-beamcfg-"));
    mkdirSync(join(dir, "beam"), { recursive: true });
    writeFileSync(
      join(dir, "beam", "config.json"),
      JSON.stringify({ remotes: { vm: { host: "k@10.0.0.1" }, web: { host: "k@10.0.0.2" } } }),
    );
    process.env.BEAM_CONFIG_DIR = join(dir, "beam");
  });
  afterAll(() => {
    delete process.env.BEAM_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("absent means local only, which is null and not an empty list", () => {
    expect(parseMenuArgs([]).remote).toBeNull();
    expect(parseMenuArgs(["/some/path"]).remote).toBeNull();
  });

  test("bare --remote means every registered machine", () => {
    expect(parseMenuArgs(["--remote"]).remote).toEqual([]);
  });

  test("--remote=<name> selects, and repeats accumulate", () => {
    expect(parseMenuArgs(["--remote=vm"]).remote).toEqual(["vm"]);
    expect(parseMenuArgs(["--remote=vm", "--remote=web"]).remote).toEqual(["vm", "web"]);
  });

  // A typo'd machine must be caught HERE, not survive as a warning line under a
  // listing that otherwise looks fine — which reads as "that machine is down"
  // rather than "you spelled it wrong".
  test("a machine beam has not registered is refused at parse time", () => {
    const exit = process.exit;
    const err = console.error;
    let code: number | undefined;
    let msg = "";
    // A test double for a `never`-returning function: throwing is how it never
    // returns, which lets the assertion below see that it was reached.
    process.exit = ((c?: number) => { code = c; throw new Error("exit"); }) as typeof process.exit;
    console.error = (m: string) => { msg = m; };
    try {
      expect(() => parseMenuArgs(["--remote=nope"])).toThrow("exit");
    } finally {
      process.exit = exit;
      console.error = err;
    }
    expect(code).toBe(1);
    expect(msg).toContain('unknown machine "nope"');
  });

  test("the other launcher arguments still parse alongside it", () => {
    expect(parseMenuArgs(["/p", "-s", "host", "--remote=vm"])).toEqual({
      pathArg: "/p",
      session: "host",
      remote: ["vm"],
    });
  });
});

describe("locateEverywhere — a named machine is exclusive, a bare --remote is not", () => {
  // The asymmetry is deliberate and was a bug before it was a rule: `ls
  // --remote=vm` adds that machine to the local listing, but `send --remote=vm`
  // must mean THAT machine, because it is how a caller answers "which of the two
  // did you mean". Folding the local session back in made that unanswerable.
  test("includeLocal=false leaves this machine out entirely", () => {
    // No beam machines and no local half: there is nothing left to find, which is
    // exactly the point — the flag decided that, not the absence of a session.
    expect(locateEverywhere("deadbeef1234", null, false)).toEqual({ found: [], warnings: [] });
  });

  test("includeLocal=true with no machines is the local-only lookup send always did", () => {
    const { found, warnings } = locateEverywhere("nosuchsession", null, true);
    expect(warnings).toEqual([]);
    expect(found).toEqual([]); // no such local session either, but it did look
  });
});

describe("the remote matcher is EXACTLY the local one, not a looser cousin", () => {
  // `locateEverywhere` resolves a short id against remote window names. It must
  // use the same rule `liveTargetForShortId` uses locally — the short id embedded
  // in an ID-BEARING name — because anything looser matches more remotely than
  // locally, which is the wrong direction for a resolver whose entire job is
  // telling two machines apart.
  //
  // The specific miss this pins: a trailing `-<sid>` test (which is what the
  // first draft used) matches `cl-wi-1234`, whose name embeds a WORK ITEM id.
  // `send 1234 --remote` would have typed into a session whose own id is
  // something else entirely.
  const match = (name: string) => name.match(ID_BEARING_NAME)?.[1] ?? null;

  test("id-bearing names resolve to their short id", () => {
    expect(match("cl-claude-aaaabbbbcccc")).toBe("aaaabbbbcccc");
    expect(match("cl-bg-ddddeeeeffff")).toBe("ddddeeeeffff");
    expect(match("cl-new-f7c286cb78df")).toBe("f7c286cb78df");
  });

  test("a work-item or PR name is NOT an id-bearing name", () => {
    // These embed an item id, not a session id. Matching them here would send
    // to a session the caller never named.
    expect(match("cl-wi-1234")).toBeNull();
    expect(match("cl-pr-50")).toBeNull();
  });

  test("a bare trailing id does not make a name id-bearing", () => {
    expect(match("launcher")).toBeNull();
    expect(match("some-window-aaaabbbbcccc")).toBeNull();
  });
});
