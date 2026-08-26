import { launchFresh, launchNewSession, runInline, type OpenPlan } from "../launch.ts";
import { createWorktree, checkoutWorktree, freeWorktreeBranch } from "../worktree.ts";
import { isGitCheckout, type RepoInfo } from "../repos.ts";
import { openUrl } from "../browser.ts";
import { freeTarget, orchestratorTarget, type FreshTarget } from "./targets.ts";
import type { LoadedModel } from "../model.ts";
import type { AgentSource } from "../types.ts";
import type { Mode } from "./keys/context.ts";


/** Everything the session-start closures below read or drive. */
interface FlowDeps {
  model: LoadedModel | null;
  scopedRepos: RepoInfo[];
  cloneNoteRef: { current: string | null };
  onOpen: (plan: OpenPlan) => void;
  exit: () => void;
  reload: () => void;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
  setBusy: (b: string | null) => void;
  setCloneNote: (n: string | null) => void;
}

/**
 * WHERE a chosen session runs: PR branch checkout, new worktree, or the main
 * checkout — plus the branch/worktree prompts that lead to each.
 *
 * Split from `makeSessionFlow` below only to keep both factories inside the
 * shared max-lines-per-function budget; they are one flow and the entry points
 * spread this object straight into their own. `open` is passed in rather than
 * closed over because it is the one step that can unmount App.
 */
