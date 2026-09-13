// The readiness VOCABULARY: the states a pane can be in, the prompt glyph each
// TUI draws, and the "has this session stopped working?" predicate that
// `agendo wait` and the stall qualifier both ask.
//
// Deliberately dependency-free, and that is the whole reason it is its own file.
// The classifier (`paneReadiness.ts`), the codex parser and the chrome heuristics
// all need these names; anything they cannot all import without closing a cycle
// has to live here rather than beside the classifier that happens to own it.

/** Whether a captured agent TUI pane can accept a freshly-sent prompt. */
export type Readiness = "ready" | "busy" | "compacting" | "queued" | "dialog" | "limited" | "unknown";

/** The glyph each agent's TUI draws in front of its input line. */
export const CLAUDE_PROMPT = "❯";
export const CODEX_PROMPT = "›"; // U+203A — also codex's list cursor, see codexInputBox

/**
 * The readiness states that mean the agent is actively working right now.
 * Canonical here (next to the type) because two unrelated features key off the
 * same distinction: `agendo wait`'s default "still busy" predicate (see
 * wait.ts) and the stalled-session qualifier (see idle.ts), neither of which may
 * ever treat a session that is simply mid-turn as finished.
 */
const WORKING_READINESS: ReadonlySet<Readiness> = new Set<Readiness>(["busy", "compacting"]);

/**
 * States the settled test refuses, even though neither is "busy":
 *  - `unknown` — a pane we couldn't read. Treating it as settled reports a false
 *    success off a blank or not-yet-drawn screen: `agendo wait` would return
 *    "done" for a session it merely failed to read, and the stall qualifier would
 *    pass a verdict on a session it never saw. Absence of evidence that a session
 *    is working is not evidence that it has stopped.
 *  - `limited` — a session parked at its usage cap. It has stopped, but it is not
 *    DONE: it resumes when the cap lifts (auto-resume) or when someone unblocks
 *    it, and its work is still unfinished. `wait` exiting 0 there would tell an
 *    orchestrator "finished" about work that is merely paused; the stall marker
 *    would call it hung when it is waiting on a quota reset whose time `list`
 *    prints right next to it. `wait` doesn't wait it out in silence — it wakes on
 *    a capped target at once with `woke: "blocked"` and a non-zero exit — and an
 *    explicit `--state limited` still treats the cap as the success condition.
 */
const NOT_SETTLED: ReadonlySet<Readiness> = new Set<Readiness>(["unknown", "limited"]);

/**
 * Whether a state is *known, settled and unblocked*: not working, not unreadable,
 * not parked at a usage cap.
 *
 * This is the READINESS half of the question only, and module-private for that
 * reason. Everything that really wants "has this session stopped working?" asks
 * `sessionFinished` below instead: readiness alone stopped answering it when #44
 * split the flag, because the main agent can be back at its prompt while a
 * subagent it spawned runs on.
 *
 * Note `wait` also admits its synthetic `exited` state through this (neither
 * working nor in NOT_SETTLED), which is correct: a session whose window is gone is
 * as settled as it will ever get.
 */
function isSettledReadiness(r: Readiness): boolean {
  return !WORKING_READINESS.has(r) && !NOT_SETTLED.has(r);
}

/**
 * Whether a session has stopped working — the whole question, both halves.
 *
 * Readiness describes the MAIN agent, and after #44 that is deliberately all it
 * describes: a session whose subagent is still running reads `ready`, because the
 * prompt genuinely is accepting input and `agendo send` must reach it. It is not
 * finished, though. Two callers ask exactly this question and so ask it here,
 * rather than each pairing readiness with its own lookalike count check:
 *
 *  - `agendo wait`'s default predicate (wait.ts) — whether to settle.
 *  - the stalled-session qualifier (idle.ts) — whether to print `⚠stalled`.
 *
 * `agendo close`'s work-in-flight guard is a THIRD consumer of the same count but
 * deliberately not a caller of this: it asks "would ending this lose something?",
 * which is a different question with a different state set (it refuses `queued`
 * and `dialog`, which both of the above consider done). It pairs its own states
 * with the same `paneBackgroundAgents` read — see UNSAFE_CLOSE_STATES. Missing it
 * on the first pass would have hard-killed a session whose subagent was mid-write,
 * which is the most expensive way for these three to disagree.
 */
export function sessionFinished(r: Readiness, backgroundAgents: number): boolean {
  return isSettledReadiness(r) && backgroundAgents === 0;
}
