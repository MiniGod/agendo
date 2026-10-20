// One repo, one orchestrator — and which one that is, when the disk says two.
//
// A repo's orchestrator squash-merges into its main branch, so a second one in
// the same repo is two coordinators merging into one branch, each unaware of
// what the other briefed. Every entry point that could start one (`O`, `G` in a
// repo scope, `launch --orchestrator`) therefore asks this module first, and
// opens or resumes what it finds instead of starting another.
//
// Duplicates still happen — a launch from before this rule existed, a session
// started by hand, two launchers racing — so "is there one" is not enough: the
// question is which one IS the orchestrator. The rule, deterministic so the
// TUI's `O`/`G`, its pinned row and `launch --orchestrator` always name the same
// session — and `list repos`, which lists the recorded ones in this same order,
// names it first:
//
//   1. RECORDED beats recognised. A session agendo marked at launch
//      (orchestrators.json, or the cwd marker a Codex orchestrator gets) is an
//      orchestrator by fact; one whose title merely says so is a guess, and a
//      guess never gets to be primary.
//   2. Then whatever is most alive: running, then paused (a restored tab parked
//      in its window), then idle on disk.
//   3. Then the most recently used, then the most recently MARKED (later in
//      orchestrators.json), then the id, so a tie can never flip between reads.
//
// Every other candidate in the repo is STALE. Stale is a label, never an
// action: nothing here closes, kills or unmarks a session. Deciding that one
// is finished is the user's call, and the cost of guessing wrong is a
// coordinator's whole briefing history.
//
// One limit is inherited, not chosen. A Codex orchestrator is recorded by its
// cwd (cwdMarks.ts), so ANY Codex session in that cwd reads as recorded — the
// same reading `resume` already makes when it re-injects the instructions. Two
// of them in one main checkout rank like any two recorded candidates, and the
// one not picked is listed as stale beside it rather than hidden.
import { realpathSync } from "fs";
import { basename } from "path";
import { repoRootForCwd } from "../repositories/index.ts";
import { mainCheckoutOf } from "../repositories/scopeRepo.ts";
import { normalizeCwd } from "../app/context.ts";
import type { AgentSession } from "../shared/types.ts";
import type { OrchestratorRole } from "./role.ts";

export type OrchestratorState = "running" | "paused" | "idle";

/** A session that is, or looks like, a repo's orchestrator. */
export interface OrchestratorCandidate {
  session: AgentSession;
  state: OrchestratorState;
  /** Marked at launch, rather than recognised by its title (see rule 1). */
  recorded: boolean;
}

/** A repo and the orchestrator coordinating it, if any. */
export interface RepoOrchestratorStatus {
  root: string;
  name: string;
  /** THE orchestrator, by the rule above; null when the repo has none recorded. */
  primary: OrchestratorCandidate | null;
  /** Every other candidate, best first. Surfaced, never acted on. */
  stale: OrchestratorCandidate[];
}

/** What the rule reads besides the sessions: the markers and the live state. */
export interface OrchestratorFacts {
  /** `orchestratorRoles()` — id → level, in orchestrators.json order (oldest first). */
  roles: ReadonlyMap<string, OrchestratorRole>;
  /** `orchestratorCwdRoles()` — the cwd markers Codex orchestrators are found by. */
  cwdRoles: ReadonlyMap<string, OrchestratorRole>;
  stateOf: (s: AgentSession) => OrchestratorState;
}

const STATE_RANK: Record<OrchestratorState, number> = { running: 0, paused: 1, idle: 2 };

/**
 * Which level a session was recorded at, if any. A Codex session is also found
 * by its cwd marker — Codex assigns its own id, so there is none to record at
 * launch (see cwdMarks.ts) — exactly as `orchestratorRoleOf` resolves it.
 */
export function recordedRole(
  s: Pick<AgentSession, "id" | "source" | "cwd">,
  f: Pick<OrchestratorFacts, "roles" | "cwdRoles">,
): OrchestratorRole | undefined {
  return f.roles.get(s.id) ?? (s.source === "codex" ? f.cwdRoles.get(s.cwd) : undefined);
}

/** `p` by its real path, or as given when it does not resolve. */
function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const keyCache = new Map<string, string>();

/**
 * The repo a session or window in `cwd` belongs to, as the key this module files
 * it under: the MAIN checkout — a linked worktree, wherever it lives, has no
 * orchestrator of its own — by its real path, so a scope spelled through a
 * symlink finds the sessions that recorded the resolved one. Cached by
 * `repoRootForCwd`'s answer, which is itself cached for the process.
 */
export function repoKey(cwd: string): string {
  const root = repoRootForCwd(cwd);
  let key = keyCache.get(root);
  if (key === undefined) {
    key = normalizeCwd(realOrSelf(mainCheckoutOf(root)));
    keyCache.set(root, key);
  }
  return key;
}

