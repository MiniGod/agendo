// Reading agent sessions off ANOTHER machine, using nothing but its tmux server.
//
// This is the layer `agendo remote`, `agendo ls` and the TUI share. It answers
// one question — "what is running over there, and is any of it stuck?" — and it
// answers it without an agendo, a transcript, or any file at all on the far
// machine. Everything comes from tmux, through the transport seam in remote.ts.
//
// HOW MUCH IDENTITY TMUX ALONE CARRIES — more than expected, and this is the
// point of the module. Verified read-only against a live remote:
//
//   pane_start_command   env CLAUDE_CONFIG_DIR=/home/k/.claude claude --resume
//                        0fe53844-cc68-4f89-aac2-3ff54a04d1a4 --append-system-prompt "…"
//   pane_title           ✳ Use Fable and Opus sub agents for code review
//   window_activity      1787530836
//
// So the FULL session id, the provider, the config profile, the exact resume
// argv and the session title are all recoverable from the tmux server, with no
// transcript read at all. The transcript is what agendo has always used, but it
// is not the only place these facts live.
//
// WHAT IS STILL MISSING, and is not recoverable this way: the git branch and
// whether it holds unpushed commits (those are `.git` files on the far machine),
// the task checklist and recent activity (transcript records), and the linked
// PR / work item (derived from the branch). Those are left absent rather than
// faked — `AgentSession` already marks every one of them optional, which is why
// a remote session fits the type agendo has always used.
import {
  capturePaneState, liveManagedPaths, managedKind, paneBackgroundAgents,
  paneReadiness, paneShells, stripAnsi, tmuxLines, type Readiness,
} from "./tmux.ts";
import { paneResetAt } from "./usageLimit.ts";
import { loadHosts, probeHost } from "./remote.ts";
import type { AgentSession, AgentSource } from "./types.ts";

export interface RemoteWindow {
  host: string;
  /** tmux window name — `cl-claude-<shortid>`, `cl-bg-<shortid>`, … */
  name: string;
  /** Full session UUID, recovered from the pane's launch argv. Null when the
   *  pane was not started by agendo (a plain shell, or a window whose original
   *  command tmux no longer reports). */
  id: string | null;
  /** The agent binary the pane was launched with, when it can be told. */
  source: string | null;
  /** Session title, as the agent set the terminal title. */
  title: string | null;
  /** Seconds since the pane last painted (tmux's own `window_activity`). */
  idleSeconds: number | null;
  /** The `=session:=window` form, the only thing handed to tmux as `-t`. */
  target: string;
  cwd: string;
  readiness: Readiness;
  backgroundAgents: number;
  shells: number;
  limitResetAt: string | null;
  placeholder: boolean;
}

/**
 * Pane fields for every pane, keyed `session\twindow`.
 *
 * `fixed` are fields whose value cannot contain the tab separator (a numeric
 * clock, a flag); `tail` is the one that can — a pane title or a launch argv —
 * and it therefore goes last and takes the whole remainder of the line. This is
 * a parsing rule, not a tmux limit: tmux is happy to interpolate any number of
 * fields, but only the last one can be recovered unambiguously. It is the same
 * rule beam applies to its own `tmux ls` format, for the same reason.
 *
 * So an arbitrary-valued field costs a call and a bounded one rides along free.
 * That matters more over beam than it does locally: a beam call is ~45 ms of
 * which ~30 ms is process startup (see docs/remote-machines.md §11.2), so a read
 * folded in here is 45 ms that is simply not spent.
 */
function paneFields(host: string, fixed: string[], tail: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const format = ["#{session_name}", "#{window_name}", ...fixed, tail].join("\t");
  for (const line of tmuxLines(["list-panes", "-a", "-F", format], host)) {
    const parts = line.split("\t");
    // 2 key fields + the fixed ones + at least an (empty) tail.
    if (parts.length < fixed.length + 3) continue;
    const key = `${parts[0]}\t${parts[1]}`;
    const head = parts.slice(2, 2 + fixed.length);
    // Anything past the fixed fields is the tail, tabs and all.
    out.set(key, [...head, parts.slice(2 + fixed.length).join("\t")]);
  }
  return out;
}

