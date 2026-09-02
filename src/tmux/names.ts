// The launcher's naming convention. A managed agent's tmux target is named
// `cl-<kind>-<id>`, and everything that has to recognise one — live-window
// attribution, restore snapshots, the CLI's `-t` arguments — starts here.
//
// Pure string work, plus the two environment probes. Nothing here talks to a
// tmux server, which is what lets `server.ts` import it rather than the reverse.
import { spawnSync } from "child_process";
import type { AgentSession } from "../types.ts";

/**
 * The default host session the `--tmux` flag creates/attaches when the launcher
 * is unscoped (bare `agendo`). Path-scoped launchers derive their own host
 * session name (see context.ts), so every launcher-session helper below takes an
 * explicit session param defaulting to this — keeping the bare-`agendo` path
 * byte-identical to before.
 */
export const LAUNCHER_SESSION = "agendo";

/**
 * tmux *session* option storing the absolute path a launcher host session is
 * scoped to. Set once when the session is created; read to detect basename
 * collisions (two different roots wanting the same host session name).
 */
export const ROOT_OPTION = "@cl_root";

/**
 * tmux *window* user-option that flags a restored-but-unopened placeholder
 * window (see restore.ts). Set on the window when a lazy tab is recreated and
 * cleared by the placeholder's own script the moment it resumes for real, so
 * `refreshLiveTmux` can keep an idle placeholder out of the live set even though
 * its window carries the canonical `cl-<source>-<id>` name.
 */
export const PLACEHOLDER_OPTION = "@cl_placeholder";

/**
 * tmux *pane* user-option naming the managed target a pane hosts.
 *
 * Managed sessions are normally identified by a `cl-…` window (or session) name.
 * The global orchestrator breaks that: it runs as a split pane BESIDE the menu,
 * inside the launcher's own window, which keeps its own `launcher` name — so
 * there is no `cl-…` name anywhere for the discovery pass to see, and the session
 * would look dead to `list`, to the TUI and to `send`. Stamping the pane with its
 * managed name puts it back on the one discovery path (`liveManagedPaths`), and
 * the pane id read alongside it is a first-class tmux target, so capture /
 * send-keys / navigate all work against it unchanged.
 */
export const PANE_TARGET_OPTION = "@cl_pane_target";

/**
 * Minimum width (columns) of the PANE a split would cut in two before doing it is
 * worth it — the pane, not the window, because that is what tmux halves (see
 * `splitTargetWidth`). Each half has to hold a full agent TUI — claude's own
 * layout starts wrapping badly under ~74 columns — so below this the split
 * produces two unusable panes and a separate window is the better answer.
 * Callers fall back rather than refuse.
 */
export const MIN_SPLIT_COLS = 150;

/**
 * Whether a tmux target string is a pane id (`%42`) rather than a name. Pane ids
 * are the only targets the launcher mints that are not managed names, and they
 * need no `exactTarget` pin — tmux resolves `%N` by identity, so the prefix
 * hazard `exactTarget` exists for cannot apply.
 */
export function isPaneTarget(target: string): boolean {
  return /^%\d+$/.test(target);
}

export function tmuxAvailable(): boolean {
  return spawnSync("tmux", ["-V"], { encoding: "utf-8" }).status === 0;
}

export function insideTmux(): boolean {
  return !!process.env.TMUX;
}

/** The short, tmux-safe slice of a session id used in every managed name. */
export function shortId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
}

/** Deterministic tmux session/window name for an agent session. */
export function sessionName(s: Pick<AgentSession, "source" | "id">): string {
  return `cl-${s.source}-${shortId(s.id)}`;
}

/**
 * How a managed tmux target was launched, inferred from its name prefix. Lets
 * the UI badge sessions and the model attribute live windows back to a session.
 * `cl-free-` is the pre-rename manual prefix, still recognized so older windows
 * keep working.
 */
export type SessionKind = "background" | "new" | "workitem" | "pr" | "resumed";

/** Name prefixes for the two kind-tagged launcher flows. */
const KIND_PREFIX = { background: "cl-bg-", new: "cl-new-" } as const;

/**
 * Managed names that carry a session short id.
 *
 * The suffix must be short-id SHAPED — `shortId` strips every non-alphanumeric
 * character and caps at 12, so a real id can only ever be `[a-zA-Z0-9]{1,12}`.
 * Anchoring on that is what lets `kindName` mint a deliberately ID-LESS fresh
 * name (see its `tag` parameter): the extra `<tag>-` segment contains a dash, so
 * the name falls out of this pattern and attribution takes the cwd route that
 * `cl-wi-…`/`cl-pr-…` already use. Shared with restore.ts's ID_BEARING.
 */
export const ID_BEARING_NAME = /^cl-(?:claude|copilot|codex|bg|new)-([a-zA-Z0-9]{1,12})$/;

/**
 * tmux target name for a background (agent-spawned) or manual new session.
 *
 * `tag`, when given, inserts a `<tag>-` segment before the id and thereby makes
 * the name id-LESS as far as `ID_BEARING_NAME` is concerned. That's for agents
 * whose CLI can't be told a session id up front (Codex): the id we mint is only
 * a uniquifier for the window, and must not be mistaken for a resumable session
 * id — the real one is discovered from disk and matched by cwd instead.
 */
export function kindName(kind: "background" | "new", id: string, tag?: string): string {
  return KIND_PREFIX[kind] + (tag ? `${tag}-` : "") + shortId(id);
}

/** Classify a managed (`cl-…`) target name by its prefix, or null if unknown. */
export function managedKind(name: string): SessionKind | null {
  if (name.startsWith(KIND_PREFIX.background)) return "background";
  if (name.startsWith(KIND_PREFIX.new) || name.startsWith("cl-free-")) return "new";
  if (name.startsWith("cl-wi-")) return "workitem";
  if (name.startsWith("cl-pr-")) return "pr";
  if (name.startsWith("cl-claude-") || name.startsWith("cl-copilot-") || name.startsWith("cl-codex-")) return "resumed";
  return null;
}

/**
 * A live managed target: the bare `name` it is known and attributed by, and the
 * fully-qualified `target` that addresses it from ANY host session.
 *
 * These are NOT interchangeable, and conflating them is what #39 was: tmux
 * resolves a bare window-name target only inside the caller's own session, so
 * with several launcher hosts live, every read of a window in another host
 * failed and readiness fell through to `unknown` — `list`/`status` reported a
 * whole host's sessions as unknown, and `close`/`unblock` refused targets they
 * "could not read".
 *
 * `name` stays the attribution and display key (`windowLocations`,
 * `killManagedTarget`, `openTarget`, restore snapshots and user-facing output
 * are all written against it); `target` is the only form that may be handed to
 * tmux as `-t`. Carrying both makes a caller say which it means.
 */
export interface LiveTarget {
  name: string;
  target: string;
}

/** A `LiveTarget` paired with the working directory of the pane running in it. */
export interface ManagedTarget extends LiveTarget {
  cwd: string;
  placeholder: boolean;
}

/**
 * Whether a managed target lives in a pane of somebody else's window rather than
 * in a window or session of its own. The two are addressed identically once
 * resolved — that is the point of carrying `target` — but only the pane-hosted
 * one is invisible to the name-based lookups (`liveWindows`, `liveTargets`,
 * `hasSession`), which is what callers actually need to know.
 */
export function isPaneHosted(t: ManagedTarget): boolean {
  return isPaneTarget(t.target);
}

