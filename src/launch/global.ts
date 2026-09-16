// Launching the GLOBAL orchestrator — the session that coordinates the per-repo
// orchestrators rather than any repository (see src/orchestration/global.ts).
//
// It belongs to no repo, so — unlike `launchTask` — there is no worktree and no
// branch, and its cwd is only a vantage point the caller picked
// (`globalOrchestratorCwd`). What IS special is the layout: by default it opens
// as a split pane beside the running agendo TUI, so the fleet view and its
// coordinator are on screen together.
import {
  MIN_SPLIT_COLS,
  currentSessionName,
  insideTmux,
  launcherWindowLive,
  launcherWindowTarget,
  liveManagedPaths,
  liveTargetForShortId,
  shortId,
  splitPaneIn,
  type WindowTags,
  splitTargetWidth,
} from "../runtime/tmux/index.ts";
import { orchestratorRoles } from "../orchestration/index.ts";
import { orchestratorCwdRoles } from "../orchestration/cwdMarks.ts";
import type { AgentSource } from "../shared/types.ts";
import { SELF_CMD } from "./selfCommand.ts";
import { freshPanePlan, openTarget, type OpenPlan } from "./open.ts";
import { launchManaged } from "./managed.ts";
import type { LaunchResult } from "./task.ts";

/** Where a global orchestrator's window/pane ended up. */
export type GlobalLayout = "pane" | "window" | "session";

export interface GlobalLaunchOptions {
  /** Cross-repo goal, passed to the new agent as its opening prompt. */
  prompt?: string;
  /**
   * Preferred layout. "pane" (the default) splits the launcher's own window so
   * agendo and the orchestrator are visible at once; "window" gives it a window
   * of its own, for terminals too narrow to split usefully.
   */
  layout?: "pane" | "window";
  /** The launcher's tmux host session, whose `launcher` window gets split.
   *  Defaults to the session the caller is currently in. */
  hostSession?: string;
  /**
   * Run it with the unattended autonomy flags. Off by default for the same
   * reason a repo orchestrator's is (see `ManagedOptions.unattended`), and more
   * so: this level starts orchestrators in other people's MAIN checkouts, which
   * is a larger unreviewed surface than one repo's merges.
   */
  unattended?: boolean;
  /** Which agent runs the orchestrator — Claude or Codex (Copilot can't carry
   *  the orchestrator instructions at all). Defaults to Claude. */
  agent?: AgentSource;
}

export interface GlobalLaunchResult extends LaunchResult {
  /** What actually happened — the requested layout, or what we fell back to. */
  layout: GlobalLayout;
  /** Why the requested pane layout wasn't used; null when it was (or wasn't asked for). */
  layoutNote: string | null;
}

/**
 * A running global orchestrator, found and how it can be referenced.
 *
 * `token`, when present, is the short id `send`/`close` take — always known for
 * Claude (a caller-chosen id, preassigned at launch); never known for Codex,
 * which assigns its own id only after the fact, so its orchestrators are found
 * by working directory instead (see cwdMarks.ts) and there is no id yet to hand
 * back.
 */
export interface LiveGlobalOrchestrator {
  token?: string;
}

/**
 * A running global orchestrator, or null. There is one fleet, so there is one
 * coordinator of it: a second would be starting repo orchestrators in the same
 * repos as the first, each unaware of the other's briefings, and both splitting
 * the same launcher window. A marker alone doesn't mean running — they outlive
 * the session — so liveness is what is actually asked, by id for Claude and by
 * cwd for Codex.
 */
export function liveGlobalOrchestrator(): LiveGlobalOrchestrator | null {
  for (const [id, role] of orchestratorRoles()) {
    if (role !== "global") continue;
    const sid = shortId(id);
    if (liveTargetForShortId(sid)) return { token: sid };
  }
  for (const [cwd, role] of orchestratorCwdRoles()) {
    if (role !== "global") continue;
    if (liveManagedPaths().some((t) => t.cwd === cwd)) return {};
  }
  return null;
}