/** One field of `paneFields`, by index, for a managed target. */
function fieldAt(map: Map<string, string[]>, target: string, name: string, i: number): string | undefined {
  return paneLookup(map, target, name)?.[i];
}

/**
 * Look a pane field up for a managed target.
 *
 * `liveManagedPaths` reports a name that is EITHER a window (agendo running
 * inside tmux — the usual case, and every window on the vm) or a whole SESSION
 * (agendo started outside tmux names the session `cl-…` instead). The two
 * address differently — `=session:=window` versus `=session` — so the session
 * half has to come from the target, and the session case has no window name to
 * key on at all.
 *
 * The fallback is therefore gated on `name === session`: for a managed session,
 * any pane in it is the right one, since it has exactly the one. Ungated, a
 * window whose key merely missed would silently inherit a DIFFERENT window's
 * session id and title — a wrong answer dressed as a right one.
 */
export function paneLookup<T>(map: Map<string, T>, target: string, name: string): T | undefined {
  const session = target.replace(/^=/, "").split(":")[0] ?? "";
  const exact = map.get(`${session}\t${name}`);
  if (exact !== undefined || name !== session) return exact;
  for (const [k, v] of map) if (k.startsWith(`${session}\t`)) return v;
  return undefined;
}

/** Full session id and provider from a pane's launch argv, when it has one. */
export function identify(cmd: string | undefined): { id: string | null; source: string | null } {
  if (!cmd) return { id: null, source: null };
  // Three forms appear, one per provider's resume grammar: `--resume <uuid>`
  // (claude), `--resume=<uuid>` (copilot), and a POSITIONAL `resume <uuid>`
  // (codex) — hence the optional dashes. `--session-id <uuid>` is the fresh
  // launch, where agendo mints the id up front so it can name the window before
  // the agent has written anything.
  const id = /(?:--)?(?:resume|session-id)[= ]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(cmd);
  const src = /\b(claude|copilot|codex)\b/.exec(cmd);
  return { id: id ? id[1]! : null, source: src ? src[1]! : null };
}

/**
 * Every managed window on `host`, each with its pane classified.
 *
 * One `list-panes` for the enumeration, then two reads per window (the capture
 * and the caret). At a measured 20 ms per warm round trip that is 2N+1 calls;
 * collapsing the pair into one chained tmux invocation is the obvious next
 * optimisation and is deliberately not done yet — correctness first, and the
 * chained form's output shape is one more thing to get wrong.
 */
export function readHost(host: string): RemoteWindow[] {
  const out: RemoteWindow[] = [];
  // Two reads, not three: `window_activity` is a bare epoch second, so it cannot
  // contain the separator and rides along with the title for free.
  const starts = paneFields(host, [], "#{pane_start_command}");
  const meta = paneFields(host, ["#{window_activity}"], "#{pane_title}");
  const now = Math.floor(Date.now() / 1000);
  for (const { name, target, cwd, placeholder } of liveManagedPaths(host)) {
    if (!managedKind(name)) continue;
    const { id, source } = identify(fieldAt(starts, target, name, 0));
    const title = fieldAt(meta, target, name, 1) || null;
    const actAt = Number(fieldAt(meta, target, name, 0));
    // tmux's activity clock is the REMOTE machine's. Differencing it against a
    // local `now` is only honest while the two agree — they do here (checked:
    // identical `date +%s`), but this is a stated assumption, not a guarantee.
    const idleSeconds = Number.isFinite(actAt) && actAt > 0 ? Math.max(0, now - actAt) : null;
    // A placeholder is a dormant restored tab — an idle bash, not an agent.
    // Classifying its pane would report a shell prompt as `unknown`, so it is
    // listed and marked rather than measured.
    if (placeholder) {
      out.push({
        host, name, target, cwd, placeholder: true, id, source, title, idleSeconds,
        readiness: "unknown", backgroundAgents: 0, shells: 0, limitResetAt: null,
      });
      continue;
    }
    const snap = capturePaneState(target, host);
    const readiness = paneReadiness(snap.raw, snap.cursor);
    const reset = readiness === "limited" ? paneResetAt(stripAnsi(snap.raw)) : null;
    out.push({
      host, name, target, cwd, placeholder: false, id, source, title, idleSeconds,
      readiness,
      backgroundAgents: paneBackgroundAgents(snap.raw),
      shells: paneShells(snap.raw),
      limitResetAt: reset === null ? null : new Date(reset).toISOString(),
    });
  }
  return out;
}

