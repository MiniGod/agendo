// The vocabulary of `agendo wait`: the states it can watch for, the options it
// takes, the result and JSON payload shapes, and the predicate that decides
// whether a target has satisfied the wait.
//
// Split from the loop so that `args.ts` (which parses argv into WaitOptions) and
// `loop.ts` (which polls against it) can both depend on the shapes without
// depending on each other.
import { sessionFinished, type Readiness } from "../tmux.ts";
import type { SessionScope } from "../scope.ts";



/**
 * Consecutive polls a target must be absent from the live set before `wait`
 * declares it `exited`. Two, because one absence is indistinguishable from a
 * transient tmux read failure — and `exited` is a terminal verdict that ends the
 * wait, so a false one is unrecoverable. See `poll()`.
 */
export const EXIT_CONFIRM_TICKS = 2;

/**
 * Consecutive `limited` sightings before `wait` wakes with `blocked`. Two, for
 * the same reason as EXIT_CONFIRM_TICKS: the wake is terminal, and `limited` has
 * a real transient. The TUI's auto-resume sends one Escape to reveal the reset
 * notice, and the pane it uncovers — notice above an idle input box — reads
 * `limited` for a tick or two before generation restarts. Waking off that single
 * sighting would report a session as capped at the exact moment it was being
 * un-capped, with a reset instant already in the past.
 */
export const LIMIT_CONFIRM_TICKS = 2;

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
  /**
   * Background agents the session is waiting on. A running subagent means the
   * session IS working even though its main agent sits idle at the prompt, so the
   * DEFAULT predicate does not settle while this is above zero — otherwise `wait`
   * would report "done" on a session that is still doing the work (#44).
   *
   * Reported rather than left to inference, because it is the one thing that can
   * hold a wait open on a pane whose own state reads `ready`. Monitors and
   * background shells are deliberately NOT counted here: both are long-running by
   * design, and holding for them would mean `wait` never returns for anyone with a
   * dev server up.
   */
  backgroundAgents: number;
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

/** Why a target is still pending when its readiness alone doesn't say — `ready`
 *  on its own reads like a bug in the wait, not like a session that is working
 *  (#44). Empty when the state already explains itself. */
export function heldBy(x: WaitResult): string {
  if (x.backgroundAgents <= 0) return "";
  // Parenthesized, never comma-joined: both call sites below already join their
  // targets with ", ", so a bare comma here reads as another target.
  return ` (${x.backgroundAgents} background agent${x.backgroundAgents === 1 ? "" : "s"})`;
}

/** The default predicate in words — the stderr banner and `--json`'s `condition`.
 *  Kept beside `waitSatisfied` so it cannot drift from what that actually tests;
 *  it said "settled" until #44 gave the default a second condition. */
export const SETTLED_DESC = "settled (not busy, limited or unknown) and no background agent running";

/** Whether an observed state satisfies the wait predicate. The default (no
 *  `--state`/`--not`) waits for a session that has *stopped working*: a known,
 *  settled, unblocked non-busy state AND no background agent still running.
 *  `unknown` and `limited` are excluded (see `sessionFinished`) so neither an
 *  unread pane nor a session sitting at its usage cap reports a false success,
 *  and a subagent still running holds it open even though the main agent's prompt
 *  reads `ready` (#44). `exited` passes that default: a session whose window is
 *  gone is as settled as it will ever get. An explicit `--state`/`--not` is
 *  honoured verbatim, so `--state limited` still wakes the moment the cap hits.
 *
 *  The test itself lives in tmux.ts beside `Readiness`, shared with the
 *  stalled-session qualifier (idle.ts) and the `close` guard so they can't drift
 *  into disagreeing about what "stopped working" means — a capped session is
 *  neither finished nor hung in any of them. The cast is safe for the reason
 *  above: `exited` is in neither the working set nor the not-settled set, so it
 *  settles. */
export function waitSatisfied(r: WaitState, o: WaitOptions, backgroundAgents: number): boolean {
  if (o.state) return r === o.state;
  if (o.not) return r !== o.not;
  // The DEFAULT predicate only: a session whose main agent is back at its prompt
  // but whose subagent is still running is not finished, however "ready" the
  // prompt reads (#44). An explicit `--state`/`--not` has already said what this
  // caller counts as done — and several of those readings mean "wait through
  // it" — so both return above without consulting this.
  //
  // `--not busy` is the one worth naming, because it changed meaning: it used to
  // hold while a subagent ran, for the wrong reason (the panel made the pane read
  // `busy`), and now settles as soon as the main agent is done. That is what it
  // literally asks for, and the default predicate is the one that means "wait for
  // the session to finish" — but a caller who wrote `--not busy` meaning that
  // should drop the flag.
  return sessionFinished(r as Readiness, backgroundAgents);
}
