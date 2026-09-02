// The repo-shaped launches: a fresh session for a work item / PR, and the
// worktree-creating `agendo launch` behind `launchTask`.
import { existsSync, realpathSync } from "node:fs";
import type { AgentSource } from "../types.ts";
import { slugify, createWorktree, freeWorktreeBranch, worktreePath } from "../worktree.ts";
import { inspectWorktree, type AdoptedWorktree } from "../worktreeAdopt.ts";
import { repoRootForCwd } from "../repos.ts";
import { ORCHESTRATOR_SLUG } from "../orchestrator.ts";
import { freshArgv } from "../launchArgv.ts";
import { openTarget, type OpenPlan } from "./open.ts";
import { launchManaged } from "./managed.ts";

/**
 * tmux target names for fresh (not-yet-resumable) sessions. `scope` folds a repo
 * discriminator into the name for backends whose ids aren't globally unique
 * (GitHub issue/PR numbers collide across repos); ADO omits it (ids are unique),
 * keeping its names unchanged. tmux forbids `.`/`:` in names, so scope is
 * reduced to `[a-z0-9-]`.
 */
function scopeTag(scope?: string): string {
  if (!scope) return "";
  const tag = scope.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return tag ? `${tag}-` : "";
}
export function freshName(workItemId: number, scope?: string): string {
  return `cl-wi-${scopeTag(scope)}${workItemId}`;
}
export function prFreshName(prId: number, scope?: string): string {
  return `cl-pr-${scopeTag(scope)}${prId}`;
}

/**
 * Launch a brand-new session for `agent` in `cwd` (a freshly created worktree),
 * under the managed target `name`. Used for work-item / PR launches, whose names
 * (`cl-wi-…` / `cl-pr-…`) are attributed back to their session by working
 * directory (see model.ts). Defaults to Claude for back-compat.
 */
export function launchFresh(cwd: string, name: string, agent: AgentSource = "claude"): OpenPlan {
  return openTarget(name, cwd, freshArgv(agent));
}

export interface LaunchOptions {
  /** Task prompt, passed to the new agent as a positional/interactive arg. */
  prompt?: string;
  /** Slug for the worktree/branch; derived from the prompt if omitted. */
  name?: string;
  /**
   * Create an isolated git worktree to run in. Defaults to true — but callers
   * launching an orchestrator should pass `false` (the CLI does): it merges into
   * the main branch, which git only permits in the primary checkout.
   */
  worktree?: boolean;
  /**
   * Run in this EXISTING worktree instead of creating one. It must be a
   * worktree root git registers (see `inspectWorktree`); nothing in it is
   * reset, stashed or checked out. `name` and `worktree: false` do not combine
   * with it — the CLI refuses the pairing before it gets here.
   */
  worktreePath?: string;
  /** Which agent to launch. Defaults to Claude for back-compat. */
  agent?: AgentSource;
  /**
   * Allowlisted agent flags to forward to the new session, as flat
   * `[flag, value, …]` tokens (see `FORWARDABLE_LAUNCH_FLAGS`). The caller is
   * responsible for validating them against `agent` — `agendo launch` does.
   */
  forwardArgv?: string[];
  /**
   * Run the new session in orchestrator mode: it delegates every unit of work to
   * further background sessions instead of implementing anything itself (see
   * src/orchestrator.ts). Claude only. This is the REPO level by construction —
   * a global orchestrator belongs to no repo, so it takes no worktree and has its
   * own entry point (`launchGlobalOrchestrator`) rather than a repo-shaped one.
   */
  orchestrator?: boolean;
  /**
   * Let an orchestrator run with the unattended autonomy flags. Ignored unless
   * `orchestrator` is set (ordinary background sessions are always unattended).
   * See `ManagedOptions.unattended` for why this is opt-in.
   */
  unattended?: boolean;
}

export interface LaunchResult {
  plan?: OpenPlan;
  /** The new session id (also embedded in the tmux name); use with `status`/`--resume`. */
  id?: string;
  /** Directory the new session runs in (the worktree, or `cwd` if `--no-worktree`). */
  cwd: string;
  /**
   * Set when the session landed in a worktree that ALREADY existed — via
   * `worktreePath`, or a `name`/prompt slug whose directory was already there.
   * The caller reports it: which branch, how many uncommitted entries, and (for
   * the by-name case) the branch the slug would normally mean, so a worktree
   * that has drifted onto another branch is named rather than silently used.
   */
  adopted?: AdoptedWorktree & { expectedBranch?: string };
  error?: string;
}

/** `LaunchResult` minus the session: where the launch will run, and how it got there. */
type ResolvedCwd = Pick<LaunchResult, "cwd" | "adopted" | "error">;

