// The launcher's naming convention. A managed agent's tmux target is named
// `cl-<kind>-<id>`, and everything that has to recognise one — live-window
// attribution, restore snapshots, the CLI's `-t` arguments — starts here.
//
// Pure string work, plus the two environment probes. Nothing here talks to a
// tmux server, which is what lets `server.ts` import it rather than the reverse.
import { spawnSync } from "child_process";
import type { AgentSession, AgentSource } from "../../shared/types.ts";

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
 * tmux *window* user-options carrying a managed window's SESSION IDENTITY — the
 * window tag. `@cl_session_id` is the only one attribution reads; the rest
 * describe the window for display and for the adoption pass that stamps them.
 *
 * WHY A TAG AT ALL. A managed window has historically been identified by its
 * NAME, and a name can only say what was known when the window was created. For
 * `cl-claude-…`/`cl-copilot-…` that is enough — the launcher chooses the session
 * id up front (`--session-id`) and embeds it. For everything else it is not:
 * `cl-wi-…`/`cl-pr-…` embed a work-item or PR id, and Codex refuses a
 * caller-assigned id outright (`preassignsSessionId`), so its windows carry a
 * uniquifier and nothing more. Those windows fall back to attribution by working
 * directory + most-recently-used session — a heuristic this file's own
 * `ID_BEARING_NAME` comment calls fine for reading a pane but not for killing
 * one, and the reason `agendo close` refuses an id-less window.
 *
 * A window option is the fix because it can be written AFTER the window exists,
 * which is exactly what the name cannot do. It costs no extra tmux round trip
 * either: a user option is readable inline in the `-F` format string the live
 * scan already runs (see `liveManagedPaths`), the same way `@cl_placeholder`
 * above already is.
 *
 * ONLY `@cl_session_id` MAY BE A LOOKUP KEY. The others exist so a window can
 * describe itself — to the expanded row's tmux line, and to a future `close`
 * that wants to treat an ADOPTED window more carefully than one agendo started
 * itself. Making any of them a lookup key would rebuild the ambiguity this
 * replaces: a branch or a PR number identifies a piece of work, never a session,
 * and two sessions on one branch are routine.
 */
export const SESSION_ID_OPTION = "@cl_session_id";
/** Agent that runs in the window (`claude`/`copilot`/`codex`). Display only. */
export const SOURCE_OPTION = "@cl_source";
/**
 * How agendo came to manage this window: `launched` (agendo created it) or
 * `adopted` (it was already running and agendo took it over — see
 * src/app/model/adopt.ts). Display today; a later `close` may read it to be
 * more conservative, since killing a window the user opened by hand is not the
 * same act as killing one agendo opened for them.
 */
export const ACQUIRED_OPTION = "@cl_acquired";
/** Git branch the window was launched on. Display only. */
export const BRANCH_OPTION = "@cl_branch";
/** PR number the window was launched for. Display only. */
export const PR_OPTION = "@cl_pr";
/** Work-item / issue number the window was launched for. Display only. */
export const ITEM_OPTION = "@cl_item";

/**
 * How agendo came to manage a window (see `ACQUIRED_OPTION`). `launched` is
 * every window agendo created itself; `adopted` is one that was already running
 * when agendo took it over — a window the user opened by hand and typed
 * `claude` into, identified and stamped by the adoption pass
 * (src/app/model/adopt.ts).
 */
export type WindowAcquisition = "launched" | "adopted";

/**
 * A managed window's tag: what the window itself says about the session running
 * in it, as read back from the `@cl_*` window options above.
 *
 * Every field is optional, and that is the point rather than laxity. A tag is
 * written from whatever was known at the moment it was stamped, and for the
 * cases this mechanism exists for that is LESS than everything: an agent which
 * assigns its own session id (Codex) can be tagged with its source and its
 * branch at launch and only later with the id itself, and a window agendo did
 * not create can be tagged with nothing until it is identified. A schema that
 * demanded the id up front could serve neither, which is precisely the
 * limitation of encoding identity in the window NAME.
 *
 * Read `sessionId` as authoritative and the rest as description — see
 * `SESSION_ID_OPTION` for why the distinction is load-bearing.
 */
export interface WindowTags {
  /** FULL session id (not the 12-char `shortId` a managed name embeds). */
  sessionId?: string;
  source?: AgentSource;
  acquired?: WindowAcquisition;
  branch?: string;
  pr?: number;
  item?: number;
}

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
  /**
   * Host tmux session name (`#{session_name}`) of the pane this target was read
   * from. Populated by `liveManagedPaths`; a `LiveTarget` built elsewhere (e.g.
   * `liveTargetForShortId`'s non-pane branch) leaves it undefined.
   */
  session?: string;
  /**
   * `#{window_index}` of the window backing this target, or null when the
   * target is pane-hosted — that index would name the pane's HOST window (the
   * launcher menu, typically), not a window of this session's own, so it is
   * dropped rather than shown as this session's.
   */
  windowIndex?: string | null;
}

/** A `LiveTarget` paired with the working directory of the pane running in it. */
export interface ManagedTarget extends LiveTarget {
  cwd: string;
  placeholder: boolean;
  /**
   * The window's own tag, when it carries one (see `WindowTags`). Undefined for
   * every window created before tagging shipped, and for a pane-hosted session
   * — the tag is a WINDOW option, and a pane-hosted session's window belongs to
   * somebody else (the launcher menu), so its tag would describe that window
   * rather than this session. Attribution treats the absent case exactly as it
   * did before there were tags at all.
   */
  tags?: WindowTags;
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

