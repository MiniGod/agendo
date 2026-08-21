import type { Key } from "ink";
import { freeWorktreeBranch } from "../../worktree.ts";
import { ORCHESTRATOR_SLUG } from "../../orchestrator.ts";
import type { KeyContext } from "./context.ts";

type Ctx = Pick<KeyContext, "mode" | "setMode" | "startFresh">;

// ── worktree-vs-main choice (free sessions only) ──
// Owns every key while it is up — unhandled ones are swallowed.
export function handleWtchoiceKeys(input: string, key: Key, ctx: Ctx): boolean {
  const mode = ctx.mode;
  if (mode.kind !== "wtchoice") return false;
  if (key.escape) { ctx.setMode({ kind: "repo", target: mode.target, agent: mode.agent, cursor: 0 }); return true; }
  if (key.upArrow || input === "k") {
    ctx.setMode((p) => (p.kind === "wtchoice" ? { ...p, cursor: (p.cursor - 1 + 2) % 2 } : p));
    return true;
  }
  if (key.downArrow || input === "j") {
    ctx.setMode((p) => (p.kind === "wtchoice" ? { ...p, cursor: (p.cursor + 1) % 2 } : p));
    return true;
  }
  if (key.return) {
    const worktree = mode.cursor === 0;
    // Orchestrator in the main checkout: nothing to name (the main-repo path
    // discards the name anyway, and it has no branch of its own), so launch
    // straight away instead of showing a prompt whose value is thrown out.
    if (!worktree && mode.target.orchestrator) {
      ctx.startFresh(mode.target, mode.repo, ORCHESTRATOR_SLUG, false, mode.agent);
      return true;
    }
    // A plain free session has no default name (defaultBranch is ""), so this
    // still opens an empty prompt; an orchestrator prefills its own role slug,
    // stepped past any orchestrator worktree already in this repo. Only a
    // preview — `startFresh` re-derives it at create time, since the user may
    // sit on this screen for a while. (Moot for the main-repo option, which
    // ignores the name entirely.)
    const seed =
      worktree && mode.target.defaultBranch
        ? freeWorktreeBranch(mode.repo.root, mode.target.defaultBranch)
        : mode.target.defaultBranch;
    ctx.setMode({
      kind: "branch",
      target: mode.target,
      agent: mode.agent,
      repo: mode.repo,
      value: seed,
      cursor: seed.length,
      worktree,
      seed: seed || undefined,
    });
    return true;
  }
  return true;
}
