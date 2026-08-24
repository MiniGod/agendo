// `agendo remote` — the cross-machine read, and the proof that agendo's
// detection layer is already machine-independent.
//
// With no argument it lists the machines beam has registered. With one it lists
// that machine's live managed (`cl-…`) windows and classifies each one's pane,
// using the SAME pure functions the local path uses — `paneReadiness`,
// `paneBackgroundAgents`, `paneUsageLimited` are functions of a captured string
// and do not know or care which machine produced it.
//
// WHAT THIS DELIBERATELY DOES NOT DO. It reports windows, not sessions. A
// session's title, branch, idle age, PR link and resume command all come from
// the transcript on the machine the session runs on, and none of that crosses an
// ssh connection cheaply (92 MB of transcripts on the vm; the parse is the
// expensive part, not the transfer). So this shows what tmux alone can honestly
// say — which is "which agent windows exist over there, and is each one busy,
// waiting on a dialog, or at its usage cap". That is a real answer to a real
// question, and it is a smaller answer than `agendo list` gives locally. It says
// so rather than inventing the difference.
import {
  capturePaneState, liveManagedPaths, managedKind, paneBackgroundAgents,
  paneReadiness, paneShells, stripAnsi, type Readiness,
} from "../tmux.ts";
import { paneResetAt, formatResetTime } from "../usageLimit.ts";
import { loadHosts, probeHost } from "../remote.ts";
import { printJson } from "../output.ts";

interface RemoteWindow {
  host: string;
  /** tmux window name — `cl-claude-<shortid>`, `cl-bg-<shortid>`, … */
  name: string;
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
  for (const { name, target, cwd, placeholder } of liveManagedPaths(host)) {
    if (!managedKind(name)) continue;
    // A placeholder is a dormant restored tab — an idle bash, not an agent.
    // Classifying its pane would report a shell prompt as `unknown`, so it is
    // listed and marked rather than measured.
    if (placeholder) {
      out.push({
        host, name, target, cwd, placeholder: true,
        readiness: "unknown", backgroundAgents: 0, shells: 0, limitResetAt: null,
      });
      continue;
    }
    const snap = capturePaneState(target, host);
    const readiness = paneReadiness(snap.raw, snap.cursor);
    const reset = readiness === "limited" ? paneResetAt(stripAnsi(snap.raw)) : null;
    out.push({
      host, name, target, cwd, placeholder: false,
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
  const nw = Math.max(6, ...rows.map((r) => r.name.length));
  const dw = Math.max(3, ...rows.map((r) => (r.cwd.split("/").pop() || "").length));
  console.log(`${pad("WINDOW", nw)}  ${pad("READY", 10)}  ${pad("DIR", dw)}  NOTES`);
  for (const r of rows) {
    const notes: string[] = [];
    if (r.placeholder) notes.push("restored, not opened");
    if (r.backgroundAgents > 0) notes.push(`${r.backgroundAgents} agent${r.backgroundAgents === 1 ? "" : "s"}`);
    if (r.shells > 0) notes.push(`${r.shells} shell${r.shells === 1 ? "" : "s"}`);
    if (r.limitResetAt) notes.push(`resets ${formatResetTime(Date.parse(r.limitResetAt))}`);
    console.log(
      `${pad(r.name, nw)}  ${pad(r.readiness, 10)}  ${pad(r.cwd.split("/").pop() || "", dw)}  ${notes.join(" · ")}`,
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
