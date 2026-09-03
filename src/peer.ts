// Talks to a *running* Claude Code session over its cross-session messaging
// socket, instead of typing into its tmux pane.
//
// Every interactive `claude` process (peerProtocol >= 1) registers itself at
// `<configDir>/sessions/<pid>.json` and listens on a unix socket, normally
// `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`. The socket speaks newline-delimited
// JSON; a `{type:"user"}` frame is enqueued as a prompt. Claude Code documents
// the frame shape in its own startup log:
//
//   [uds-messaging] Inject messages:
//     echo '{"type":"user","message":{"role":"user","content":"hello"}}' \
//       | socat - UNIX-CONNECT:<path>
//
// Why this beats `tmux paste-buffer` + `send-keys Enter`:
//   • It QUEUES. A pane paste lands in whatever is on screen right now, so the
//     sender must first prove the TUI is idle (paneReadiness) or risk clobbering
//     a half-typed line or an open dialog. A socket frame is queued by the
//     receiving session and delivered when it next reads input — verified live
//     against a session mid-permission-prompt, which reported
//     "Released 1 held cross-session message to Claude's queue".
//   • It is addressed by session id, not by screen position. `session_id` is
//     validated by the receiver and a mismatch is DROPPED (verified: a frame
//     sent with a bogus id left the session idle), so a recycled pid cannot
//     misdeliver a prompt into someone else's session.
//
// Two caveats this module deliberately does not paper over:
//   • The protocol is internal — not in `claude --help`, not in the public docs.
//     `peerProtocol` is the version marker; anything unrecognized is treated as
//     "no peer" and the caller falls back to the tmux path.
//   • A frame arrives as a *peer* message, not as the user typing. The receiver
//     wraps it in "Another Claude session sent a message" and will NOT accept it
//     as an answer to a pending permission prompt. Dismissing dialogs and the
//     usage-limit resume therefore stay on the tmux keystroke path (see
//     tmux.ts:resumeKeystrokes).
import { readFileSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { createConnection } from "net";
import { join } from "path";
import { discoverProfiles } from "./profiles.ts";

/** A live Claude Code session reachable over its messaging socket. */
export interface PeerSession {
  pid: number;
  /** Full session UUID — also the `--resume` id and the transcript filename. */
  sessionId: string;
  cwd: string;
  /** Absolute path to the session's unix domain socket. */
  socketPath: string;
  /** Receiver-reported state: "idle" | "busy" | "waiting" | "shell" (advisory). */
  status?: string;
  /** Detail for the "waiting" state, e.g. "input needed". */
  waitingFor?: string;
  /** `<tmux-session>:@<window>.%<pane>` when the session runs under tmux. */
  tmux?: string;
  /** Always "interactive" here — see the kind filter in livePeers. */
  kind: string;
  /** Wire-protocol version. Only PEER_PROTOCOL is spoken. */
  peerProtocol: number;
}

/**
 * The only cross-session wire protocol version this module knows how to speak.
 * A session advertising anything else is reported as unreachable so the caller
 * falls back to tmux rather than writing frames the receiver may not parse.
 */
export const PEER_PROTOCOL = 1;

/**
 * The newline-delimited JSON frame that enqueues `text` as a prompt in the
 * session identified by `sessionId`. Split from the socket write so tests can
 * assert the exact bytes without a live session (mirrors tmux.ts:resumeKeystrokes).
 *
 * `session_id` is what makes this safe to address by pid: the receiver compares
 * it against its own and drops the frame on mismatch.
 */
export function peerMessageFrame(sessionId: string, text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text }, session_id: sessionId }) + "\n";
}

/**
 * Whether `pid` is still the process that wrote this registry entry.
 *
 * Signal 0 probes for existence without delivering anything, but on its own it
 * only says "*some* process has this pid" — and pids churn fast enough on a busy
 * machine to wrap. `procStart` (the kernel's start-time counter for the process,
 * which the registry records) pins the identity: same pid AND same start time is
 * the same process. Unreadable start times (non-Linux, permissions) fall back to
 * the existence check rather than declaring a live session dead.
 *
 * EPERM from kill() — a live process owned by someone else — reads as dead here.
 * That is the safe direction: it means "no peer", and the caller uses tmux.
 */
