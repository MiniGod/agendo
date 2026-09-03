import { type LoadedModel, filterModelByRepos, loadModel } from "../model.ts";
import { detectScopeProvider } from "../provider.ts";
import { discoverGitReposUnder } from "../repos.ts";
import { sessionName, shortId } from "../tmux.ts";
import type { AgentSession, AgentSource } from "../types.ts";
import { currentModelOptions } from "./links.ts";
import { flushWarnings } from "./warnings.ts";

/** A session working a PR / issue's branch, as reported by the resource lists. */
export interface AssocSession {
  id: string;
  shortId: string;
  source: AgentSource;
  running: boolean;
}

/**
 * The sessions matched onto a PR / work item, ranked best-first: running before
 * idle, then most-recently-used. The human table shows only the first (the one
 * an orchestrator would poke); JSON keeps them all, first being the best pick.
 */
export function assocSessions(sessions: AgentSession[], live: Set<string>): AssocSession[] {
  return [...sessions]
    .sort((a, b) => {
      const ra = live.has(sessionName(a));
      const rb = live.has(sessionName(b));
      if (ra !== rb) return ra ? -1 : 1;
      return b.lastUsed.getTime() - a.lastUsed.getTime();
    })
    .map((s) => ({ id: s.id, shortId: shortId(s.id), source: s.source, running: live.has(sessionName(s)) }));
}

/** Shared options of the two resource lists (`list pr` / `list issues`). */
export interface ResourceListOptions {
  /** Emit JSON instead of a human table. */
  json: boolean;
  /** Path context from the `[dir]` positional (absolute), or null for none. */
  filterRoot: string | null;
  /** Whether to narrow the listing to the repos inside that path context. */
  repoFilter: boolean;
}

/**
 * Load the model the way the menu does for a path context: the git repos found
 * under `[dir]` widen the fetch set (so a repo there that never hosted a session
 * is still queried), and — unless `--no-repo-filter` — narrow the work-item / PR
 * lists to them. A dir holding no repo at all is far more likely a wrong path
 * than an intentional "show nothing", so we say so and leave the list unfiltered.
 * The backend is resolved from the dir too — the tracker its origin points at
 * (or, for a plain parent folder, its repos' origins) wins over the persisted
 * default, exactly as the menu does — otherwise we'd query one backend and filter
 * it against the other's repo identities.
 */
export async function loadScopedModel(opts: ResourceListOptions): Promise<LoadedModel> {
  const scopeRepos = opts.filterRoot ? discoverGitReposUnder(opts.filterRoot) : [];
  if (opts.filterRoot && scopeRepos.length === 0)
    console.error(`list: no git repos found under ${opts.filterRoot} — listing everything.`);
  const forced = opts.filterRoot ? detectScopeProvider(opts.filterRoot, scopeRepos) : null;
  const model = await loadModel({ ...currentModelOptions(forced), scopeRepos });
  return filterModelByRepos(model, opts.repoFilter ? model.repoScope : null);
}

/**
 * The model for a listing, or exit 1 saying why. The warnings are flushed
 * either way — under `what`, the command's name — so a failed load still
 * reports what it saw on the way there.
 */
export async function loadModelOrExit(opts: ResourceListOptions, what: string, noun: string): Promise<LoadedModel> {
  let model: LoadedModel;
  try {
    model = await loadScopedModel(opts);
  } catch (e) {
    flushWarnings(what);
    console.error(`${what}: could not load ${noun} from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  }
  flushWarnings(what);
  return model;
}

/** The first column of a resource table: ● a running session, ○ an idle one, blank for none. */
export function sessionMark(sessions: AssocSession[]): string {
  if (sessions[0]?.running) return "●";
  return sessions.length ? "○" : " ";
}

/** One line of whitespace, as a title reads in a table. */
export const oneLine = (title: string): string => title.replace(/\s+/g, " ").trim();
