// Where a tmux command runs.
//
// agendo has always talked to tmux by bare local subprocess — `spawnSync("tmux",
// [...])`. That is correct and cheap for this machine and wrong for every other
// one. This module is the single seam that answers "which machine?", so the
// fourteen call sites in tmux.ts can keep saying `tmux <args>` and stop caring.
//
// The transport is `beam` (the owner's "tmux across machines"), used in its
// pass-through form: `beam -H <host> <tmux-args…>` runs those exact arguments
// against that machine's tmux server over ssh. agendo does NOT try to fit its
// needs into beam's own verb set (`ls`/`new`/`attach`/`kill`); it drives tmux
// through beam, unchanged.
//
// WHY THE LOCAL PATH DOES NOT GO THROUGH BEAM. Measured on this machine: a bun
// process costs 15.7 ms, a bare tmux spawn 3.6 ms. A readiness poll over N
// windows is ~2N+3 tmux calls, so routing the local path through beam would add
// ~12 ms × 27 ≈ 325 ms to every poll of a 12-window session — a real regression
// paid on the common path to buy uniformity nobody sees. A null host is
// therefore not "beam with host=local"; it is the direct spawn agendo has always
// done, byte for byte.
//
// For a remote host the 15.7 ms rides alongside a ~20 ms warm ssh round trip
// (0.39–1.13 s cold), which is the cost that actually matters.

import { spawnSync, type SpawnSyncOptions, type SpawnSyncReturns } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { parseJsonFileOr } from "./errors.ts";

/**
 * Which machine a tmux command runs on. `null` means this one — and means it
 * literally, not "the machine beam calls `local`": a null host never spawns
 * beam at all.
 */
export type Host = string | null;

/** A machine agendo can address, as registered with beam. */
export interface RemoteHost {
  /** beam's name for it — the value that goes after `-H`. */
  name: string;
  /** The ssh destination, for display only. agendo never dials it itself. */
  host: string;
  port?: number;
}

/**
 * The exit status beam uses for "I could not reach the host, or could not run
 * tmux there" — as opposed to a status the remote tmux itself returned.
 *
 * This distinction is load-bearing, not cosmetic. `capturePaneRaw` returns null
 * on a non-zero exit and `agendo close` treats a null read as "I could not see
 * this pane, so I will not kill it". If a dropped connection were reported the
 * same way as a tmux that answered "no such pane", a network blip would look
 * like an empty screen — and the guard that stops `close` destroying a session
 * mid-turn would silently disarm.
 *
 * 255 is ssh's own failure code and one tmux does not use in practice (it exits
 * 0 or 1), which is why it is the one beam reserves.
 */
export const TRANSPORT_EXIT = 255;

/**
 * The exit status a POSIX shell uses for "command not found", which is what a
 * machine with no tmux installed answers with.
 *
 * beam passes it through rather than folding it into `TRANSPORT_EXIT`, and that
 * is the right call: rewriting 127 would assert that no tmux invocation can ever
 * legitimately exit 127, which is not provable. It also gives agendo a better
 * warning than "unreachable" for the one host on this machine (`mdos`) that is
 * reachable and simply has no tmux — a problem on the far machine, not on the
 * wire.
 */
export const NO_TMUX_EXIT = 127;

/**
 * The beam executable, as argv. `AGENDO_BEAM` overrides it — a space-separated
 * command, so it can name an interpreter (`bun /path/to/src/beam.ts`) and not
 * only a binary.
 *
 * The override exists because beam is not installable as a dependency: it is
 * unpublished (`npm view beam-mux` is a 404) and lives on this machine only as a
 * `bun link` from a checkout. agendo therefore treats it as an external tool it
 * *may* find on PATH, never as something it can require — which also means a
 * development build can be pointed at without disturbing the linked one.
 */
export function beamCommand(): string[] {
  const override = process.env.AGENDO_BEAM?.trim();
  if (override) return override.split(/\s+/);
  return ["beam"];
}