/** The worktree the role slug names, `orchestrator` or a stepped `orchestrator-N`. */
const ORCHESTRATOR_WORKTREE_RE = /\/\.claude\/worktrees\/orchestrator(?:-\d+)?\/?$/;

/**
 * Whether a title reads as an orchestrator's name: one slug-shaped word (no
 * spaces, so "Fix the orchestrator prompt" is a task, not a name) with `orch`
 * or `orchestrator` as one of its `-`/`_`-separated parts — `orch-agendo`,
 * `agendo-orchestrator`, `orchestrator_2`.
 */
export function looksLikeOrchestrator(title: string): boolean {
  const t = title.trim();
  return /^\S+$/.test(t) && /(?:^|[-_])orch(?:estrator)?(?:$|[-_])/i.test(t);
}

/**
 * An unrecorded session that is still recognisably an orchestrator of the repo
 * filed under `key`: one in the main checkout named like one, or one in the
 * worktree the role slug names — where an agendo that defaulted orchestrators
 * to a worktree put them.
 */
function looksLikeRepoOrchestrator(s: AgentSession, key: string): boolean {
  if (ORCHESTRATOR_WORKTREE_RE.test(s.cwd)) return true;
  return looksLikeOrchestrator(s.title) && normalizeCwd(realOrSelf(s.cwd)) === key;
}

/**
 * The candidates in each repo, keyed by `repoKey`. A recorded REPO orchestrator
 * counts wherever in the repo it runs; an unrecorded session counts only when it
 * looks like one (`looksLikeRepoOrchestrator`) — the shape an orchestrator
 * started by hand, or by an agendo that predates the markers, leaves behind.
 * Global orchestrators belong to no repo and are never candidates.
 */
export function orchestratorCandidates(sessions: readonly AgentSession[], f: OrchestratorFacts): Map<string, OrchestratorCandidate[]> {
  const byRoot = new Map<string, OrchestratorCandidate[]>();
  for (const s of sessions) {
    const role = recordedRole(s, f);
    if (role === "global") continue;
    const root = repoKey(s.cwd);
    const recorded = role === "repo";
    if (!recorded && !looksLikeRepoOrchestrator(s, root)) continue;
    const list = byRoot.get(root) ?? [];
    list.push({ session: s, state: f.stateOf(s), recorded });
    byRoot.set(root, list);
  }
  return byRoot;
}

/** The order the rule ranks candidates in, best first (see the header). */
export function compareCandidates(markOrder: ReadonlyMap<string, number>) {
  const marked = (c: OrchestratorCandidate) => markOrder.get(c.session.id) ?? -1;
  return (a: OrchestratorCandidate, b: OrchestratorCandidate): number =>
    Number(b.recorded) - Number(a.recorded) ||
    STATE_RANK[a.state] - STATE_RANK[b.state] ||
    b.session.lastUsed.getTime() - a.session.lastUsed.getTime() ||
    marked(b) - marked(a) ||
    a.session.id.localeCompare(b.session.id);
}

/** Each id's position in orchestrators.json — later is more recently marked. */
export function markOrderOf(roles: ReadonlyMap<string, OrchestratorRole>): Map<string, number> {
  return new Map([...roles.keys()].map((id, i) => [id, i]));
}

/**
 * The rule's order over the sessions recorded as repo orchestrators, as id →
 * rank, best first — what `list repos` sorts its orchestrator column by, so the
 * one it names first is the one `O` opens.
 */
export function recordedRanks(sessions: readonly AgentSession[], f: OrchestratorFacts): Map<string, number> {
  const recorded = sessions
    .filter((s) => recordedRole(s, f) === "repo")
    .map((s): OrchestratorCandidate => ({ session: s, state: f.stateOf(s), recorded: true }))
    .sort(compareCandidates(markOrderOf(f.roles)));
  return new Map(recorded.map((c, i) => [c.session.id, i]));
}

/** One repo's status from its candidates: the best recorded one is primary. */
export function statusFromCandidates(
  root: string,
  candidates: readonly OrchestratorCandidate[],
  markOrder: ReadonlyMap<string, number>,
): RepoOrchestratorStatus {
  const ranked = [...candidates].sort(compareCandidates(markOrder));
  const primary = ranked[0]?.recorded ? ranked[0] : null;
  return { root, name: basename(root) || root, primary, stale: primary ? ranked.slice(1) : ranked };
}

/** The status of every repo in `roots`, in the order given. */
export function repoOrchestratorStatuses(
  roots: readonly string[],
  sessions: readonly AgentSession[],
  f: OrchestratorFacts,
): RepoOrchestratorStatus[] {
  const byRoot = orchestratorCandidates(sessions, f);
  const order = markOrderOf(f.roles);
  return roots.map((r) => statusFromCandidates(normalizeCwd(r), byRoot.get(repoKey(r)) ?? [], order));
}

/** A title on one line, short enough to share one: a Codex title can be a whole first prompt. */
export function flatTitle(title: string, max = 40): string {
  return title.replace(/\s+/g, " ").trim().slice(0, max);
}
