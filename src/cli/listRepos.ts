// `agendo list repos` — one row per repository, and whether anybody is
// coordinating it.
//
// The session list answers "what is running"; this answers "which repos is
// nobody orchestrating", which is the whole job of a global orchestrator and is
// not readable off a table sorted by session. It is deliberately model-free (no
// backend, no auth) like the plain `list`: a survey you cannot run without
// network access is a survey that stops working exactly when things are busy.
//
// Where the rows come from decides what the survey can SEE. Sessions give it the
// repos somebody has already worked in; a repo nobody has touched yet appears
// only if the caller named a directory to walk. Unscoped, "no row" therefore
// means "no session here", not "no repo here" — which is why the scoped form
// exists and why the empty-case message distinguishes the two.

import { realpathSync } from "fs";
import { basename } from "path";
import { sessionName, shortId } from "../tmux.ts";
import { SessionIndex } from "../sessions.ts";
import { refreshLiveTmux } from "../model.ts";
import { orchestratorRoles } from "../orchestrator.ts";
import { discoverGitReposUnder, repoRootForCwd } from "../repos.ts";
import { isUnderRoot } from "../context.ts";
import { scopeFilter, scopeNote, type SessionScope } from "../scope.ts";
import type { AgentSession } from "../types.ts";
import type { OrchestratorRole } from "../orchestrator.ts";
import { printJson } from "../output.ts";
import { padCell } from "./cells.ts";
import { flushWarnings } from "./warnings.ts";

export interface ListReposOptions {
  /** Emit JSON instead of a human table. */
  json: boolean;
  /** Scope to sessions by cwd (`[dir]`/`--path`) and/or repo (`--repo`); null = all. */
  scope: SessionScope | null;
}

/** An orchestrator coordinating a repo, as reported by this listing. */
export interface RepoOrchestratorRow {
  id: string;
  shortId: string;
  running: boolean;
}

/** One repository, as reported by `list repos`. */
export interface RepoRow {
  /** Absolute repo root — the main checkout, never a worktree. */
  root: string;
  name: string;
  /** Sessions known in this repo (running plus idle-on-disk). */
  sessions: number;
  /** How many of those are running right now. */
  running: number;
  /**
   * The repo-level orchestrators found here, best first (running before idle).
   * Normally 0 or 1 — a repo with two is a mistake worth seeing, since both
   * would be squash-merging into the same main branch.
   */
  orchestrators: RepoOrchestratorRow[];
  /**
   * Does this repo have an orchestrator AT ALL — running or merely remembered.
   * False is the only value that means "start one"; a first-class field so a
   * consumer never has to decide whether an empty array and a missing key mean
   * the same thing.
   *
   * This is the conservative half of the pair on purpose. Markers and transcripts
   * outlive the session they describe, so a `true` here can be months stale — but
   * the cost of the two mistakes is not symmetric. Reading a closed orchestrator
   * as absent starts a SECOND one in the repo, and both then squash-merge into
   * the same main branch; reading it as present costs a `resume`. Which of the
   * two it is comes from `hasRunningOrchestrator` below.
   */
  hasOrchestrator: boolean;
  /**
   * Is one running RIGHT NOW. False with `hasOrchestrator` true is the resume
   * case: the repo's orchestrator exists, its worktree, branch and transcript are
   * intact, and everything already briefed lives in it.
   */
  hasRunningOrchestrator: boolean;
}

/**
 * The same directory by every name it can be reached under, so two spellings of
 * one checkout can be recognised as one. Unresolvable paths (a directory that
 * isn't there) keep their literal form — that still compares equal to itself.
 */