function makeLaunchRoutes(d: FlowDeps, open: (plan: OpenPlan) => void) {
  // After the agent is chosen, resolve where to run: PRs check out their branch
  // as soon as the repo is known; work items prompt for a new branch name.
  const proceedFresh = (target: FreshTarget, agent: AgentSource) => {
    const repo = target.preferRepo ? d.model?.repos.find((r: RepoInfo) => r.name === target.preferRepo) : undefined;
    if (target.kind === "pr") {
      if (repo) return startCheckout(target, repo, agent);
      return d.setMode({ kind: "repo", target, agent, cursor: 0 });
    }
    if (repo) d.setMode({ kind: "branch", target, agent, repo, value: target.defaultBranch, cursor: target.defaultBranch.length, worktree: true });
    else d.setMode({ kind: "repo", target, agent, cursor: 0 });
  };

  // Work item / free session: create a branch+worktree or launch in main repo directly.
  //
  // `seed` (orchestrator flow only) is what the name field was prefilled with. If
  // the user never edited it, we re-derive a free name HERE rather than trusting
  // the one computed when the screen opened — another orchestrator (a CLI launch,
  // or a second launcher) may have taken it in the meantime, and `createWorktree`
  // treats an existing path as success, so the stale name would silently drop this
  // session into that one's checkout. A name the user typed is left alone.
  const startFresh = (
    target: FreshTarget,
    repo: RepoInfo,
    name: string,
    worktree: boolean,
    agent: AgentSource,
    seed?: string,
  ) => {
    // A manual "new session" assigns its own session id (so it gets a canonical,
    // attachable `cl-new-<id>` window); work-item / PR launches keep their
    // item-named target. Both run the chosen agent in the resolved directory.
    const launch = (cwd: string) =>
      open(
        target.kind === "free"
          ? launchNewSession(cwd, agent, target.orchestrator)
          : launchFresh(cwd, target.tmuxName, agent),
      );
    if (worktree) {
      // Untouched orchestrator default → re-derive from the base slug at the last
      // possible moment (see the note above). Anything the user typed is used verbatim.
      const branch =
        seed && name.trim() === seed
          ? freeWorktreeBranch(repo.root, target.defaultBranch)
          : name.trim();
      d.setBusy(`Creating worktree ${branch} in ${repo.name}…`);
      const res = createWorktree(repo.root, branch);
      if (res.error) {
        d.setBusy(null);
        d.setMode({ kind: "list" });
        // Nothing launched, so no launch notice will consume the clone note —
        // drop it here or it would attach itself to some later, unrelated one.
        d.cloneNoteRef.current = null;
        d.setNotice(`Worktree failed: ${res.error}`);
        return;
      }
      d.setBusy(null);
      d.setMode({ kind: "list" });
      launch(res.path);
    } else {
      d.setMode({ kind: "list" });
      launch(repo.root);
    }
  };

  const openInBrowser = (target: { id: number; url: string }, label: string) => {
    d.setNotice(`Opening ${label} in browser…`);
    openUrl(target.url, (e) => d.setNotice(`Couldn't open browser: ${e.message}`));
    d.setMode({ kind: "list" });
  };

  // PR: check out the PR's existing branch from origin (never a new branch).
  const startCheckout = (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => {
    const branch = target.prBranch ?? target.defaultBranch;
    d.setBusy(`Checking out ${branch} in ${repo.name}…`);
    const res = checkoutWorktree(repo.root, branch);
    if (res.error) {
      d.setBusy(null);
      d.setMode({ kind: "list" });
      d.cloneNoteRef.current = null; // see startFresh — nothing launched to carry it
      d.setNotice(`Worktree failed: ${res.error}`);
      return;
    }
    d.setBusy(null);
    d.setMode({ kind: "list" });
    open(launchFresh(res.path, target.tmuxName, agent));
  };

  // A repo has been chosen — from the picker, or as the result of a clone. Every
  // downstream route (PR checkout / branch prompt / worktree-vs-main) hangs off
  // this one function, so a cloned repo takes the exact same path as one that was
  // already on disk; there is no second session-creation flow.
  const chooseRepo = (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => {
    if (target.kind === "pr") return startCheckout(target, repo, agent);
    // Default to "New git worktree" (cursor 0) only where one can exist and makes
    // sense. Two cases point at "Main repo checkout" (cursor 1) instead; both
    // options stay on screen either way:
    //  - Orchestrators: that's where the main branch lives, and merging is their
    //    whole job (see the wtchoice hint).
    //  - A non-repo folder (`agendo ~/git` → the scoped parent itself), where
    //    `git worktree add` can only ever print "fatal: not a git repository",
    //    so defaulting to it makes the enter-enter-enter happy path dead-end.
    // INTERIM: the non-repo case really wants its own pair of options (run
    // here / clone-or-init something), not a worktree-vs-checkout question —
    // this just stops the default from being the one that cannot work.
    if (target.kind === "free")
      return d.setMode({
        kind: "wtchoice",
        target,
        agent,
        repo,
        cursor: target.orchestrator || !isGitCheckout(repo.root) ? 1 : 0,
      });
    return d.setMode({
      kind: "branch",
      target,
      agent,
      repo,
      value: target.defaultBranch,
      cursor: target.defaultBranch.length,
      worktree: true,
    });
  };

  return { proceedFresh, startFresh, startCheckout, chooseRepo, openInBrowser };
}

/**
 * Starting a session: pick the agent, pick the repo, resolve where it runs
 * (worktree, main checkout, or a PR's existing branch), launch it.
 *
 * Every route into a new session funnels through `chooseRepo`, so a repo that
 * was just cloned takes the identical path to one that was already on disk —
 * there is no second session-creation flow. That property is why the whole block
 * moves as ONE module rather than being split by entry point.
 *
 * Same shape and the same reasoning as `makeCloneActions` next door: these are
 * plain closures, not hooks. Nothing in here calls `useState`, arms an effect or
 * otherwise cares where in the render it sits, so lifting them out of App cannot
 * change hook or effect order — and the factory is still invoked from the line
 * the block occupied, so the callbacks that close over `open` and `chooseRepo`
 * (`makeCloneActions`, `makeContinueInOtherAgent`) still see them defined.
 */
export function makeSessionFlow({
  model,
  scopedRepos,
  cloneNoteRef,
  onOpen,
  exit,
  reload,
  setMode,
  setNotice,
  setBusy,
  setCloneNote,
}: {
  model: LoadedModel | null;
  scopedRepos: RepoInfo[];
  cloneNoteRef: { current: string | null };
  onOpen: (plan: OpenPlan) => void;
  exit: () => void;
  reload: () => void;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
  setBusy: (b: string | null) => void;
  setCloneNote: (n: string | null) => void;
}) {
  // Every fresh flow starts by choosing the agent (Claude or Copilot); once
  // picked, `proceedFresh` runs the original repo/branch/checkout routing.
  const enterFresh = (target: FreshTarget) => {
    setNotice(null);
    setCloneNote(null);
    cloneNoteRef.current = null;
    setMode({ kind: "agent", target, cursor: 0 });
  };

  // Both free-session entry points (new session, orchestrator) need repos to pick
  // from; without any, the flow has nowhere to run, so say why instead of opening
  // an empty picker.
  //
  // `scopedRepos` is never empty once the model is loaded: scoped keeps the
  // scoped folder, unscoped falls back to the launcher's cwd. So the only real
  // way to land here is the model not being loaded yet — the length guard below
  // is belt-and-braces, kept so a future change to that list can't silently
  // resurrect the empty picker instead of saying something.
  const haveRepos = () => {
    if (!model) {
      setNotice("Still loading — try again in a moment.");
      return false;
    }
    if (scopedRepos.length === 0) {
      // Leads with `agendo <dir>` on purpose: a plain "cd there and rerun" is
      // wrong in the default tmux mode, where rerunning re-attaches to the
      // ALREADY-RUNNING launcher (enterLauncherSession only spawns a new one
      // when the launcher window is dead), so the process keeps its original cwd
      // and nothing changes. A path arg resolves to its own host session, so it
      // always takes effect — and quitting first is the other way out.
      setNotice("No repo to start in — run `agendo <dir>` pointing at a git checkout (or quit with q, cd there, rerun).");
      return false;
    }
    return true;
  };

  // Entering either free-session flow clears a leftover clone note: it reports the
  // outcome of the LAST clone, and carrying it into a fresh pass through the
  // picker would caption an unrelated repo choice.
  const enterNewSession = () => {
    setNotice(null);
    setCloneNote(null);
    cloneNoteRef.current = null;
    if (!haveRepos()) return;
    setMode({ kind: "agent", target: freeTarget(), cursor: 0 });
  };

  /**
   * Open the orchestrator flow: the same repo → worktree → name steps as a plain
   * new session, but the agent picker is skipped (orchestrator mode is Claude-only,
   * so there's nothing to choose) and the session launches with the orchestrator
   * instructions injected.
   */
  const enterOrchestrator = () => {
    setNotice(null);
    setCloneNote(null);
    cloneNoteRef.current = null;
    if (!haveRepos()) return;
    setMode({ kind: "repo", target: orchestratorTarget(), agent: "claude", cursor: 0 });
  };

  // Open a prepared plan. Outside tmux we unmount and let index.tsx attach;
  // inside tmux we switch to the agent's window but keep the menu mounted in its
  // own window, then refresh so running badges are current when you switch back.
  const open = (plan: OpenPlan) => {
    if (plan.mode === "handover") {
      onOpen(plan);
      exit();
      return;
    }
    runInline(plan);
    // A clone that fed straight into this launch (the PR flow does it in one
    // keystroke) reports itself here — otherwise "where did it clone to?" would
    // have no screen left to appear on.
    const cloned = cloneNoteRef.current ? `${cloneNoteRef.current} · ` : "";
    cloneNoteRef.current = null;
    setNotice(`${cloned}▸ ${plan.alreadyRunning ? "switched to" : "opened"} ${plan.tmuxName} — switch back to this window for more`);
    reload();
  };

  return {
    ...makeLaunchRoutes(
      { model, scopedRepos, cloneNoteRef, onOpen, exit, reload, setMode, setNotice, setBusy, setCloneNote },
      open,
    ),
    enterFresh,
    enterNewSession,
    enterOrchestrator,
    open,
  };
}
