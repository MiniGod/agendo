// `agendo remote` — the cross-machine read as a standalone command, and the
// proof that agendo's detection layer is already machine-independent.
//
// With no argument it lists the machines beam has registered. With one it lists
// that machine's live managed (`cl-…`) windows and classifies each one's pane,
// using the SAME pure functions the local path uses — `paneReadiness`,
// `paneBackgroundAgents`, `paneUsageLimited` are functions of a captured string
// and do not know or care which machine produced it.
//
// The reading itself lives in remoteSessions.ts, which `agendo ls` and the TUI
// share. What is left here is the rendering and the argument parsing.
import { shortId } from "../tmux.ts";
import { formatResetTime } from "../usageLimit.ts";
import { loadHosts, probeHost } from "../remote.ts";
import { readHost, type RemoteWindow } from "../remoteSessions.ts";
import { printJson } from "../output.ts";

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
