// `launch --orchestrator` in a repo that already has one.
//
// One repo, one orchestrator (src/orchestration/repoOrchestrator.ts) holds for
// the CLI exactly as for the TUI's `O`: a second would squash-merge into the
// same main branch as the first, each unaware of what the other briefed. So the
// launch looks first, and when the repo has one it says so and reuses it —
// leaving a running one alone, resuming a paused or idle one the way `resume`
// does — instead of starting another.
//
// A prompt given to such a launch is NOT delivered. The existing orchestrator
// may be mid-turn, and typing into it unasked is `send`'s job, with `send`'s
// readiness checks; the report spells out the command instead. Nor do the flags
// that would only shape a NEW one (`--worktree`, `--model`, …) — the report
// names those too, since a caller who wrote one believes it changed something.
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { basename, resolve } from "path";
import { SELF_CMD } from "../../launch/index.ts";
import {
  existingLabel,
  findRepoOrchestrator,
  openExistingOrchestrator,
  orchestratorFacts,
  windowAgent,
  type ExistingOrchestrator,
  type OrchestratorLive,
} from "../../launch/existingOrchestrator.ts";
import { refreshLiveTmux } from "../../app/model/index.ts";
import { repoRootForCwd } from "../../repositories/index.ts";
import { scopeRepoRoot } from "../../repositories/scopeRepo.ts";
import { flatTitle, repoOrchestratorStatuses, type OrchestratorCandidate } from "../../orchestration/repoOrchestrator.ts";
import type { AgentSession, AgentSource } from "../../shared/types.ts";
import { SessionIndex } from "../../sessions/index.ts";
import { ID_BEARING_NAME, shortId } from "../../runtime/tmux/index.ts";
import { runResume } from "./resume.ts";

/**
 * The token `send` / `status` take for it: the short id, or the window name of
 * one with no session yet — but only a name that carries its id. A Codex
 * window's does not (Codex picks its id once it runs), so there is no token to
 * give until its session shows up in `list`.
 */
function tokenOf(found: ExistingOrchestrator): string | null {
  if (found.kind === "session") return shortId(found.primary.session.id);
  return ID_BEARING_NAME.test(found.target.name) ? found.target.name : null;
}

/** Where a prompt for it goes: the `send` to run, or how to find its id first. */
function sendLine(token: string | null, prompt: string): string {
  const how = token ? `\`${SELF_CMD} send ${token} "<prompt>"\`` : `\`${SELF_CMD} send <id> "<prompt>"\` once \`${SELF_CMD} list\` shows its id`;
  return prompt ? `  prompt:  NOT delivered — send it with ${how}` : `  send:    ${how}`;
}

/** The `launch` flags that only shape a NEW orchestrator (a `LaunchArgs` fits). */
export interface NewOnlyFlags {
  name?: string;
  worktree?: boolean;
  worktreePath?: string;
  unattended: boolean;
  agent: AgentSource;
  forwardArgv: readonly string[];
}

/** Which of them were given, by the spelling the caller would recognise; empty when none were. */
export function ignoredFlags(a: NewOnlyFlags, found: ExistingOrchestrator): string[] {
  const out: string[] = [];
  if (a.name !== undefined) out.push("--name");
  if (a.worktreePath !== undefined) out.push("--worktree=<path>");
  else if (a.worktree !== undefined) out.push(a.worktree ? "--worktree" : "--no-worktree");
  // Asking for the agent it already runs on changes nothing, so it isn't news.
  const runsOn = found.kind === "session" ? found.primary.session.source : windowAgent(found.target);
  if (a.agent !== "claude" && a.agent !== runsOn) out.push(`--agent ${a.agent}`);
  if (a.unattended) out.push("--unattended");
  // `[flag, value, …]` pairs: the flags are the even slots, whatever the values look like.
  out.push(...a.forwardArgv.filter((_, i) => i % 2 === 0));
  return out;
}

/** One stale candidate, named and promised to be left alone. */
function staleLine(c: OrchestratorCandidate): string {
  return `  stale:   ${shortId(c.session.id)}  ${flatTitle(c.session.title)} (${c.state}) — left alone`;
}