function canonicalPath(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Checkout roots under the scoped directory, for repos the session pass cannot
 * see at all.
 *
 * A repo NOBODY has worked in yet is the most unmanaged repo there is, and the
 * session index only knows repos that have hosted a session — so when the caller
 * named a directory, walk it too (`discoverGitReposUnder`: bounded, cached, the
 * same scan the TUI's repo picker uses). Only for the scoped form, since an
 * unscoped `list repos` has no directory to walk that isn't the user's whole
 * home, and never alongside `--repo`, which filters sessions in a way a
 * filesystem walk cannot honour.
 *
 * Results are kept only when they sit UNDER the root that found them.
 * `discoverGitReposUnder` falls back to the checkout its target sits INSIDE when
 * the walk finds nothing — correct for a repo picker, wrong here, where
 * `list repos ./src` would report the whole enclosing repo carrying the session
 * counts of a scope that excludes almost all of it. And a spurious row is not a
 * cosmetic problem: it reads as "this repo is unmanaged" and sorts to the TOP,
 * where a global orchestrator picks it up and starts what may be the repo's
 * second orchestrator, squash-merging into the same main branch as the first.
 *
 * BOTH scope roots are walked. `resolveScopeRoots` hands back the literal path
 * and its symlink-resolved twin precisely because either one can be the spelling
 * a recorded session cwd carries, so picking one and hoping is a coin flip on the
 * direction of the user's symlinks. The caller de-duplicates against the session
 * rows through `canonicalPath` instead, which is right in both directions.
 */
function scopedCheckouts(scope: SessionScope | null): string[] {
  if (!scope || scope.repo) return [];
  return scope.roots.flatMap((root) =>
    discoverGitReposUnder(root).map((r) => r.root).filter((r) => isUnderRoot(r, root)),
  );
}

/** A repo row before any session has been counted into it. */
function emptyRow(root: string): RepoRow {
  return {
    root, name: basename(root) || root, sessions: 0, running: 0,
    orchestrators: [], hasOrchestrator: false, hasRunningOrchestrator: false,
  };
}

/** Count one session into its repo's row; a repo orchestrator is listed as well as counted. */
export function addSession(row: RepoRow, s: Pick<AgentSession, "id">, running: boolean, role: OrchestratorRole | undefined): void {
  row.sessions++;
  if (running) row.running++;
  if (role !== "repo") return;
  row.orchestrators.push({ id: s.id, shortId: shortId(s.id), running });
  row.hasOrchestrator = true;
  if (running) row.hasRunningOrchestrator = true;
}

/** The rows the session index can see: one per repo root that hosted an in-scope session. */
function sessionRows(opts: ListReposOptions, sessions: AgentSession[], live: Set<string>, roles: Map<string, OrchestratorRole>): Map<string, RepoRow> {
  const inScope = scopeFilter(opts.scope);
  const byRoot = new Map<string, RepoRow>();
  for (const s of sessions) {
    if (!inScope(s)) continue;
    // The GLOBAL orchestrator contributes NO row, not even a session count. Its
    // cwd is a vantage point chosen precisely so it isn't a checkout, so
    // `repoRootForCwd` hands back that bare directory — which would appear here
    // as a repo with no orchestrator, sort to the top (unmanaged repos lead), and
    // have the global orchestrator dutifully start a repo orchestrator in a
    // directory that is not a repository, over and over. Where its vantage point
    // DOES sit inside a checkout, the alternative failure is quieter and no
    // better: its session inflates that repo's counts.
    if (roles.get(s.id) === "global") continue;
    // A worktree folds back onto the repository it belongs to — otherwise every
    // worktree would show up as an unmanaged repo of its own, which is the exact
    // opposite of what this listing is for.
    const root = repoRootForCwd(s.cwd);
    let row = byRoot.get(root);
    if (!row) {
      row = emptyRow(root);
      byRoot.set(root, row);
    }
    addSession(row, s, live.has(sessionName(s)), roles.get(s.id));
  }
  return byRoot;
}

/**
 * Add the checkouts a scoped walk found that no session row already names.
 *
 * Compared canonically, not by string: a walked root and the root a session's
 * cwd resolved to can be two spellings of one directory (`~/work` and
 * `/mnt/big/work`), and letting the second through would print the repo twice —
 * once real, once as a phantom with no sessions and no orchestrator. The ROW
 * keeps the spelling it was found under, which is the one the user typed.
 */
function addWalkedCheckouts(byRoot: Map<string, RepoRow>, scope: SessionScope | null): void {
  const seen = new Set([...byRoot.keys()].map(canonicalPath));
  for (const found of scopedCheckouts(scope)) {
    const key = canonicalPath(found);
    if (seen.has(key)) continue;
    seen.add(key);
    byRoot.set(found, emptyRow(found));
  }
}

/**
 * Unmanaged repos first — they are the ones that need an answer — then the
 * ones whose orchestrator is only remembered, which need a `resume` rather
 * than a launch, then by how much is going on, then by name for stability.
 */
export function byNeed(a: RepoRow, b: RepoRow): number {
  return (
    Number(a.hasOrchestrator) - Number(b.hasOrchestrator) ||
    Number(a.hasRunningOrchestrator) - Number(b.hasRunningOrchestrator) ||
    b.running - a.running ||
    b.sessions - a.sessions ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Two different emptinesses, and saying which one saves the reader a guess: a
 * scoped survey looked at the disk as well and found no checkout at all.
 */
export function emptyMessage(scope: SessionScope | null): string {
  const what = scope?.roots.length && !scope.repo ? "git checkouts" : "repos with agent sessions";
  return `No ${what}${scopeNote(scope)}.`;
}

export const REPO_HEADER = ["repo".padEnd(24), "sessions".padEnd(8), "running".padEnd(7), "orchestrator".padEnd(12), "root"].join("  ");

/** One table line; the orchestrator column shows the best one, running before idle. */
export function formatRepoRow(r: RepoRow): string {
  const best = r.orchestrators[0];
  return [
    padCell(r.name, 24),
    String(r.sessions).padEnd(8),
    String(r.running).padEnd(7),
    (best ? `${best.running ? "●" : "○"} ${best.shortId}` : "none").padEnd(12),
    r.root,
  ].join("  ").trimEnd();
}

/**
 * List every known repo with its session counts and its orchestrator.
 *
 * The GLOBAL orchestrator is deliberately absent: it belongs to no repository,
 * so putting it in a per-repo listing would either invent a repo for it or make
 * every row's shape conditional. It is discoverable in `list --json`, which
 * carries `role: "global"` on the session itself.
 */
export async function runListRepos(opts: ListReposOptions): Promise<void> {
  const index = await SessionIndex.build();
  const { live } = refreshLiveTmux(index.all);
  const roles = orchestratorRoles();
  flushWarnings("list repos");

  const byRoot = sessionRows(opts, index.all, live, roles);
  addWalkedCheckouts(byRoot, opts.scope);
  const rows = [...byRoot.values()].sort(byNeed);
  for (const r of rows) r.orchestrators.sort((a, b) => Number(b.running) - Number(a.running));

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(emptyMessage(opts.scope));
    return;
  }
  console.log(REPO_HEADER);
  for (const r of rows) console.log(formatRepoRow(r));
}
