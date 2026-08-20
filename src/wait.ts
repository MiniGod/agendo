/**
 * `agendo wait` — block until watched session(s) change state, so a caller can
 * be TOLD rather than poll.
 *
 * This is the notification primitive for an orchestrator running background
 * sessions. The intended shape is: start the wait in the background and let its
 * EXIT be the wake-up. Re-running `status` on a guessed cadence is the failure
 * mode this exists to remove — it either fires too often (wasted turns) or too
 * late (stale answer), and the caller has no way to pick the right interval.
 *
 * Cost: polling for state has to happen somewhere, and it happens here on the
 * cheap path only. The transcript-backed `SessionIndex` is built ONCE, up front,
 * to resolve ids; the loop itself never rebuilds it. Each tick does exactly one
 * `refreshLiveTmux` (the same list-sessions/list-windows/list-panes reads the TUI
 * already makes) plus one pane capture per live target. No transcript is read or
 * parsed by the loop — see the parse-count assertion in e2e/sessions-cache.spec.ts.
 * Latency therefore bottoms out at `--interval`.
 */
import { basename } from "path";
import {
  capturePaneState, isSettledReadiness, paneReadiness, paneResumeDialogActive,
  sessionName, shortId, stripAnsi,
  type Readiness,
} from "./tmux.ts";
import { formatResetTime, paneResetAt } from "./usageLimit.ts";
import { SessionIndex } from "./sessions.ts";
import { refreshLiveTmux } from "./model.ts";
import { makeSessionScope, scopeFilter, scopeFlagValue, scopeNote, type SessionScope } from "./scope.ts";
import { printJson } from "./output.ts";
import { notRunningHint, SELF_CMD } from "./launch.ts";
import type { AgentSession } from "./types.ts";

/**
 * Consecutive polls a target must be absent from the live set before `wait`
 * declares it `exited`. Two, because one absence is indistinguishable from a
 * transient tmux read failure — and `exited` is a terminal verdict that ends the
 * wait, so a false one is unrecoverable. See `poll()`.
 */
const EXIT_CONFIRM_TICKS = 2;

/**
 * Consecutive `limited` sightings before `wait` wakes with `blocked`. Two, for
 * the same reason as EXIT_CONFIRM_TICKS: the wake is terminal, and `limited` has
 * a real transient. The TUI's auto-resume sends one Escape to reveal the reset
 * notice, and the pane it uncovers — notice above an idle input box — reads
 * `limited` for a tick or two before generation restarts. Waking off that single
 * sighting would report a session as capped at the exact moment it was being
 * un-capped, with a reset instant already in the past.
 */
const LIMIT_CONFIRM_TICKS = 2;

/**
 * What `agendo wait` can observe about a target. A superset of pane `Readiness`
 * with one synthetic member: `exited`, meaning the session's tmux window is gone
 * (the agent finished and closed, or was killed). There is no pane left to read,
 * so it can't be a `Readiness` — a dead target captures as an empty string, which
 * `paneReadiness` classifies as `unknown`, and `unknown` is deliberately excluded
 * from the settled set. That combination made the most common orchestrator wait —
 * "tell me when the background session is DONE" — report a spurious timeout.
 * Naming the state instead makes it both waitable (`--state exited`) and TERMINAL:
 * an exited target can never change again, so the poll loop stops rather than
 * burning the full timeout on a target that will never satisfy the predicate.
 */
export type WaitState = Readiness | "exited";

/** Accepted `--state` / `--not` values. Enumerated (rather than derived) so the
 *  error message lists them; `limited` is included — it's a real readiness the
 *  old list omitted, which made "wake me when it hits its usage cap" unwaitable.
 *
 *  `dialog` means a question awaiting a HUMAN decision. The claude CLI's own
 *  resume dialog is deliberately not one: `paneReadiness` reports it `ready`
 *  (see `paneResumeDialogActive`), because `send` answers it itself. So a
 *  `--state dialog` wait won't wake on a session merely parked on that. */
export const WAIT_STATES: WaitState[] = [
  "ready", "busy", "compacting", "queued", "dialog", "limited", "unknown", "exited",
];