/**
 * Full argv for running a tmux command on `host`.
 *
 * The arguments are forwarded to beam untouched. In particular agendo does NOT
 * fold the host into the tmux target: a tmux target is already `=session:=window`
 * (see `windowTarget`), and beam's own target grammar is `remote:session` split
 * on the FIRST colon — so a combined `vm:=session:=window` would parse as the
 * session name `=session:=window` and resolve to nothing. The host is a separate
 * axis and stays one.
 */
export function tmuxArgv(host: Host, args: string[]): string[] {
  if (host === null) return ["tmux", ...args];
  return [...beamCommand(), "-H", host, ...args];
}

/** beam's config file, honouring the same env/XDG chain beam itself uses. */
function beamConfigPath(): string {
  const override = process.env.BEAM_CONFIG_DIR;
  if (override) return join(override, "config.json");
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdg, "beam", "config.json");
}

/**
 * The machines beam knows about, in name order.
 *
 * Read from beam's own config rather than a second list of agendo's, because a
 * user who has registered a machine once should not have to register it twice
 * and keep the two in sync. Nothing here is written back: this is a read of
 * someone else's file, and a shape agendo does not own.
 *
 * A missing file is not an error — it is the ordinary state of a machine where
 * beam was never set up, and it means exactly "no remote hosts".
 */
export function loadHosts(): RemoteHost[] {
  const path = beamConfigPath();
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return []; // unreadable (permissions, races) — nothing to diagnose
  }
  const cfg = parseJsonFileOr<{ remotes?: Record<string, { host?: string; port?: number }> }>(text, path, {});
  const remotes = cfg && typeof cfg === "object" ? cfg.remotes : undefined;
  if (!remotes || typeof remotes !== "object") return [];
  const out: RemoteHost[] = [];
  for (const name of Object.keys(remotes).sort()) {
    const r = remotes[name];
    if (!r || typeof r !== "object" || typeof r.host !== "string") continue;
    out.push({ name, host: r.host, ...(typeof r.port === "number" ? { port: r.port } : {}) });
  }
  return out;
}

/** Whether `name` is a machine beam has registered. */
export function knownHost(name: string): boolean {
  return loadHosts().some((h) => h.name === name);
}

/**
 * Run a tmux command on `host` (null = this machine) and capture its output.
 *
 * The ONE place tmux arguments become a process. Every reader in tmux.ts goes
 * through it, so adding a machine to a call is passing one more argument rather
 * than rewriting a spawn.
 */
export function runTmux(
  host: Host,
  args: string[],
  opts: Omit<SpawnSyncOptions, "encoding"> = {},
): SpawnSyncReturns<string> {
  const argv = tmuxArgv(host, args);
  // The encoding is fixed, not an option: every caller here reads text, and a
  // caller that could turn it into a Buffer would silently change the type of
  // `stdout` for all of them.
  return spawnSync(argv[0]!, argv.slice(1), { ...opts, encoding: "utf-8" });
}

/** What a probe of a machine found. */
export interface HostProbe {
  ok: boolean;
  /** Why it is not usable, phrased for a warning line. Null when ok. */
  error: string | null;
  /** True when beam itself could not be run (not installed / bad AGENDO_BEAM). */
  missingBeam: boolean;
}

/**
 * Ask a machine whether its tmux is usable, once, before a run of per-window
 * reads that would each pay the same failure.
 *
 * This exists because a registered-but-unusable machine is an ordinary steady
 * state, not an edge case: `mdos` on this machine is reachable over Teleport and
 * has no tmux at all, and takes ~0.8 s to say so. Paying that per window turns a
 * listing into a stall, and reporting it per window turns one fact into N
 * identical warnings.
 *
 * The three outcomes are kept apart because their fixes are different: beam not
 * installed is a local setup problem, an unreachable host is a network/ssh
 * problem, and a reachable host without tmux is a problem on the far machine.
 */
