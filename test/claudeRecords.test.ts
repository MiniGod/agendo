// Claude's per-process session record as window adoption sees it
// (src/sessions/records.ts): a live peer from src/orchestration/peer.ts plus
// its tmux location, parsed. The registry parsing and the pid-plus-start-time
// liveness check are peer.ts's and are pinned in test/peerEntry.test.ts; what is
// pinned here is the one step this module adds, and that it adds nothing else.
// Untestable through the e2e suite for the usual reason: every record a fixture
// writes is well-formed, and a well-formed location is where a strict parser
// and a trusting one agree. What matters is what a foreign or headless record
// degrades to — and it must be "no pane", never a confident wrong one.
import { describe, expect, test } from "bun:test";
import { parseTmuxLocation, readClaudeProcessRecords, recordFromPeer } from "../src/sessions/records.ts";
import { PEER_PROTOCOL, type PeerSession } from "../src/orchestration/peer.ts";

/** A live peer as `livePeers` reports one, trimmed to the fields that matter. */
const PEER: PeerSession = {
  pid: 4242,
  sessionId: "0e6e2941-73bb-4f49-ab40-c921bc6959f5",
  cwd: "/home/dev/repo",
  socketPath: "/run/user/1000/cc-socks/4242.sock",
  tmux: "agendo:@29.%29",
  kind: "interactive",
  peerProtocol: PEER_PROTOCOL,
};

describe("parseTmuxLocation", () => {
  test("reads the session name and pane id out of `session:@window.%pane`", () => {
    expect(parseTmuxLocation("agendo:@29.%29")).toEqual({ session: "agendo", pane: "%29" });
    // A session name may itself carry dashes and digits (`agendo-mc-applications`).
    expect(parseTmuxLocation("agendo-mc-applications:@5.%5")).toEqual({ session: "agendo-mc-applications", pane: "%5" });
  });

  test("anything else is no location", () => {
    expect(parseTmuxLocation("")).toBeUndefined();
    expect(parseTmuxLocation("agendo")).toBeUndefined();
    expect(parseTmuxLocation("agendo:1")).toBeUndefined();
    expect(parseTmuxLocation("%29")).toBeUndefined();
  });
});

describe("recordFromPeer", () => {
  test("keeps the identity fields and parses the location, nothing more", () => {
    expect(recordFromPeer(PEER)).toEqual({
      sessionId: PEER.sessionId,
      cwd: "/home/dev/repo",
      tmux: { session: "agendo", pane: "%29" },
    });
  });

  test("a process outside tmux has no location, and is still a record", () => {
    const { tmux: _omitted, ...outside } = PEER;
    expect(recordFromPeer(outside).tmux).toBeUndefined();
  });

  test("an unparseable location reads as outside tmux, not as some pane", () => {
    expect(recordFromPeer({ ...PEER, tmux: "garbage" }).tmux).toBeUndefined();
  });
});

describe("readClaudeProcessRecords", () => {
  test("is the registry read, mapped — one record per live peer, in the peers' order", async () => {
    const other = { ...PEER, pid: 17, sessionId: "11111111-2222-7000-8000-000000000000", tmux: "agendo:@3.%3" };
    const records = await readClaudeProcessRecords(async () => [PEER, other]);
    expect(records.map((r) => [r.sessionId, r.tmux?.pane])).toEqual([[PEER.sessionId, "%29"], [other.sessionId, "%3"]]);
  });

  test("no live peers, no records", async () => {
    expect(await readClaudeProcessRecords(async () => [])).toEqual([]);
  });
});