export interface WaitOptions {
  ids: string[];
  all: boolean;
  /** Wake on the FIRST target to satisfy, instead of requiring all of them. */
  any: boolean;
  /** Emit the structured wake payload on stdout instead of `<id>\t<state>` lines. */
  json: boolean;
  prefix?: string;
  /**
   * `--repo` / `--path` scope; null when neither was given. NOT a third way to
   * choose the target set alongside `ids` / `--all` / `--prefix`, but a filter
   * applied ON TOP of whichever of those did the choosing — see `runWait`.
   */
  scope: SessionScope | null;
  /** Desired state (exact match). Overrides the default non-busy predicate. */
  state?: WaitState;
  /** Wait until the state is anything but this. */
  not?: WaitState;
  timeoutMs: number;
  intervalMs: number;
}

/** One target's state at wake time. `changed` compares against the state seen on
 *  the very first poll, so a caller learns not just where each session ended up
 *  but which one actually moved — the thing it woke up to find out. */
export interface WaitResult {
  id: string;
  shortId: string;
  state: WaitState;
  /** State on the first poll, for the caller to see the transition it woke on. */
  from: WaitState;
  changed: boolean;
  satisfied: boolean;
  cwd: string;
  title: string;
  /** tmux window the session occupies now; the one resolved at startup if it has
   *  since gone away. */
  window: string;
  /** When a `limited` session's cap resets, ISO 8601, or null when the pane
   *  states no time (the numbered limit dialog hides it) or it isn't limited.
   *  Same instant `agendo list --json` reports, so a caller woken by `blocked`
   *  can back off until then without a second command. */
  limitResetAt: string | null;
  /**
   * True when the session is sitting on claude's OWN resume dialog. Such a pane
   * reports `ready` (`send` answers the dialog itself), which would otherwise be
   * indistinguishable here from a session that genuinely finished a turn — and
   * the two mean opposite things: nothing has run yet, so any activity a caller
   * reads back is the PREVIOUS run's. Waking on it is right; mistaking it for a
   * completed turn is not, so it is named rather than left to inference.
   */
  resumeDialog: boolean;
}

/** The `--json` wake payload. `woke` is why the wait returned:
 *  `satisfied` (the predicate held) · `timeout` (deadline hit) · `unsatisfiable`
 *  (no remaining target can satisfy the predicate, so waiting longer is futile) ·
 *  `blocked` (a target is parked at its usage cap — see `isSettledReadiness` in
 *  tmux.ts, which refuses to call that settled: it hasn't
 *  finished, so this is NOT a success, but it also won't move on its own for
 *  hours, so we wake the caller now instead of holding the timeout open).
 *  Only `satisfied` exits 0.
 *
 *  Emitted only once the wait actually runs. Setup failures — unknown id, bad
 *  selector, nothing running — exit non-zero with a plain-text reason on stderr
 *  and print NOTHING on stdout, even under `--json`, so a consumer must check the
 *  exit code before parsing rather than assuming a payload is always there. */
export interface WaitPayload {
  woke: "satisfied" | "timeout" | "unsatisfiable" | "blocked";
  /** Human-readable form of the predicate that was being waited on. */
  condition: string;
  mode: "all" | "any";
  elapsedMs: number;
  sessions: WaitResult[];
}

/** Whether an observed state satisfies the wait predicate. The default (no
 *  `--state`/`--not`) waits for a *known, settled, unblocked* non-busy state —
 *  `unknown` and `limited` are excluded (see `isSettledReadiness`) so neither an
 *  unread pane nor a session sitting at its usage cap reports a false success.
 *  `exited` passes that default: a session whose window is gone is as settled as
 *  it will ever get. An explicit `--state`/`--not` is honoured verbatim, so
 *  `--state limited` still wakes the moment the cap hits.
 *
 *  The test itself lives in tmux.ts beside `Readiness`, shared with the
 *  stalled-session qualifier (idle.ts) so the two can't drift into disagreeing
 *  about what "stopped working" means — a capped session is neither finished nor
 *  hung in both. The cast is safe for the reason above: `exited` is in neither
 *  the working set nor the not-settled set, so it settles. */
export function waitSatisfied(r: WaitState, o: WaitOptions): boolean {
  if (o.state) return r === o.state;
  if (o.not) return r !== o.not;
  return isSettledReadiness(r as Readiness);
}

