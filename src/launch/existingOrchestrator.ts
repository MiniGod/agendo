// Finding a repo's existing orchestrator and bringing the user to it — the half
// of "one repo, one orchestrator" that touches tmux. Which session IS the
// orchestrator is decided in src/orchestration/repoOrchestrator.ts; this module
// supplies the live state that rule reads, catches the one case the rule cannot
// see, and turns the answer into an `OpenPlan`.
//
// The case the rule cannot see is the orchestrator launched a moment ago. Its
// agent has not written a transcript yet (Claude writes none until the first
// message), so the session index does not know it exists — but its window is
// live, and pressing `O` again in that gap must switch to it, not start a twin.
import { orchestratorRoles } from "../orchestration/index.ts";
import { orchestratorCwdRoles } from "../orchestration/cwdMarks.ts";
import {
  flatTitle,
  repoKey,
  repoOrchestratorStatuses,
  type OrchestratorCandidate,
  type OrchestratorFacts,
  type RepoOrchestratorStatus,
} from "../orchestration/repoOrchestrator.ts";
import {
  ID_BEARING_NAME,
  isPlaceholderWindow,
  liveManagedPaths,
  sessionName,
  shortId,
  tmuxQuiet,
  type LiveTarget,
  type ManagedTarget,
} from "../runtime/tmux/index.ts";
import type { AgentSession, AgentSource } from "../shared/types.ts";
import { navigatePlan, openSession, type OpenPlan } from "./open.ts";

/** The slice of reconciled live state the rule reads (a `LoadedModel`, or `refreshLiveTmux`). */
export interface OrchestratorLive {
  /** Canonical names of running sessions. */
  live: ReadonlySet<string>;
  /** Canonical names held by a dormant restore placeholder. */
  placeholders: ReadonlySet<string>;
  /** The window each running session was attributed to. */
  windows: ReadonlyMap<string, LiveTarget>;
  /** The placeholder window holding each paused session. */
  placeholderWindows: ReadonlyMap<string, LiveTarget>;
}

/** The markers on disk plus the live state, as the rule's input. */
export function orchestratorFacts(l: OrchestratorLive): OrchestratorFacts {
  return {
    roles: orchestratorRoles(),
    cwdRoles: orchestratorCwdRoles(),
    stateOf: (s) => {
      const canon = sessionName(s);
      if (l.live.has(canon)) return "running";
      return l.placeholders.has(canon) ? "paused" : "idle";
    },
  };
}

/** What a repo already has: a session the rule picked, or a window too new to have one. */
export type ExistingOrchestrator =
  | { kind: "session"; status: RepoOrchestratorStatus; primary: OrchestratorCandidate }
  | { kind: "pending"; target: ManagedTarget };

/** A Codex launch's window: `kindName` tags the id-less name with the agent (`cl-bg-codex-…`). */
const CODEX_WINDOW_RE = /^cl-(?:bg|new)-codex-/;

/**
 * The agent a managed window runs, where the window says: its tag, or the
 * agent an id-less Codex name carries. An id-bearing name doesn't say (Claude
 * and Copilot are both launched under one), so that is undefined.
 */
export function windowAgent(t: ManagedTarget): AgentSource | undefined {
  return t.tags?.source ?? (CODEX_WINDOW_RE.test(t.name) ? "codex" : undefined);
}

/**
 * A live window in `root` that is a recorded repo orchestrator the session
 * index does not know yet. Recorded means its managed name carries the short id
 * of a repo-level id in orchestrators.json, or — for Codex, which has no id
 * until its rollout lands — it is a Codex window and its cwd is a repo-level
 * cwd marker. The marker says only "a Codex orchestrator was launched here", so
 * on its own it would vouch for every other window in the same checkout too.
 *
 * Only consulted when the rule found no recorded session in the repo, and that
 * is why a window's attribution does not rule it out: whatever session it was
 * attributed to is then an unrecorded one, and for a Codex window that is just
 * the cwd heuristic handing it to the last session that ran in the same
 * directory — the window's own name and marker are the better evidence.
 */
