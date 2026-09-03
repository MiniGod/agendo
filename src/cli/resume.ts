import { spawnSync } from "child_process";
import { SELF_CMD, openSession, type OpenPlan } from "../launch.ts";
import { refreshLiveTmux } from "../model.ts";
import { findPeer, type PeerSession } from "../peer.ts";
import { recordLaunchedSession } from "../restore.ts";
import { SessionIndex } from "../sessions.ts";
import { killWindow, sessionName, shortId } from "../tmux.ts";
import type { AgentSession } from "../types.ts";

/** The session a token names: its full id, its short id, or its `cl-<agent>-<short>` window name. */
export function findSession(all: AgentSession[], token: string): AgentSession | undefined {
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  return all.find((x) => x.id === token || shortId(x.id) === sid);
}

/** No id at all: usage, exit 1. */
export function requireToken(token: string | undefined): string {
  if (token) return token;
  console.error(`usage: ${SELF_CMD} resume <id> [--attach]`);
  process.exit(1);
}

/** The session the token names, or a pointer at `list --all` and exit 1. */
export function requireSession(all: AgentSession[], token: string): AgentSession {
  const s = findSession(all, token);
  if (s) return s;
  console.error(`No session found for "${token}".`);
  console.error(`  \`${SELF_CMD} list --all\` lists idle sessions as well as running ones.`);
  process.exit(1);
}

/**
 * The session is already running outside agendo, where there's no window for
 * us to find. Resuming would put a SECOND live claude on one transcript, both
 * appending — so refuse (exit 2) and point at the thing that does work. Say
 * where it actually is: "outside agendo" is an inference from a failed window
 * lookup; `peer.tmux` is the session's own report, and the two differ when a
 * window exists but wasn't attributed to this session.
 */
export function refuseRunningElsewhere(s: Pick<AgentSession, "id">, peer: PeerSession): never {
  const where = peer.tmux ? `pid ${peer.pid} in tmux ${peer.tmux}` : `pid ${peer.pid}, no tmux pane`;
  console.error(`Session ${shortId(s.id)} is already running outside agendo (${where}, ${peer.status ?? "running"}).`);
  console.error(`Resuming would run two agents on one transcript. Use \`${SELF_CMD} send ${shortId(s.id)} "<prompt>"\` to message it instead.`);
  process.exit(2);
}

/** A live claude for this session somewhere we have no window for; only claude reports peers. */
async function peerOf(s: AgentSession): Promise<PeerSession | null> {
  return s.source === "claude" ? await findPeer((id) => id === s.id) : null;
}

/**
 * Detached: persist a restore tab so the resumed window survives a relaunch
 * (no-op outside the canonical session), then print machine-readable next steps.
 */
function reportResumed(s: AgentSession, plan: OpenPlan): void {
  recordLaunchedSession(
    { id: s.id, cwd: s.cwd, title: s.title, source: s.source, configDir: s.configDir },
    plan.tmuxName,
  );
  console.log(`▸ resumed session ${shortId(s.id)}${plan.alreadyRunning ? " (was already running)" : ""}`);
  console.log(`  window:  ${plan.tmuxName}   (in ${s.cwd})`);
  console.log(`  status:  ${SELF_CMD} status ${shortId(s.id)}`);
}

/**
 * Resolve a session by id-or-tmux-name and resume it. Mirrors `runStatus`'s
 * resolution. Detached by default: `openSession` creates (or navigates to) the
 * session's tmux window without handing over the terminal, so an orchestrator
 * gets it running again headlessly; we then record it into the restore snapshot
 * (a no-op unless it landed in the canonical launcher session) and print how to
 * reach it. `--attach` runs the handover the way `launch --attach` does.
 *
 * We resolve the session's actual live window through `refreshLiveTmux` (the same
 * reconciliation the menu uses) and pass it to `openSession`, so a session
 * already running under a non-id-bearing window (`cl-wi-…`/`cl-pr-…`) is
 * navigated to rather than duplicated. A restored-but-unopened placeholder squats
 * the canonical name but isn't a real agent, so we kill it first — otherwise
 * `openSession` would "navigate" onto the idle bash pane and falsely report success.
 */
export async function runResume(token: string | undefined, attach: boolean): Promise<void> {
  const id = requireToken(token);
  const index = await SessionIndex.build();
  const s = requireSession(index.all, id);
  const { liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const canon = sessionName(s);
  const liveWindow = liveWindows.get(canon);
  if (!liveWindow) {
    const peer = await peerOf(s);
    if (peer) refuseRunningElsewhere(s, peer);
    // A dormant placeholder holds the canonical name but no live agent; drop it so
    // the resume actually starts one instead of no-op'ing onto the idle bash pane.
    if (livePlaceholders.has(canon)) killWindow(canon);
  }
  const plan = openSession(s, liveWindow);
  if (attach) {
    const [cmd, ...args] = plan.handover;
    spawnSync(cmd, args, { stdio: "inherit" });
    return;
  }
  reportResumed(s, plan);
}