/** Parse a duration like `500ms`, `2s`, `5m`, `1h` (bare number ⇒ seconds); null
 *  if the string is missing or malformed, so the caller can reject it loudly
 *  rather than silently fall back to a default the user didn't ask for. */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "s").toLowerCase()) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return null;
  }
}

// `--repo`/`--path` appear both as a selector in their own right (scope alone
// picks the set) and as a modifier on the others, which is exactly what they are.
const USAGE =
  `usage: ${SELF_CMD} wait <id...> | --all | --prefix <p> | --repo <name> | --path <dir> ` +
  `[--repo <name>] [--path <dir>] [--any] [--json] [--state <s>] [--not <s>] ` +
  `[--timeout <dur>] [--interval <dur>]`;

/**
 * Parse `wait`'s argv tail into options. Returns the exit code to use on bad
 * input (printing the reason) rather than exiting, so the whole command is
 * testable in-process.
 */
export function parseWaitArgs(rest: string[], cwd = process.cwd()): WaitOptions | number {
  let all = false;
  let any = false;
  let json = false;
  let prefix: string | undefined;
  let repo: string | undefined;
  let pathArg: string | undefined;
  let state: string | undefined;
  let not: string | undefined;
  let timeoutMs = 120_000;
  let intervalMs = 2_000;
  const ids: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--all") all = true;
    else if (a === "--any") any = true;
    else if (a === "--json") json = true;
    // `--prefix` keeps its raw read: an empty prefix has always meant "match
    // every basename" (i.e. `--all`), so guarding it like the scope flags below
    // would turn a working invocation into an error.
    else if (a === "--prefix") prefix = rest[++i];
    else if (a === "--repo" || a === "--path") {
      const v = scopeFlagValue("wait", a, rest[++i]);
      if (v === null) return 1;
      if (a === "--repo") repo = v;
      else pathArg = v;
    }
    else if (a === "--state") state = rest[++i];
    else if (a === "--not") not = rest[++i];
    else if (a === "--timeout" || a === "--interval") {
      const ms = parseDuration(rest[++i]);
      if (ms === null) {
        console.error(`wait: ${a} needs a duration like 500ms, 2s, 5m, 1h (got "${rest[i] ?? ""}")`);
        return 1;
      }
      if (a === "--timeout") timeoutMs = ms;
      else intervalMs = ms;
    } else if (a === "--") { ids.push(...rest.slice(i + 1)); break; }
    // A session id can't start with `-` (shortId strips non-alphanumerics), so a
    // dashed token here is a mistyped flag. Taking it as an id would report "no
    // session found for --repo=x" and blame the user for a session that never
    // existed, instead of naming the actual mistake. `--` above still escapes.
    else if (a.startsWith("-")) {
      console.error(`wait: unknown argument "${a}"`);
      return 1;
    } else ids.push(a);
  }
  for (const [flag, v] of [["--state", state], ["--not", not]] as const) {
    if (v !== undefined && !WAIT_STATES.includes(v as WaitState)) {
      console.error(`wait: ${flag} must be one of ${WAIT_STATES.join("|")}, got "${v}"`);
      return 1;
    }
  }
  if (state !== undefined && not !== undefined) {
    console.error("wait: use only one of --state / --not");
    return 1;
  }
  return {
    ids, all, any, json, prefix,
    scope: makeSessionScope({ path: pathArg, repo }, cwd),
    state: state as WaitState | undefined,
    not: not as WaitState | undefined,
    timeoutMs, intervalMs,
  };
}

/** Parse argv and run the wait. Returns the process exit code. */
export async function runWaitCli(rest: string[]): Promise<number> {
  const parsed = parseWaitArgs(rest);
  return typeof parsed === "number" ? parsed : runWait(parsed);
}

/** One selected session together with the tmux window it resolved to at startup. */
interface WaitTarget {
  s: AgentSession;
  target: string;
}

/**
 * Everything one wait needs after setup, gathered once so the poll loop and its
 * helpers can live at module scope instead of as closures inside `runWait`.
 *
 * `all` is the session list from the ONE up-front `SessionIndex.build()` — the
 * loop reuses it for every `refreshLiveTmux` and never rebuilds it, which is
 * what keeps transcript parsing off this path (see the file header and the
 * parse-count assertion in e2e/sessions-cache.spec.ts). The three maps are
 * per-wait counters that must survive across ticks, so they are created once
 * here and mutated in place.
 */