export function pendingOrchestrator(
  root: string,
  managed: readonly ManagedTarget[],
  f: Pick<OrchestratorFacts, "roles" | "cwdRoles">,
): ManagedTarget | null {
  const repoIds = new Set([...f.roles].filter(([, role]) => role === "repo").map(([id]) => shortId(id)));
  const want = repoKey(root);
  return (
    managed.find((t) => {
      if (t.placeholder || repoKey(t.cwd) !== want) return false;
      const sid = t.name.match(ID_BEARING_NAME)?.[1];
      if (sid !== undefined) return repoIds.has(sid);
      return windowAgent(t) === "codex" && f.cwdRoles.get(t.cwd) === "repo";
    }) ?? null
  );
}

/**
 * The orchestrator `root` already has, or null when it has none and a new one
 * may be started. `readManaged` is only called when the session index knows of
 * none, so the common case costs no extra tmux read.
 */
export function findRepoOrchestrator(
  root: string,
  sessions: readonly AgentSession[],
  l: OrchestratorLive,
  readManaged: () => ManagedTarget[] = liveManagedPaths,
): ExistingOrchestrator | null {
  const f = orchestratorFacts(l);
  const [status] = repoOrchestratorStatuses([root], sessions, f);
  if (status.primary) return { kind: "session", status, primary: status.primary };
  const target = pendingOrchestrator(root, readManaged(), f);
  return target ? { kind: "pending", target } : null;
}

/**
 * Whether a marker names an orchestrator the session index has no session for —
 * a repo-level id with no transcript yet (or none any more), or a repo-level
 * Codex cwd with no rollout in it. Only then can a window be pending, so only
 * then is the extra tmux read worth making (see `useOrchestratorPins`).
 */
export function hasUnmatchedMarker(sessions: readonly AgentSession[], f: Pick<OrchestratorFacts, "roles" | "cwdRoles">): boolean {
  const ids = new Set(sessions.map((s) => s.id));
  const codexCwds = new Set(sessions.filter((s) => s.source === "codex").map((s) => s.cwd));
  return (
    [...f.roles].some(([id, role]) => role === "repo" && !ids.has(id)) ||
    [...f.cwdRoles].some(([cwd, role]) => role === "repo" && !codexCwds.has(cwd))
  );
}

/**
 * Navigate to a window that already exists, creating nothing. `openTarget`
 * would create the window if it had vanished in the meantime, and for a
 * placeholder or a not-yet-attributed window there is no command it could
 * honestly create it with.
 */
function navigateTo(t: LiveTarget): OpenPlan {
  return navigatePlan(t.name, t.target);
}

/**
 * Wake a restore placeholder: its loop resumes the agent on any key but q/Esc
 * (see `placeholderArgv`), so an Enter is "press a key" on the user's behalf.
 * The flag is read again first, from the window itself: the state that said
 * "paused" can be a poll old, and an Enter in a tab somebody already woke would
 * land in the agent's input instead.
 */
export function wakePlaceholder(t: LiveTarget): void {
  if (t.session && isPlaceholderWindow(t.session, t.name)) tmuxQuiet(["send-keys", "-t", t.target, "Enter"]);
}

/**
 * Bring the user to an existing orchestrator: switch to it when it is running,
 * wake it in its own tab when it is paused, resume it when it is idle, and
 * switch to the window of one too new to have a session.
 *
 * A running one is reached by the exact target of the window it was
 * attributed to, through `navigateTo`, which creates nothing. `openSession`
 * prefers that same target too, but when it and every window of its name have
 * vanished since the scan it goes on to create one, and a running orchestrator
 * is never something to start here. A pane-hosted one (a `%N` target) is left
 * to `openSession`, whose pane lookup is what reaches it.
 */
export function openExistingOrchestrator(found: ExistingOrchestrator, l: OrchestratorLive): OpenPlan {
  if (found.kind === "pending") return navigateTo(found.target);
  const { session, state } = found.primary;
  const canon = sessionName(session);
  const parked = state === "paused" ? l.placeholderWindows.get(canon) : undefined;
  if (parked) {
    wakePlaceholder(parked);
    return navigateTo(parked);
  }
  const win = state === "running" ? l.windows.get(canon) : undefined;
  if (win && !win.target.startsWith("%")) return navigateTo(win);
  return openSession(session, l.windows.get(canon));
}

/** "orch-agendo (claude)", or the window name for one with no session yet. */
export function existingLabel(found: ExistingOrchestrator): string {
  if (found.kind === "pending") return `${found.target.name} (just started)`;
  return `${flatTitle(found.primary.session.title)} (${found.primary.session.source})`;
}