/**
 * Adopt the worktree at `path` for a launch keyed by `root` and `branch`: the
 * slug's own directory already exists, so it is reused — but only if git agrees
 * it is a worktree of THIS repo. A directory that merely sits at that path (a
 * removed worktree's leftovers, a stray `mkdir`) used to be launched into as if
 * it were a checkout; now it is refused, and a worktree belonging to some other
 * repository that happens to live under this one's `.claude/worktrees/` is too.
 */
function adoptNamedWorktree(root: string, branch: string, path: string): ResolvedCwd {
  const res = inspectWorktree(path);
  if (!res.worktree) return { cwd: path, error: res.error };
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    /* an unreadable root can't match anyway; compare as given */
  }
  if (res.worktree.mainRoot !== realRoot) {
    return { cwd: path, error: `${path} is a worktree of ${res.worktree.mainRoot}, not of ${root}` };
  }
  return { cwd: res.worktree.path, adopted: { ...res.worktree, expectedBranch: branch } };
}

/**
 * Where a launch runs, and whether that directory pre-existed. Four cases, in
 * precedence order:
 *  - `worktreePath`: that worktree, adopted as-is (wherever it lives).
 *  - `worktree: false`: `cwd` itself — or the repo ROOT for an orchestrator, which
 *    integrates by squash-merging into the main branch, and git allows the main
 *    branch in exactly ONE working tree, the primary checkout. Running it AT the
 *    root, even when invoked from a subdirectory or from inside another worktree,
 *    makes "merge where you are" literally true.
 *  - the slug's worktree directory already exists: adopted (see `adoptNamedWorktree`).
 *  - otherwise a fresh worktree on `worktree-<slug>`.
 * An unnamed orchestrator never adopts: its slug names the ROLE, so it is
 * identical for every unnamed orchestrator in a repo, and two coordinators
 * sharing one working tree — both doing integration merges — is exactly what
 * `freeWorktreeBranch` steps past. An explicit `--name` is the user's own choice.
 */
function resolveLaunchCwd(cwd: string, root: string, slug: string, named: boolean, opts: LaunchOptions): ResolvedCwd {
  if (opts.worktreePath) {
    const res = inspectWorktree(opts.worktreePath);
    return res.worktree ? { cwd: res.worktree.path, adopted: res.worktree } : { cwd, error: res.error };
  }
  if (opts.worktree === false) return { cwd: opts.orchestrator ? root : cwd };
  const branch = opts.orchestrator && !named ? freeWorktreeBranch(root, `worktree-${slug}`) : `worktree-${slug}`;
  const path = worktreePath(root, branch);
  if (existsSync(path)) return adoptNamedWorktree(root, branch, path);
  const res = createWorktree(root, branch);
  return res.error ? { cwd, error: res.error } : { cwd: res.path };
}

/**
 * Launch a background (agent-spawned) session from a prompt — the programmatic
 * entry behind `agendo launch`. Used by a running agent that the user asked to
 * spin up a background session (see `launcherSystemPrompt`).
 *
 * Creates an isolated worktree (unless disabled), then opens a `cl-bg-<id>` tmux
 * target running the chosen agent with the task prompt and (for Claude) the
 * launcher system prompt injected, so the convention propagates to whatever that
 * session spawns next. Defaults to Claude. Copilot and Codex are supported too,
 * but neither has an `--append-system-prompt` equivalent, so their background
 * sessions won't carry the launcher prompt — they run the task unattended but
 * won't autonomously spawn their own nested background sessions.
 *
 * `id` is absent for Codex, which assigns its own session id (see
 * `launchManaged`); the session still appears in `agendo list` once its rollout
 * file lands, and `plan.tmuxName` identifies the window meanwhile.
 */
export function launchTask(cwd: string, opts: LaunchOptions): LaunchResult {
  // An orchestrator's slug should say what the session IS, not repeat the goal it
  // was handed. Only used on the opt-in `worktree: true` path — an orchestrator
  // normally runs in the main checkout and has no branch of its own.
  const fallbackSlug = opts.orchestrator ? ORCHESTRATOR_SLUG : slugify(opts.prompt || "") || "session";
  // Whether `--name` actually produced a usable slug — `--name "  "` / `"!!!"` are
  // truthy but slugify to nothing, so testing `opts.name` alone would treat them
  // as user-chosen and skip the collision stepping below.
  const named = slugify(opts.name || "");
  const slug = named || fallbackSlug;
  const root = repoRootForCwd(cwd);
  const where = resolveLaunchCwd(cwd, root, slug, !!named, opts);
  if (where.error) return { cwd, error: where.error };
  const { plan, id } = launchManaged(where.cwd, "background", opts.agent ?? "claude", opts.prompt, {
    orchestrator: opts.orchestrator ? "repo" : undefined,
    unattended: opts.unattended,
    forwardArgv: opts.forwardArgv,
  });
  return { plan, id, cwd: where.cwd, adopted: where.adopted };
}