/** The launcher window to split, or a note saying why we can't split anything. */
function resolveSplitTarget(hostSession?: string): { target: string } | { note: string } {
  // Outside tmux there is no launcher pane to split at all, and `launchManaged`
  // will hand the session its own detached session.
  if (!insideTmux()) return { note: "not inside tmux — no launcher pane to split; started its own session" };
  const host = hostSession ?? currentSessionName();
  if (!host) return { note: "couldn't identify the launcher's tmux session; opened a window instead" };
  if (!launcherWindowLive(host)) return { note: `no live agendo menu in tmux session "${host}"; opened a window instead` };
  const target = launcherWindowTarget(host);
  const cols = splitTargetWidth(target);
  // tmux splits the ACTIVE PANE of the target, so the pane is what gets measured.
  // An unreadable width means it went away from under us; treat that as "don't
  // split" rather than guessing, since we would only fail at split time anyway.
  if (cols === null) return { note: "couldn't measure the agendo menu's pane; opened a window instead" };
  if (cols < MIN_SPLIT_COLS) {
    return {
      note:
        `the agendo menu's pane is ${cols} cols, under the ${MIN_SPLIT_COLS} a usable split needs; ` +
        `opened a window instead`,
    };
  }
  return { target };
}

/**
 * Launch a GLOBAL orchestrator in `cwd`.
 *
 * The pane is only possible when there is a live launcher window to split, so
 * each precondition falls back to a plain window (or, outside tmux, its own
 * detached session) with a note saying why: a narrow terminal, or a launcher
 * started some other way, should still get an orchestrator — just not a split
 * one. The preconditions are resolved BEFORE `launchManaged` runs, because that
 * is what mints the session id, and an id minted for an abandoned attempt would
 * be recorded as an orchestrator that never started.
 */
export function launchGlobalOrchestrator(cwd: string, opts: GlobalLaunchOptions = {}): GlobalLaunchResult {
  // Refused rather than duplicated, and BEFORE the layout work: a second one is
  // never what the caller meant — the one they already have is where the fleet's
  // state lives, so point them at it instead of starting a rival that will
  // re-brief every repo orchestrator from scratch.
  const running = liveGlobalOrchestrator();
  if (running) {
    const reach = running.token
      ? `Talk to it with \`${SELF_CMD} send ${running.token} "…"\`, or end it with \`${SELF_CMD} close ${running.token}\``
      : `Find it with \`${SELF_CMD} list\` — it's a Codex session, so it assigned its own id after launch`;
    return {
      cwd,
      layout: "window",
      layoutNote: null,
      error:
        `a global orchestrator is already running — there is one fleet, so there is one coordinator of ` +
        `it. ${reach} before starting another.`,
    };
  }
  const wantPane = (opts.layout ?? "pane") === "pane";
  const resolved = wantPane ? resolveSplitTarget(opts.hostSession) : null;
  const splitTarget = resolved && "target" in resolved ? resolved.target : null;
  let layout: GlobalLayout = insideTmux() ? "window" : "session";
  let layoutNote = resolved && "note" in resolved ? resolved.note : null;

  // `tags` is forwarded only on the WINDOW fallback. A pane-hosted orchestrator
  // owns no window of its own — it lodges in the launcher's menu window — so a
  // window tag written for it would describe the menu instead (see
  // `stampManagedWindow`, which refuses the same write for the same reason).
  const open = (name: string, runCwd: string, argv: string[], tags?: WindowTags): OpenPlan => {
    if (splitTarget) {
      const pane = splitPaneIn(splitTarget, name, runCwd, argv);
      if (pane) {
        layout = "pane";
        return freshPanePlan(name, pane);
      }
      // tmux refused (almost always "no space for new pane") — fall through.
      layoutNote = "tmux would not split the launcher window; opened a window instead";
    }
    return openTarget(name, runCwd, argv, tags);
  };

  const { plan, id } = launchManaged(cwd, "background", opts.agent ?? "claude", opts.prompt, {
    orchestrator: "global",
    unattended: opts.unattended,
    open,
  });
  return { plan, id, cwd, layout, layoutNote };
}