/**
 * What a launch that DOES start one says about the look-alikes beside it: a
 * session whose title says orchestrator, but which was never recorded as one, is
 * not reused — and not hidden either. Empty when there are none.
 */
export function lookAlikeReport(repo: string, lookAlikes: readonly OrchestratorCandidate[]): string[] {
  if (lookAlikes.length === 0) return [];
  return [`▸ ${repo} has no recorded orchestrator, so this starts one — only LOOKING like one is not enough to be reused:`, ...lookAlikes.map(staleLine)];
}

/** The lines the reuse prints: what was found, what was done, and where an undelivered prompt goes. */
export function reuseReport(repo: string, found: ExistingOrchestrator, prompt: string, ignored: readonly string[] = []): string[] {
  const token = tokenOf(found);
  const running = found.kind === "pending" || found.primary.state === "running";
  const state = found.kind === "pending" ? "starting" : found.primary.state;
  const lines = [
    `▸ ${repo} already has an orchestrator (${state}): ${existingLabel(found)} — ${running ? "not starting a second" : "resuming it instead of starting a second"}`,
  ];
  // Named here rather than pointed at: `list repos` only knows the recorded
  // ones, and a legacy look-alike is exactly the stale session worth seeing.
  lines.push(...(found.kind === "session" ? found.status.stale : []).map(staleLine));
  if (ignored.length) lines.push(`  ignored: ${ignored.join(", ")} — they shape a new orchestrator, and none is started`);
  lines.push(sendLine(token, prompt));
  // The same agendo:// link a fresh launch prints: a window too new to have a
  // session goes by its window name, which resolves once the session starts.
  const linked = found.kind === "session" ? shortId(found.primary.session.id) : found.target.name;
  lines.push(`  link:    agendo://focus?session=${linked}`);
  return lines;
}

/**
 * When the repo the launch would run in already has an orchestrator, reuse it
 * and return true; return false when it has none, so the launch goes ahead.
 *
 * That repo is the one `cwd` belongs to — or, given `--worktree=<path>`, the one
 * that path belongs to, since the launch adopts the path wherever it lives and
 * would otherwise start a second orchestrator in a repo this never looked at.
 * Either way it is the MAIN checkout (`scopeRepoRoot`), so a launch from inside
 * a worktree still finds the orchestrator running in the repo root.
 */
export async function reuseRepoOrchestrator(
  args: NewOnlyFlags & { attach: boolean },
  prompt: string,
  cwd: string = process.cwd(),
): Promise<boolean> {
  const { attach } = args;
  const where = args.worktreePath === undefined ? cwd : resolve(cwd, args.worktreePath);
  // A path that isn't there: the launch's own error says so, better than this guessing a repo.
  if (!existsSync(where)) return false;
  const root = scopeRepoRoot(where) ?? repoRootForCwd(where);
  const repo = basename(root) || root;
  const index = await SessionIndex.build();
  const t = refreshLiveTmux(index.all);
  const live = { live: t.live, placeholders: t.livePlaceholders, windows: t.liveWindows, placeholderWindows: t.placeholderWindows };
  const found = findRepoOrchestrator(root, index.all, live);
  if (!found) {
    // On stderr, like the adoption notice: the launch summary on stdout keeps its shape.
    for (const line of lookAlikeReport(repo, lookAlikesIn(root, index.all, live))) console.error(line);
    return false;
  }
  for (const line of reuseReport(repo, found, prompt, ignoredFlags(args, found))) console.log(line);
  // Paused or idle: exactly what `resume` does with it, so the two can't drift.
  if (found.kind === "session" && found.primary.state !== "running") {
    await runResume(found.primary.session.id, attach);
    return true;
  }
  if (attach) {
    const [cmd, ...argv] = openExistingOrchestrator(found, live).handover;
    spawnSync(cmd, argv, { stdio: "inherit" });
  }
  return true;
}

/** The look-alikes in a repo the rule found no orchestrator in — every candidate it has is one. */
function lookAlikesIn(root: string, sessions: readonly AgentSession[], live: OrchestratorLive): OrchestratorCandidate[] {
  return repoOrchestratorStatuses([root], sessions, orchestratorFacts(live))[0].stale;
}