interface WaitCtx {
  o: WaitOptions;
  all: AgentSession[];
  targets: WaitTarget[];
  /** Human-readable predicate, echoed in messages and in the `--json` payload. */
  desc: string;
  mode: "all" | "any";
  started: number;
  deadline: number;
  interval: number;
  /** State on the first poll, per session id, so the wake payload can report the
   *  transition (`from` → `state`) rather than just the destination. */
  first: Map<string, WaitState>;
  /** Consecutive ticks a target has been missing from the live set (see `pollTarget`). */
  misses: Map<string, number>;
  /** Consecutive ticks a target has read `limited`, reset the moment it doesn't —
   *  the confirmation behind the `blocked` wake (see LIMIT_CONFIRM_TICKS). */
  limitedTicks: Map<string, number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve explicit id tokens against the index, or an exit code (having named
 *  every token that matched nothing) — an id the caller spelled out and we can't
 *  find is a mistake to report, not a target to silently drop. */
function sessionsForIds(
  ids: string[],
  all: AgentSession[],
  inScope: (s: AgentSession) => boolean,
  where: string,
): AgentSession[] | number {
  const sessions: AgentSession[] = [];
  const missing: string[] = [];
  for (const tok of ids) {
    const sid = tok.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(tok);
    const s = all.find((x) => (x.id === tok || shortId(x.id) === sid) && inScope(x));
    if (s) sessions.push(s);
    else missing.push(tok);
  }
  if (missing.length) {
    console.error(`wait: no session found for ${missing.join(", ")}${where}`);
    return 1;
  }
  return sessions;
}

/**
 * Pick the session set to wait on, or return an exit code (having printed why).
 *
 * The scope narrows whichever selector chose the set — ids and `--all` included.
 * A scoping flag that some other selector silently overrode would be worse than
 * no flag at all: it would wait on more sessions than was asked for, which is
 * exactly the mistake an orchestrator uses `--repo` to avoid.
 */
function selectWaitSessions(o: WaitOptions, all: AgentSession[], where: string): AgentSession[] | number {
  const inScope = scopeFilter(o.scope);
  let sessions: AgentSession[];
  if (o.ids.length) {
    const found = sessionsForIds(o.ids, all, inScope, where);
    if (typeof found === "number") return found;
    sessions = found;
  } else if (o.all || o.prefix !== undefined || o.scope) {
    sessions = all.filter((s) => {
      // `--all` still overrides `--prefix`, exactly as it did when the two lived
      // in separate branches — merging them here is about the scope, and must not
      // quietly redefine a selector pair that predates it.
      if (!o.all && o.prefix !== undefined && !basename(s.cwd).startsWith(o.prefix)) return false;
      return inScope(s);
    });
  } else {
    console.error(USAGE);
    return 1;
  }
  // At most ONE entry per session. `misses` is keyed by session id, so a session
  // listed twice gets its counter bumped twice by a single tick and hits
  // EXIT_CONFIRM_TICKS on the FIRST missed sighting — the exact false `exited`
  // that rule exists to prevent, and terminal once reported. Repeating an id is
  // easy to do from a script (`wait $A $B` where both resolve to the same
  // session, or a full id alongside its short form), so dedupe here rather than
  // trusting the caller. It also stops the wake payload listing one session
  // twice with contradictory states.
  return [...new Map(sessions.map((s) => [s.id, s])).values()];
}

/**
 * Resolve the selected sessions to live tmux windows, or an exit code (having
 * printed why).
 *
 * Only running sessions have a pane to poll. Resolve each session's live window
 * via the same reconciliation the menu uses (`refreshLiveTmux`), NOT
 * `liveTargetForShortId`: that only matches id-bearing names, so a session
 * running under a work-item / PR window (`cl-wi-…`/`cl-pr-…`, attributed by cwd)
 * would be wrongly seen as not-running. `liveWindows` also excludes
 * restored-but-unopened placeholders (idle bash), so we never "wait" on those.
 * For explicit ids a non-running target can never settle, so it's an error;
 * selectors just skip idle ones.
 */
function resolveWaitTargets(
  o: WaitOptions,
  sessions: AgentSession[],
  all: AgentSession[],
  where: string,
): WaitTarget[] | number {
  const { liveWindows } = refreshLiveTmux(all);
  const targets: WaitTarget[] = [];
  const notRunning: AgentSession[] = [];
  for (const s of sessions) {
    const target = liveWindows.get(sessionName(s));
    if (target) targets.push({ s, target });
    else notRunning.push(s);
  }
  if (o.ids.length && notRunning.length) {
    console.error(`wait: not running (no live window): ${notRunning.map((s) => shortId(s.id)).join(", ")}`);
    console.error(notRunningHint("<id>", "then wait on it again"));
    return 1;
  }
  if (targets.length === 0) {
    console.error(`wait: no running sessions matched${where} — nothing to wait on.`);
    return 1;
  }
  return targets;
}

/** Gather everything one wait runs on: the predicate's description, the clock
 *  bounds and the three per-wait counters.
 *
 *  Nothing here is frozen, and that matters. The counters are the SAME Map
 *  instances for the whole wait, mutated in place tick by tick — copying them
 *  (or spreading the ctx) would silently break the confirm-tick logic that
 *  `isCapped` and the exited-miss count depend on. */
function makeWaitCtx(o: WaitOptions, all: AgentSession[], targets: WaitTarget[]): WaitCtx {
  const started = Date.now();
  return {
    o,
    all,
    targets,
    desc: o.state ? `= ${o.state}` : o.not ? `≠ ${o.not}` : "settled (not busy, limited or unknown)",
    mode: o.any ? "any" : "all",
    started,
    deadline: started + o.timeoutMs,
    // Floor the poll interval so a `--interval 0` can't spin a hot capture loop.
    interval: Math.max(100, o.intervalMs),
    first: new Map(),
    misses: new Map(),
    limitedTicks: new Map(),
  };
}

/** One target's state this tick, given the live window map the tick already read.
 *
 *  Capture the window that reconciliation reports NOW, not the one resolved at
 *  startup: a session's window name isn't stable across a restart (one running
 *  under a cwd-attributed `cl-wi-…` window comes back as `cl-claude-<id>`), and
 *  capturing the stale name would read an empty pane as `unknown` forever.
 *
 *  A single missed sighting is NOT enough to call a session `exited`. Every tmux
 *  read funnels through `tmuxLines`, which maps ANY non-zero exit to an empty
 *  list — a momentarily unavailable server, a fork failure under load, a server
 *  restart. That empties `liveWindows` wholesale, so one hiccup would mark every
 *  target `exited`, which satisfies the default predicate and would return exit 0
 *  reporting "all done" for sessions that are still working. Since `exited` is
 *  terminal, no later tick could undo it. So an absence has to repeat before we
 *  believe it; until then the target reads `unknown`, which is deliberately
 *  unsatisfiable and simply retries — the self-healing behaviour that existed
 *  before `exited` did. Cost is one extra interval of detection latency. */
function pollTarget(ctx: WaitCtx, { s, target }: WaitTarget, nowLive: Map<string, string>): WaitResult {
  const live = nowLive.get(sessionName(s));
  let state: WaitState;
  let resetAt: number | null = null;
  // Read off the SAME capture the state came from, so the flag can't describe
  // a different frame than the state it qualifies. A target with no live
  // window has no pane to be parked in, so it is false there by construction.
  let resumeDialog = false;
  if (live) {
    ctx.misses.set(s.id, 0);
    const { raw, cursor } = capturePaneState(live);
    state = paneReadiness(raw, cursor);
    resumeDialog = paneResumeDialogActive(raw);
    // Same capture again — no extra tmux call, and the same helper `agendo
    // list` uses, so the two never disagree on the time.
    if (state === "limited") resetAt = paneResetAt(stripAnsi(raw));
  } else {
    const seen = (ctx.misses.get(s.id) ?? 0) + 1;
    ctx.misses.set(s.id, seen);
    state = seen >= EXIT_CONFIRM_TICKS ? "exited" : "unknown";
  }
  if (!ctx.first.has(s.id)) ctx.first.set(s.id, state);
  const from = ctx.first.get(s.id) as WaitState;
  return {
    id: s.id,
    shortId: shortId(s.id),
    state,
    from,
    changed: state !== from,
    satisfied: waitSatisfied(state, ctx.o),
    cwd: s.cwd,
    title: s.title,
    window: live ?? target,
    limitResetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
    resumeDialog,
  };
}

/** Read every target's current state in one tick.
 *
 *  Liveness comes from ONE `refreshLiveTmux` per tick, reusing the already-built
 *  `ctx.all` — the same list-sessions/list-windows/list-panes reads the menu's
 *  own poll does. It deliberately does NOT rebuild the SessionIndex: that would
 *  put transcript scanning on this loop. A target missing from `liveWindows` has
 *  no pane left to capture, so it isn't captured at all. */
function pollTargets(ctx: WaitCtx): WaitResult[] {
  const { liveWindows: nowLive } = refreshLiveTmux(ctx.all);
  return ctx.targets.map((t) => pollTarget(ctx, t, nowLive));
}

/** Emit the wake and produce the exit code.
 *
 *  Non-JSON preserves the original contract exactly: `<id>\t<state>` lines on
 *  stdout ONLY on success, nothing on stdout when the wait fails (the reason
 *  goes to stderr). Printing them on a timeout too would break the scripts that
 *  read non-empty stdout as "it settled".
 *
 *  `--json` is the opposite by design — it always emits the payload, because a
 *  caller that woke on a timeout still needs to see the states it woke to, and
 *  distinguishes outcomes via `woke` rather than by stdout being empty. */
async function finishWait(ctx: WaitCtx, woke: WaitPayload["woke"], results: WaitResult[]): Promise<number> {
  if (ctx.o.json) {
    const payload: WaitPayload = {
      woke,
      condition: ctx.desc,
      mode: ctx.mode,
      elapsedMs: Date.now() - ctx.started,
      sessions: results,
    };
    await printJson(payload);
  } else if (woke === "satisfied") {
    for (const x of results) console.log(`${x.shortId}\t${x.state}`);
  }
  return woke === "satisfied" ? 0 : 1;
}

/** Whether no further poll can change the answer, so the wait should wake now
 *  with a reason instead of burning the rest of the timeout. What counts as
 *  hopeless depends on the mode: `--any` needs just one target to satisfy, so
 *  it's only stuck once EVERY remaining candidate is dead; the default needs
 *  them all, so a SINGLE exited straggler already makes the predicate
 *  unreachable. */
function unsatisfiable(ctx: WaitCtx, pending: WaitResult[]): boolean {
  const stuck = ctx.o.any
    ? pending.every((x) => x.state === "exited")
    : pending.some((x) => x.state === "exited");
  return pending.length > 0 && stuck;
}

/**
 * Whether one pending target has been seen at its usage cap on
 * LIMIT_CONFIRM_TICKS consecutive ticks — enough to act on rather than a single
 * sighting. The counter is reset to 0 by the poll loop on any non-limited tick,
 * so this is "still capped right now", not "was capped at some point".
 */
function isCapped(ctx: WaitCtx, x: WaitResult): boolean {
  return (ctx.limitedTicks.get(x.id) ?? 0) >= LIMIT_CONFIRM_TICKS;
}

/**
 * Whether the wait should give up because its remaining targets are parked at
 * their usage cap.
 *
 * A target at its usage cap won't move for hours (it resumes when the window
 * reopens, or when someone unblocks it). Holding the timeout open would leave
 * the caller blind for exactly as long as it asked to be notified within — the
 * failure `exited` was introduced to remove — so wake NOW with the state and
 * the reset instant. Not a success: `finishWait` only exits 0 for "satisfied", so
 * a script can't mistake a capped session for finished work. Same mode rule as
 * `unsatisfiable`: `--any` still needs every remaining candidate to be blocked.
 *
 * ONLY for the default predicate — that is what the `!ctx.o.state && !ctx.o.not`
 * guard below is for, and it is load-bearing. An explicit `--state`/`--not` has
 * already told us what this caller counts as done, and several of those
 * predicates mean "wait THROUGH the cap" — `--state exited` (tell me when it's
 * finished for good), `--state ready`, `--not limited` (tell me when the cap
 * clears). Waking those with `blocked` would answer a question they didn't ask.
 */
function blockedByLimit(ctx: WaitCtx, pending: WaitResult[]): boolean {
  const capped = (x: WaitResult) => isCapped(ctx, x);
  const blocked = !ctx.o.state && !ctx.o.not && (ctx.o.any ? pending.every(capped) : pending.some(capped));
  return pending.length > 0 && blocked;
}

/** Why this tick ends the wait, or null to keep polling. Every non-satisfied
 *  ending prints its reason to stderr here, so the caller sees WHICH targets
 *  caused it before `finishWait` decides what goes on stdout. */
function wakeReason(ctx: WaitCtx, results: WaitResult[], pending: WaitResult[]): WaitPayload["woke"] | null {
  const done = results.filter((x) => x.satisfied);
  // `--any` returns on the first session to satisfy, so one session stuck busy
  // can't mask the others; the default still requires all of them.
  if (ctx.o.any ? done.length > 0 : pending.length === 0) return "satisfied";
  if (unsatisfiable(ctx, pending)) {
    console.error(
      `wait: gave up — exited without satisfying "${ctx.desc}": ` +
        pending.filter((x) => x.state === "exited").map((x) => x.shortId).join(", "),
    );
    return "unsatisfiable";
  }
  if (blockedByLimit(ctx, pending)) {
    console.error(
      `wait: at usage limit, not settled — ` +
        pending
          .filter((x) => isCapped(ctx, x))
          .map((x) => `${x.shortId}${x.limitResetAt ? ` (resets ${formatResetTime(Date.parse(x.limitResetAt))})` : ""}`)
          .join(", "),
    );
    return "blocked";
  }
  if (Date.now() >= ctx.deadline) {
    console.error(
      `wait: timed out after ${Math.round(ctx.o.timeoutMs / 1000)}s; still pending: ` +
        pending.map((x) => `${x.shortId}(${x.state})`).join(", "),
    );
    return "timeout";
  }
  return null;
}

/** The poll loop itself: announce the wait, then tick until something ends it.
 *
 *  One deliberate delta from the pre-split version, recorded rather than undone:
 *  the announce below used to happen BEFORE the clock bounds were taken, so the
 *  timeout budget and the `--json` elapsedMs excluded this stderr write and now
 *  include it. It is one write against a timeout measured in seconds. Restoring
 *  the exact ordering would mean either emitting output from makeWaitCtx or
 *  mutating ctx.started after the fact — both worse than the sub-millisecond
 *  they would buy back. */
async function waitLoop(ctx: WaitCtx): Promise<number> {
  console.error(
    `waiting for ${ctx.o.any ? "any of" : "all"} ${ctx.targets.length} session(s) to be ${ctx.desc} ` +
      `(timeout ${Math.round(ctx.o.timeoutMs / 1000)}s)…`,
  );
  while (true) {
    const results = pollTargets(ctx);
    const pending = results.filter((x) => !x.satisfied);
    for (const x of results) {
      ctx.limitedTicks.set(x.id, x.state === "limited" ? (ctx.limitedTicks.get(x.id) ?? 0) + 1 : 0);
    }
    const woke = wakeReason(ctx, results, pending);
    if (woke) return finishWait(ctx, woke, results);
    console.error(`  pending: ${pending.map((x) => `${x.shortId}=${x.state}`).join(", ")}`);
    // Never sleep past the deadline: bounds the timeout overrun to ~0 even when
    // the interval is large relative to the remaining time.
    await sleep(Math.min(ctx.interval, Math.max(0, ctx.deadline - Date.now())));
  }
}

/**
 * Poll the selected session(s) until the wait predicate holds, then return 0;
 * non-zero on timeout or when no target can satisfy it any more. Only running
 * sessions can be waited on (an idle session has no pane to read), so selectors
 * filter to live targets; explicit ids that aren't running are an error. Progress
 * lines go to stderr and the final per-session `<id>\t<state>` to stdout, so it
 * composes in scripts.
 *
 * Returns the exit code rather than calling `process.exit`, so the whole poll
 * path can run in-process under test — that's what lets the cache spec assert
 * the loop adds no transcript parsing on top of the one cached build. The
 * `SessionIndex` is built HERE, exactly once, and only its session list is
 * handed on; nothing below rebuilds it.
 */
export async function runWait(o: WaitOptions): Promise<number> {
  const index = await SessionIndex.build();
  const where = scopeNote(o.scope);
  const sessions = selectWaitSessions(o, index.all, where);
  if (typeof sessions === "number") return sessions;
  const targets = resolveWaitTargets(o, sessions, index.all, where);
  if (typeof targets === "number") return targets;
  return waitLoop(makeWaitCtx(o, index.all, targets));
}
