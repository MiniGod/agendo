// Claude Code's own record of which of its processes is running which session,
// shaped for window adoption (src/app/model/adopt.ts).
//
// Every interactive `claude` registers itself at `<configDir>/sessions/<pid>.json`
// for as long as it runs: the session id it is on, the cwd it was started in,
// and — when it runs inside tmux — the `session:@window.%pane` it sits in. It is
// the only thing on disk that says "THIS pane is THAT session" outright, which
// is what adoption needs and what a transcript cannot give it: a hand-typed
// `claude` gets no `--session-id`, so the id it assigns itself is discoverable
// only after the fact, and the transcript route — pane cwd → project dir → "the
// newest file" — is a guess that gets worse with every second session in the
// same directory. A wrong guess here is a window `agendo close` will later kill.
//
// The registry is READ by src/orchestration/peer.ts (`livePeers`), which is
// also the arbiter of whether an entry is live: the pid must exist AND carry
// the kernel start time the record was written with, so a pid the kernel has
// since handed to the user's shell does not pass as the claude that wrote the
// file. This module adds the one thing adoption needs on top of a peer — the
// tmux location, parsed — and nothing else, so there is one parser of the
// registry in the tree, not two that can drift.
//
// Inherited with that: `livePeers` admits only entries speaking the one
// cross-session protocol version it knows (`peerProtocol`, with a socket path).
// Adoption's identity needs none of that, but it shares the gate, so the day
// Claude Code bumps the protocol, adoption stops along with `agendo send`'s
// socket path — loudly for send, silently here. Known, and preferred to a
// second parser that would drift from the first.
import { livePeers, type PeerSession } from "../orchestration/peer.ts";

/**
 * One live Claude process, as its record describes it. The pid is not carried:
 * liveness is settled by `livePeers` before a record gets here, and adoption
 * ties a record to a pane by the pane id alone.
 */
export interface ClaudeProcessRecord {
  sessionId: string;
  cwd: string;
  /** The tmux session and pane id the process runs in; absent outside tmux. */
  tmux?: { session: string; pane: string };
}

/**
 * `agendo:@29.%29` → the session name and the PANE id. The window id in the
 * middle is dropped: adoption addresses everything by pane, the one tmux handle
 * that cannot prefix-match a neighbour. A session name may contain `:`-free
 * anything, dashes and digits included (`agendo-mc-applications`).
 */
export function parseTmuxLocation(raw: string): { session: string; pane: string } | undefined {
  const m = /^(.+):@\d+\.(%\d+)$/.exec(raw);
  return m ? { session: m[1]!, pane: m[2]! } : undefined;
}

/**
 * A live peer as an adoption record. A peer outside tmux, or one whose
 * location does not parse, is still a record — just one with no pane, which
 * adoption can never match to anything.
 */
export function recordFromPeer(peer: PeerSession): ClaudeProcessRecord {
  const tmux = peer.tmux === undefined ? undefined : parseTmuxLocation(peer.tmux);
  return { sessionId: peer.sessionId, cwd: peer.cwd, tmux };
}

/**
 * Every live, interactive Claude process on this machine, by its own account.
 * `peers` is the registry read, a parameter so the mapping can be tested
 * without a live process behind each entry.
 */
export async function readClaudeProcessRecords(peers: () => Promise<PeerSession[]> = livePeers): Promise<ClaudeProcessRecord[]> {
  return (await peers()).map(recordFromPeer);
}
