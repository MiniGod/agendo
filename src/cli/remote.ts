// `agendo remote` — the cross-machine read, and the proof that agendo's
// detection layer is already machine-independent.
//
// With no argument it lists the machines beam has registered. With one it lists
// that machine's live managed (`cl-…`) windows and classifies each one's pane,
// using the SAME pure functions the local path uses — `paneReadiness`,
// `paneBackgroundAgents`, `paneUsageLimited` are functions of a captured string
// and do not know or care which machine produced it.
//
// HOW MUCH IDENTITY TMUX ALONE CARRIES — more than expected, and this is the
// point of the command. Verified read-only against a live remote:
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
// PR / work item (derived from the branch). Those are named honestly below
// rather than faked.
import {
  capturePaneState, liveManagedPaths, managedKind, paneBackgroundAgents,
  paneReadiness, paneShells, shortId, stripAnsi, tmuxLines, type Readiness,
} from "../tmux.ts";
import { paneResetAt, formatResetTime } from "../usageLimit.ts";
import { loadHosts, probeHost } from "../remote.ts";
import { printJson } from "../output.ts";

interface RemoteWindow {
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
 * The launch argv of every pane, keyed `session\twindow`.
 *
 * A separate call from the metadata below because BOTH fields can contain the
 * separator, and a format may only have one variable-width field — which has to
 * be last. Same rule beam applies to its own `tmux ls` format, and for the same
 * reason. Two 20 ms calls beats one ambiguous parse.
 */
function paneField(host: string, field: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of tmuxLines(["list-panes", "-a", "-F", `#{session_name}\t#{window_name}\t${field}`], host)) {
    const i = line.indexOf("\t");
    const j = line.indexOf("\t", i + 1);
    if (i === -1 || j === -1) continue;
    out.set(line.slice(0, j), line.slice(j + 1));
  }
  return out;
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
export function paneLookup(map: Map<string, string>, target: string, name: string): string | undefined {
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
function readHost(host: string): RemoteWindow[] {
  const out: RemoteWindow[] = [];
  const starts = paneField(host, "#{pane_start_command}");
  const titles = paneField(host, "#{pane_title}");
  const acts = paneField(host, "#{window_activity}");
  const now = Math.floor(Date.now() / 1000);
  for (const { name, target, cwd, placeholder } of liveManagedPaths(host)) {
    if (!managedKind(name)) continue;
    const { id, source } = identify(paneLookup(starts, target, name));
    const title = paneLookup(titles, target, name) || null;
    const actAt = Number(paneLookup(acts, target, name));
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

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Compact age, in the same vocabulary the local `list` uses. */
function age(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  if (sec < 172800) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86400)}d`;
}

/** Print the registered machines, or one machine's live agent windows. */
export function runRemote(host: string | undefined, json: boolean): number {
  const hosts = loadHosts();

  if (host === undefined) {
    if (json) {
      printJson(hosts);
      return 0;
    }
    if (hosts.length === 0) {
      console.log("No machines registered. Add one with: beam remote add <name> <user@host>");
      return 0;
    }
    const w = Math.max(4, ...hosts.map((h) => h.name.length));
    console.log(`${pad("NAME", w)}  HOST`);
    for (const h of hosts) {
      console.log(`${pad(h.name, w)}  ${h.host}${h.port ? `:${h.port}` : ""}`);
    }
    return 0;
  }

  if (!hosts.some((h) => h.name === host)) {
    const known = hosts.map((h) => h.name).join(", ") || "none registered";
    console.error(`remote: unknown machine "${host}" (known: ${known})`);
    return 1;
  }

  // Probe once. A registered machine that is reachable and yet unusable — no
  // tmux, as `mdos` is today — must degrade to a warning and an empty list, not
  // to a failure: it is a steady state someone lives with, not a fault to raise.
  const probe = probeHost(host);
  if (!probe.ok) {
    console.error(`warning: ${host}: ${probe.error}`);
    if (json) printJson([]);
    return probe.missingBeam ? 1 : 0;
  }

  const rows = readHost(host);
  if (json) {
    printJson(rows);
    return 0;
  }
  if (rows.length === 0) {
    console.log(`No agent windows on ${host}.`);
    return 0;
  }
  const idOf = (r: RemoteWindow) => (r.id ? shortId(r.id) : "—");
  const dirOf = (r: RemoteWindow) => r.cwd.split("/").pop() || "";
  const iw = Math.max(2, ...rows.map((r) => idOf(r).length));
  const dw = Math.max(3, ...rows.map((r) => dirOf(r).length));
  console.log(`${pad("ID", iw)}  ${pad("READY", 9)}  ${pad("AGE", 6)}  ${pad("DIR", dw)}  TITLE`);
  for (const r of rows) {
    const notes: string[] = [];
    if (r.placeholder) notes.push("restored, not opened");
    if (r.backgroundAgents > 0) notes.push(`${r.backgroundAgents} agent${r.backgroundAgents === 1 ? "" : "s"}`);
    if (r.shells > 0) notes.push(`${r.shells} shell${r.shells === 1 ? "" : "s"}`);
    if (r.limitResetAt) notes.push(`resets ${formatResetTime(Date.parse(r.limitResetAt))}`);
    const title = [r.title ?? r.name, ...notes].join("  ·  ");
    console.log(
      `${pad(idOf(r), iw)}  ${pad(r.readiness, 9)}  ${pad(age(r.idleSeconds), 6)}  ${pad(dirOf(r), dw)}  ${title}`,
    );
  }
  return 0;
}

/**
 * Argument handling for `agendo remote`. Lives here rather than in the dispatch
 * so index.tsx keeps only the one-line hand-off every other cli/* command gets.
 *
 * A dashed token is rejected rather than taken as a machine name, for the same
 * reason `status` rejects one: a typo'd flag that fell through to the positional
 * slot would fail with a baffling `unknown machine "--jsonn"`.
 */
export function runRemoteCli(rest: string[]): number {
  let json = false;
  let host: string | undefined;
  for (const a of rest) {
    if (a === "--json") json = true;
    else if (a.startsWith("-")) {
      console.error(`remote: unknown argument "${a}"`);
      return 1;
    } else if (host === undefined) host = a;
    else {
      console.error(`remote: unexpected argument "${a}"`);
      return 1;
    }
  }
  return runRemote(host, json);
}
