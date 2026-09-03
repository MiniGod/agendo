// A peer registry entry (src/peer.ts). The e2e suite writes one well-formed
// registry file per fixture peer, so the live path is reached there; what it
// never writes is a truncated file, a scalar, a stale protocol, a non-interactive
// kind or a dead pid. Each of those sits here beside the entry that passes,
// with the pid check a parameter so no process has to stand behind a number.
import { describe, expect, test } from "bun:test";
import { PEER_PROTOCOL, parsePeerEntry } from "../src/peer.ts";

const entry = {
  pid: 4242,
  sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
  messagingSocketPath: "/run/peer.sock",
  peerProtocol: PEER_PROTOCOL,
  kind: "interactive",
  procStart: "12345",
};
const alive = () => true;
const dead = () => false;
const parse = (e: unknown, check = alive) => parsePeerEntry(typeof e === "string" ? e : JSON.stringify(e), check);

describe("parsePeerEntry", () => {
  test("a full entry, every optional field through; the bare minimum, with their defaults", () => {
    const full = parse({ ...entry, cwd: "/w", status: "waiting", waitingFor: "input needed", tmux: "s:@1.%2" });
    expect(full).toEqual({
      pid: 4242, sessionId: entry.sessionId, socketPath: "/run/peer.sock", cwd: "/w",
      status: "waiting", waitingFor: "input needed", tmux: "s:@1.%2", kind: "interactive", peerProtocol: PEER_PROTOCOL,
    });
    const bare = parse(entry);
    expect(bare).toMatchObject({ pid: 4242, cwd: "" });
    expect(bare!.status).toBeUndefined();
    expect(bare!.tmux).toBeUndefined();
  });

  test("the pid check gets the pid and the recorded process start", () => {
    const seen: unknown[][] = [];
    parse(entry, (...args: unknown[]) => { seen.push(args); return true; });
    expect(seen).toEqual([[4242, "12345"]]);
    parse({ ...entry, procStart: 7 }, (...args: unknown[]) => { seen.push(args); return true; });
    expect(seen[1]).toEqual([4242, undefined]);
  });

  test("not a peer: unparseable, null, a scalar, a list; a dead pid", () => {
    expect(parse("{not json")).toBeNull();
    expect(parse("null")).toBeNull();
    expect(parse(1)).toBeNull();
    expect(parse("s")).toBeNull();
    expect(parse([])).toBeNull();
    expect(parse(entry, dead)).toBeNull();
  });

  test("not a peer: a missing or mistyped identity field, another protocol, another kind", () => {
    expect(parse({ ...entry, pid: "4242" })).toBeNull();
    expect(parse({ ...entry, sessionId: 7 })).toBeNull();
    expect(parse({ ...entry, messagingSocketPath: "" })).toBeNull();
    expect(parse({ ...entry, peerProtocol: PEER_PROTOCOL + 1 })).toBeNull();
    expect(parse({ ...entry, kind: "headless" })).toBeNull();
    const { kind: _k, ...noKind } = entry;
    expect(parse(noKind)).toBeNull();
  });
});