/**
 * A remote window as the `AgentSession` the rest of agendo already speaks.
 *
 * Three fields are weaker than their local counterparts, and saying so here is
 * cheaper than discovering it downstream:
 *
 * - `id` falls back to the WINDOW NAME when the pane's launch argv carries no
 *   UUID (a pane tmux reports no start command for). It is still unique per
 *   machine, so it still addresses one row; it is just not resumable.
 * - `source` is read from the launch argv, else inferred from the window-name
 *   prefix, else `claude` — agendo's default agent. Only `cl-claude-`/
 *   `cl-copilot-`/`cl-codex-` names encode a provider, so a `cl-bg-…` window
 *   whose start command tmux has forgotten is a guess. It affects the badge and
 *   nothing else: a remote row is addressed by the `target` tmux gave us, never
 *   by a name rebuilt from `source`.
 * - `lastUsed` is tmux's last-PAINT time, not a transcript mtime. It freezes for
 *   a settled session and moves for a working one — which is what `stalled`
 *   wants — but it is a different number from the one a local row shows.
 */
export function remoteSession(w: RemoteWindow): AgentSession {
  const fromName = /^cl-(claude|copilot|codex)-/.exec(w.name)?.[1] as AgentSource | undefined;
  return {
    id: w.id ?? w.name,
    source: (w.source as AgentSource | null) ?? fromName ?? "claude",
    cwd: w.cwd,
    title: w.title ?? w.name,
    lastUsed: new Date(Date.now() - (w.idleSeconds ?? 0) * 1000),
    host: w.host,
  };
}

/** What a sweep of one or more machines found, warnings included. */
export interface RemoteSweep {
  windows: RemoteWindow[];
  /** One line per machine that could not be read. Never throws — an unreachable
   *  machine contributes zero rows and one warning, the contract beam's own
   *  `ls` uses and the reason a dead host cannot fail the whole listing. */
  warnings: string[];
}

/**
 * Read every machine in `hosts` (empty means every machine beam has registered).
 *
 * Each machine is probed ONCE before its per-window reads. A registered-but-
 * unusable machine is an ordinary steady state, not an edge case — `mdos` here
 * is reachable over Teleport and has no tmux at all, and takes ~0.8 s to say so.
 * Paying that per window turns a listing into a stall, and reporting it per
 * window turns one fact into N identical warnings.
 */
export function sweepRemotes(hosts: string[]): RemoteSweep {
  const names = hosts.length > 0 ? hosts : loadHosts().map((h) => h.name);
  const windows: RemoteWindow[] = [];
  const warnings: string[] = [];
  // Asking for every machine and getting none is not the same as not asking.
  // Silence here reads as "no sessions over there" when the truth is "beam has
  // no machines registered" — a setup step, not an empty result.
  if (names.length === 0) {
    return { windows, warnings: ["--remote: beam has no machines registered (see: beam remote add)"] };
  }
  for (const name of names) {
    const probe = probeHost(name);
    if (!probe.ok) {
      warnings.push(`${name}: ${probe.error}`);
      continue;
    }
    windows.push(...readHost(name));
  }
  return { windows, warnings };
}