export function probeHost(host: string): HostProbe {
  const r = runTmux(host, ["list-sessions", "-F", "#{session_name}"]);
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, missingBeam: true, error: `beam not found (\`${beamCommand()[0]}\`) — set AGENDO_BEAM or install it` };
    }
    return { ok: false, missingBeam: false, error: r.error.message };
  }
  // tmux exits non-zero for "no server running", which is a machine with zero
  // sessions and not a failure — the same call answers both, so the text has to
  // separate them (beam's own `isNoServerError` makes the identical judgement).
  const err = (r.stderr ?? "").trim();
  if (r.status === 0) return { ok: true, error: null, missingBeam: false };
  if (/no server running|no such file or directory/i.test(err)) {
    return { ok: true, error: null, missingBeam: false };
  }
  if (r.status === TRANSPORT_EXIT) {
    return { ok: false, missingBeam: false, error: err || "unreachable" };
  }
  // Reachable, but nothing to talk to. Worth its own phrasing: the fix is on the
  // far machine (install tmux), not here and not on the network. beam appends its
  // own hint line to stderr, so keep only the shell's sentence.
  if (r.status === NO_TMUX_EXIT) {
    const shell = err.split("\n").find((l) => /command not found|not found/i.test(l))?.trim();
    return { ok: false, missingBeam: false, error: shell || "no tmux installed there" };
  }
  return { ok: false, missingBeam: false, error: err || `exit ${r.status}` };
}

/**
 * The argv that ATTACHES a terminal to a window on `host`.
 *
 * Not pass-through, and that distinction is the whole of it. Pass-through
 * (`tmuxArgv`) deliberately allocates no tty — `-t` would let the line
 * discipline rewrite `\n` as `\r\n` and destroy the byte-exactness every pane
 * read depends on. An attach needs exactly the tty pass-through refuses, so it
 * goes through beam's own `attach` verb instead of through tmux.
 *
 * The target is beam's own `host:session:window` grammar, NOT a tmux target
 * string: beam splits the host at the first colon and the session at the next
 * (tmux forbids `:` in a session name, so that split is unambiguous), and
 * applies its own `=`-exact-match discipline to both halves. Handing it a
 * pre-built `=session:=window` would double that up.
 *
 * Two flags, and agendo needs both on every attach:
 *
 * - `--exec` replaces this process with the attach rather than opening a window.
 *   agendo has already made the local tmux window and beam is its command, so
 *   without this beam would see `$TMUX` set and open a SECOND window inside it.
 * - `--no-create` makes a missing target fail instead of being created. A stale
 *   row or a mistyped name must never spawn a session on someone else's machine.
 *   (A window target never creates in any case; this covers the session form.)
 *
 * Landing on the right window costs no extra round trip: tmux resolves the `-t`
 * target BEFORE opening the terminal, so `attach-session -t '=session:=window'`
 * selects that window as part of attaching. Verified here on a throwaway server
 * and again by beam's own suite. No `select-window` is sent — one would move the
 * active window for everyone else attached there even when the attach then fails.
 *
 * KNOWN LIMIT, inherited from tmux and not from beam: a window name containing a
 * `.` breaks tmux's own target parsing (it reads the dot as the start of a pane
 * part). agendo's managed names are `cl-<kind>-<hex>`, so none can contain one.
 */
export function beamAttachArgv(host: string, session: string, window: string | null): string[] {
  const target = window === null ? `${host}:${session}` : `${host}:${session}:${window}`;
  return [...beamCommand(), "attach", "--exec", "--no-create", target];
}

/**
 * Split a tmux target of the form `=session:=window` (or a bare `=session`) back
 * into its two plain names.
 *
 * agendo builds those targets to address tmux directly; beam wants the names.
 * Rather than keep a second copy of the session/window pair on every row, the
 * one target each row already carries is taken apart here.
 */
export function splitTarget(target: string): { session: string; window: string | null } {
  const unpin = (x: string) => (x.startsWith("=") ? x.slice(1) : x);
  const colon = target.indexOf(":");
  if (colon === -1) return { session: unpin(target), window: null };
  const window = target.slice(colon + 1);
  return { session: unpin(target.slice(0, colon)), window: window === "" ? null : unpin(window) };
}
