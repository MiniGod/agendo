// The TUI's half of "one repo, one orchestrator": before any entry point starts
// a repo orchestrator, ask whether the repo already has one, and if it does,
// bring the user to it instead. Which one counts is decided by
// src/orchestration/repoOrchestrator.ts; reaching it, by
// src/launch/existingOrchestrator.ts. What is left here is the model plumbing and
// the notice that says why no new session was started.
import { basename } from "path";
import {
  existingLabel,
  findRepoOrchestrator,
  openExistingOrchestrator,
  type OrchestratorLive,
} from "../../launch/existingOrchestrator.ts";
import type { OpenPlan } from "../../launch/index.ts";
import type { LoadedModel } from "../../app/model/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import type { Mode } from "../keys/context.ts";

/** The live state the orchestrator rule reads, off a loaded model. */
export function liveOf(model: LoadedModel): OrchestratorLive {
  return {
    live: model.liveTmux,
    placeholders: model.livePlaceholders,
    windows: model.liveWindows,
    placeholderWindows: model.placeholderWindows,
  };
}

/** Every local session the model knows, scope or no scope — an orchestrator outside the view is still THE one. */
export function modelSessions(model: LoadedModel): AgentSession[] {
  return model.sessionGroups.flatMap((g) => g.sessions);
}

/**
 * `openExisting(root)`: when `root` already has an orchestrator, go to it and
 * return true; otherwise do nothing and return false, so the caller starts one.
 */
export function makeOrchestratorFlow(d: {
  model: LoadedModel | null;
  open: (plan: OpenPlan) => void;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
}) {
  const openExisting = (root: string): boolean => {
    if (!d.model) return false;
    const live = liveOf(d.model);
    const found = findRepoOrchestrator(root, modelSessions(d.model), live);
    if (!found) return false;
    const resumed = found.kind === "session" && found.primary.state !== "running";
    d.setMode({ kind: "list" });
    d.open(openExistingOrchestrator(found, live));
    d.setNotice(
      `▸ ${basename(root)} already has an orchestrator — ${resumed ? "resumed" : "switched to"} ${existingLabel(found)} instead of starting a second`,
    );
    return true;
  };
  return { openExisting };
}
