// Orchestrates "open this session". Inside tmux, agents run as windows in the
// current session (so picking one opens a new tab next to you); outside tmux,
// each runs as its own detached session we attach to.
import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSource } from "./types.ts";
import {
  sessionName,
  shortId,
  kindName,
  type LiveTarget,
  liveTargetForShortId,
  hasSession,
  newDetached,
  newWindow,
  windowLocation,
  insideTmux,
  tmuxQuiet,
} from "./tmux.ts";
import { existsSync, realpathSync } from "node:fs";
import { slugify, createWorktree, freeWorktreeBranch, worktreePath } from "./worktree.ts";
import { inspectWorktree, type AdoptedWorktree } from "./worktreeAdopt.ts";
import { repoRootForCwd } from "./repos.ts";
import { ORCHESTRATOR_SLUG, markOrchestratorSession } from "./orchestrator.ts";
import { resumeArgv, freshArgv, preassignsSessionId } from "./launchArgv.ts";

// Re-exported so `./launch.ts` stays the one import path for "starting a
// session" — 13 modules under src/ and e2e/detection.spec.ts already name it,
// and the split below is not a reason to touch any of them. Named explicitly
// rather than `export *`, so helpers that only became cross-module for the
// split (launcherSystemPrompt, withLauncherPrompt) are not promoted into the
// public surface by accident.
export { SELF_CMD, SELF_CMD_ENV, withSelfCmdEnv, notRunningHint } from "./selfCmd.ts";
export { llmGuide } from "./launchPrompt.ts";
export { resumeArgv, preassignsSessionId, FORWARDABLE_LAUNCH_FLAGS } from "./launchArgv.ts";

export interface OpenPlan {
  /** Whether a live tmux target already existed (we just navigate to it). */
  alreadyRunning: boolean;
  tmuxName: string;
  /**
   * "inline" (inside tmux): the agent runs as a window in the current session;
   * the caller runs `handover` *without* unmounting, so the menu stays alive in
   * its own window. "handover" (outside tmux): the agent is its own session; the
   * caller unmounts Ink first, then runs `handover` to attach.
   */
  mode: "inline" | "handover";
  /** argv to run to hand over to / navigate to the target. */
  handover: string[];
}

/**
 * Prepare to open a managed target `name` running `argv` in `cwd`, creating it
 * if needed.
 *
 * - Inside tmux: the agent is a window in the current session. If one already
 *   exists (here or in another session) we switch to it; otherwise we create a
 *   new window and select it — i.e. a new tab next to you. The menu keeps
 *   running in its own window (see `runInline`).
 * - Outside tmux: the agent is its own detached session that we attach to
 *   (attach blocks until you detach, then control returns to the menu).
 */