function pidAlive(pid: number, procStart?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false; // kill(0, …) targets our own group
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!procStart) return true;
  const actual = procStartTime(pid);
  return actual === null || actual === procStart;
}

/**
 * Field 22 (`starttime`) of /proc/<pid>/stat, or null where that isn't readable.
 * Field 2 is the executable name in parentheses and may itself contain spaces
 * and parens, so the fields are counted from the LAST ')' — after which the
 * first token is field 3, making starttime the 20th.
 */
function procStartTime(pid: number): string | null {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
  } catch {
    return null;
  }
  const tail = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  return tail[19] ?? null;
}

/**
 * Every live session registered under any `~/.claude*` profile. Registry files
 * outlive their process, so entries whose pid is gone are skipped — a stale
 * `<pid>.json` from a crashed session would otherwise shadow a real one.
 *
 * Profiles come from profiles.ts UNDEDUPED, unlike the transcript scan. That
 * dedupe collapses profiles sharing a `projects/` store, which says nothing
 * about their `sessions/` dirs — an alias that symlinks only `projects/` keeps
 * its own registry, and dropping it would lose those peers. Scanning every
 * profile and deduping the RESULT by pid is correct either way: a pid names a
 * process, so the same session reached through two names collapses to one entry
 * and two genuinely distinct sessions never do.
 *
 * Inherited from that discovery: a `~/.claude*` dir is only a profile once it
 * has a `projects/` store. A session writes its transcript there as it starts,
 * so a live session's profile qualifies — but a registry sitting in a dir that
 * has never held one is invisible here, and its session takes the tmux path.
 */
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * A registry file's text as an object, or null. A truncated write can leave a
 * file holding literal `null`, which parses fine and then throws on the first
 * property read — the one corrupt shape a parse guard alone doesn't absorb.
 * Every other scalar (`1`, `"s"`, `[]`) is harmless: the field reads come back
 * undefined and the entry is skipped.
 */
function registryObject(raw: string): Record<string, unknown> | null {
  try {
    const r = JSON.parse(raw);
    return r && typeof r === "object" ? r : null;
  } catch {
    return null;
  }
}

/** The three fields without which an entry is not a peer at all. */
function peerIdentity(r: Record<string, unknown>): { pid: number; sessionId: string; socketPath: string } {
  return {
    pid: typeof r.pid === "number" ? r.pid : NaN,
    sessionId: str(r.sessionId) ?? "",
    socketPath: str(r.messagingSocketPath) ?? "",
  };
}

/**
 * Whether an entry is a live, interactive, current-protocol peer. Only a
 * session with a human at a TUI will ever render a queued prompt. The registry
 * is not exclusively those — `kind` distinguishes them, and every protocol-1
 * entry observed carries it — so anything that isn't explicitly interactive is
 * treated as "no peer" and left to the tmux path, the same safe direction as an
 * unrecognized peerProtocol.
 */
function isLivePeer(
  r: Record<string, unknown>,
  id: { pid: number; sessionId: string; socketPath: string },
  alive: typeof pidAlive,
): boolean {
  if (!Number.isFinite(id.pid) || !id.sessionId || !id.socketPath) return false;
  if (r.peerProtocol !== PEER_PROTOCOL || r.kind !== "interactive") return false;
  return alive(id.pid, str(r.procStart));
}

/**
 * One registry file's text as a live peer, or null for anything that is not
 * one: unparseable, the wrong shape, another protocol or kind, a dead pid.
 * `alive` is the pid check, a parameter so the shapes can be tested without a
 * process behind each.
 */
