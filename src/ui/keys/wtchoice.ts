import type { Key } from "ink";
import { freeWorktreeBranch } from "../../worktree.ts";
import { ORCHESTRATOR_SLUG } from "../../orchestrator.ts";
import type { KeyContext, Mode } from "./context.ts";
import { listStep } from "./nav.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "startFresh">;
type WtchoiceMode = Extract<Mode, { kind: "wtchoice" }>;

/**
 * The name the branch prompt opens with. A plain free session has no default
 * name (defaultBranch is ""), so the prompt opens empty; an orchestrator
 * prefills its own role slug, stepped past any orchestrator worktree already in
 * this repo. Only a preview — `startFresh` re-derives it at create time, since
 * the user may sit on this screen for a while. (Moot for the main-repo option,
 * which ignores the name entirely.)
 */
export function branchSeed(mode: WtchoiceMode, worktree: boolean): string {
  return worktree && mode.target.defaultBranch
    ? freeWorktreeBranch(mode.repo.root, mode.target.defaultBranch)
    : mode.target.defaultBranch;
}

/** The branch prompt for the choice made, prefilled with `seed`. */
export function branchPrompt(mode: WtchoiceMode, worktree: boolean, seed: string): Mode {
  return {
    kind: "branch",
    target: mode.target,
    agent: mode.agent,
    repo: mode.repo,
    value: seed,
    cursor: seed.length,
    worktree,
    seed: seed || undefined,
  };
}

/**
 * Enter on the highlighted row. Orchestrator in the main checkout: nothing to
 * name (the main-repo path discards the name anyway, and it has no branch of
 * its own), so launch straight away instead of showing a prompt whose value is
 * thrown out.
 */
export function chooseWorktree(ctx: Ctx, mode: WtchoiceMode): void {
  const worktree = mode.cursor === 0;
  if (!worktree && mode.target.orchestrator) {
    ctx.startFresh(mode.target, mode.repo, ORCHESTRATOR_SLUG, false, mode.agent);
    return;
  }
  ctx.setMode(branchPrompt(mode, worktree, branchSeed(mode, worktree)));
}

/** Two rows, so a step either way lands on the other one. */
function stepWtchoice(step: 1 | -1): (p: Mode) => Mode {
  return (p) => (p.kind === "wtchoice" ? { ...p, cursor: (p.cursor + step + 2) % 2 } : p);
}

// ── worktree-vs-main choice (free sessions only) ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleWtchoiceKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "wtchoice") return false;
  if (key.escape) { ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 }); return true; }
  const step = listStep(input, key);
  if (step !== null) ctx.setMode(stepWtchoice(step));
  else if (key.return) chooseWorktree(ctx, mode);
  return true;
}