function openTarget(name: string, cwd: string, argv: string[]): OpenPlan {
  if (insideTmux()) {
    const loc = windowLocation(name);
    if (loc) return { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", loc] };
    // A session by this name may exist from an earlier outside-tmux launch.
    if (hasSession(name)) return { alreadyRunning: true, tmuxName: name, mode: "inline", handover: ["tmux", "switch-client", "-t", name] };
    newWindow(name, cwd, argv);
    return { alreadyRunning: false, tmuxName: name, mode: "inline", handover: ["tmux", "select-window", "-t", name] };
  }
  const alreadyRunning = hasSession(name);
  if (!alreadyRunning) newDetached(name, cwd, argv);
  return { alreadyRunning, tmuxName: name, mode: "handover", handover: ["tmux", "attach-session", "-t", name] };
}

/**
 * Execute an "inline" plan's handover (switch/select the target window) without
 * disturbing the still-mounted menu. The agent window already exists; this just
 * moves the client's focus to it. `handover[0]` is always the literal "tmux".
 */
export function runInline(plan: OpenPlan): void {
  tmuxQuiet(plan.handover.slice(1));
}

/**
 * Resume/attach an existing agent session. If the session is already running
 * under some launcher window — possibly a kind-prefixed one (`cl-bg-`/`cl-new-`)
 * whose name differs from the canonical `cl-claude-<id>` — navigate to that
 * exact window so we never spawn a duplicate. Otherwise (cold resume) open the
 * canonical target, which `claude --resume` fills in.
 *
 * `liveWindow` is the actual window the model attributed this session to
 * (`LoadedModel.liveWindows`). Prefer it: it's the SAME reconciliation that
 * decided the session is running, so it also covers windows `liveTargetForShortId`
 * can't — legacy non-id-bearing names (`cl-pr-…`/`cl-wi-…`/`cl-free-…`) matched by
 * cwd. Without it, a session shown as running under such a window would resume a
 * duplicate instead of attaching.
 */
export function openSession(s: AgentSession, liveWindow?: LiveTarget): OpenPlan {
  // The NAME half: `openTarget` re-resolves the location itself (via
  // `windowLocation`), so it is already host-agnostic and wants the name.
  const target = liveWindow?.name ?? liveTargetForShortId(shortId(s.id))?.name ?? sessionName(s);
  return openTarget(target, s.cwd, resumeArgv(s));
}

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

/**
 * Open a kind-prefixed managed session for `agent` in `cwd`. The `cl-bg-`/
 * `cl-new-` prefix tells the human (and the UI badge) how it started. Background
 * sessions also get the autonomy flags so they run unattended — except
 * orchestrators, which need `unattended` as well (see `ManagedOptions`).
 * `forwardArgv` carries the allowlisted agent flags `agendo launch` accepted; the
 * TUI's own launch paths pass none.
 *
 * For agents that take a caller-chosen id we assign it up front (`--session-id`)
 * so the window name embeds it — that lets `openSession` find this exact window
 * on a later attach instead of spawning a duplicate, and the returned `id` is
 * the real, resumable session id. An orchestrator launch also records the minted
 * id, so a later cold resume can re-inject the instructions claude itself doesn't
 * remember.
 *
 * Codex assigns its own id, so there is nothing to embed: the window gets an
 * id-LESS tagged name (`cl-bg-codex-…`, see `kindName`) and is attributed to its
 * session by working directory — the same route `cl-wi-…`/`cl-pr-…` take, and it
 * yields the genuine codex id once the session's rollout file lands on disk.
 * `id` is undefined in that case; callers must not present the uniquifier as a
 * session id. (Orchestrator mode is Claude-only, so the recorded-id path above
 * never meets this one.)
 */
interface ManagedOptions {
  /** Run in orchestrator mode (Claude only — see `freshArgv`). */
  orchestrator?: boolean;
  /**
   * Give an ORCHESTRATOR the unattended autonomy flags too. Off by default: an
   * orchestrator's whole job is to spawn further sessions and merge into the main
   * checkout, so auto-approving its actions turns one compromised or confused
   * agent into unreviewed writes on the user's primary working tree. Ordinary
   * background sessions are unaffected — they stay autonomous in their own
   * throwaway worktree, which is what makes `agendo launch` useful at all.
   */
  unattended?: boolean;
  /** Allowlisted agent flags to forward verbatim (see `FORWARDABLE_LAUNCH_FLAGS`). */
  forwardArgv?: string[];
}

// A single options object rather than trailing positionals: `orchestrator` (bool)
// and `forwardArgv` (string[]) sit next to each other, and swapping them at a call
// site type-checks under neither — but a third boolean beside `orchestrator` would
// swap silently, turning an ordinary launch into an auto-approving orchestrator.
function launchManaged(
  cwd: string,
  kind: "background" | "new",
  agent: AgentSource,
  prompt?: string,
  opts: ManagedOptions = {},
): { plan: OpenPlan; id?: string } {
  const { orchestrator = false, unattended = false, forwardArgv } = opts;
  const preassigned = preassignsSessionId(agent);
  const uniquifier = randomUUID();
  const tmuxName = kindName(kind, uniquifier, preassigned ? undefined : agent);
  const sessionId = preassigned ? uniquifier : undefined;
  const argv = freshArgv(agent, {
    sessionId,
    prompt,
    // Orchestrators opt IN to autonomy; everything else keeps the old rule.
    autonomy: kind === "background" && (!orchestrator || unattended),
    orchestrator,
    forwardArgv,
  });
  // Orchestrator mode is Claude-only, so there is always an id to record here;
  // the guard is for the type, not for a case that can happen.
  if (orchestrator && sessionId) markOrchestratorSession(sessionId);
  return { plan: openTarget(tmuxName, cwd, argv), id: sessionId };
}

/**
 * Open a manual ("new session") flow session in an already-resolved `cwd`.
 * `orchestrator` runs it in orchestrator mode (Claude only — see `freshArgv`).
 * The minted id is remembered by `launchManaged`, so the restore snapshot picks
 * the orchestrator framing back up via `resumeArgv` without extra bookkeeping here.
 *
 * This is the TUI's path, and `kind: "new"` carries no autonomy flags at all — a
 * session the user started from the menu keeps its normal approval prompts.
 */
export function launchNewSession(
  cwd: string,
  agent: AgentSource = "claude",
  orchestrator = false,
): OpenPlan {
  return launchManaged(cwd, "new", agent, undefined, { orchestrator }).plan;
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
   * src/orchestrator.ts). Claude only.
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
    orchestrator: opts.orchestrator,
    unattended: opts.unattended,
    forwardArgv: opts.forwardArgv,
  });
  return { plan, id, cwd: where.cwd, adopted: where.adopted };
}