export function parsePeerEntry(raw: string, alive: typeof pidAlive = pidAlive): PeerSession | null {
  const r = registryObject(raw);
  if (!r) return null;
  const id = peerIdentity(r);
  if (!isLivePeer(r, id, alive)) return null;
  return {
    ...id,
    cwd: str(r.cwd) ?? "",
    status: str(r.status),
    waitingFor: str(r.waitingFor),
    tmux: str(r.tmux),
    kind: "interactive",
    peerProtocol: PEER_PROTOCOL,
  };
}

export async function livePeers(): Promise<PeerSession[]> {
  const profiles = await discoverProfiles();
  const out: PeerSession[] = [];
  await Promise.all(
    profiles.map(async ({ configDir }) => {
      const dir = join(configDir, "sessions");
      const files = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(
        files.map(async (f) => {
          if (!f.endsWith(".json")) return;
          const raw = await readFile(join(dir, f), "utf-8").catch(() => null);
          if (raw === null) return;
          const peer = parsePeerEntry(raw);
          if (peer) out.push(peer);
        }),
      );
    }),
  );
  // Concurrent reads finish in arbitrary order, and one process can be reached
  // through two profile names (see above). Collapse by pid — the process
  // identity — then sort, so the list is the same on every call regardless of
  // which read won. Descending pid is an arbitrary but stable order; it is NOT a
  // recency claim (pids wrap), and it isn't load-bearing: a stale entry behind a
  // recycled pid is already excluded by pidAlive's procStart check.
  return [...new Map(out.map((p) => [p.pid, p])).values()].sort((a, b) => b.pid - a.pid);
}

/**
 * The live peer whose session id matches `match` — called with the same short
 * id the tmux naming convention uses (tmux.ts:shortId), so a caller holding only
 * a `cl-claude-<shortId>` window name can still resolve the full session.
 */
export async function findPeer(match: (sessionId: string) => boolean): Promise<PeerSession | null> {
  const peers = await livePeers();
  return peers.find((p) => match(p.sessionId)) ?? null;
}

/**
 * Backstop for a write that never completes. It rarely fires: a receiver that
 * accepts and then never reads still takes a prompt-sized frame straight into
 * the kernel's socket buffer, so the write finishes regardless (measured: 5 MB
 * accepted in 11 ms by a receiver doing nothing). It is here for the case that
 * buffer cannot absorb — a backed-up receiver and a large enough payload — not
 * for a merely unresponsive one.
 */
const SEND_TIMEOUT_MS = 5_000;

/**
 * Enqueue `text` as a prompt in a running session. Resolves once the frame has
 * been handed to the kernel; rejects if the socket is gone (the session died
 * between discovery and send), if the receiver hangs up before taking the
 * bytes, or if the write stalls past SEND_TIMEOUT_MS.
 *
 * The success signal is the writable side's "finish", NOT "close". Measured on
 * a unix socket under bun, across a receiver that holds the connection, one that
 * reads then closes, and two that reset on accept: "finish" fires in exactly the
 * cases where the receiver actually got the bytes, and never in the cases where
 * it got zero. "close" is weaker (it can fire having proven nothing) and "end"
 * is useless on its own — it arrives first in every case, success or not, since
 * it is just the peer's FIN. A reset receiver emits neither "close" nor "error"
 * under bun, so "end" without a subsequent "finish" is what catches it; the
 * check is deferred a tick because on success "end" still lands first.
 *
 * There is no application-level ack to read: the `peer_message_status` channel
 * only runs between two Claude sessions that hold each other's sockets, not for
 * an anonymous client like us. A resolved promise therefore means "handed over",
 * not "the agent has read it" — the receiver may queue it for minutes.
 */
export function sendPeerMessage(peer: PeerSession, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(peer.socketPath);
    let settled = false;
    const settle = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => settle(new Error(`timed out writing to ${peer.socketPath}`)), SEND_TIMEOUT_MS);
    sock.on("connect", () => sock.end(peerMessageFrame(peer.sessionId, text)));
    sock.on("finish", () => settle());
    sock.on("end", () =>
      setImmediate(() => {
        if (!sock.writableFinished) settle(new Error(`${peer.socketPath} closed before accepting the message`));
      }),
    );
    sock.on("error", (e) => settle(e));
  });
}
