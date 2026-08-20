import React from "react";
import { render } from "ink";
import App from "../ui/App.tsx";
import type { LauncherContext } from "../context.ts";
import type { OpenPlan } from "../launch.ts";

/**
 * Render the menu once; resolves with the chosen plan, or null if the user quit.
 *
 * This module is why `react`, `ink` and `ui/App.tsx` are no longer index.tsx's
 * first imports. ES module evaluation is depth-first in import order, so their
 * bodies now run AFTER tmux.ts/launch.ts/sessions.ts rather than before. That is
 * inert today — nothing under src/ has an import-time side effect (index.tsx's
 * own top-level dispatch is the only such code in the tree), and react/ink are
 * declaration-only, with ink touching stdin inside `render()` and not at import.
 *
 * It is written down because it is the one ordering change the top-level
 * statement sequence does NOT show, and the seam where an import-time side
 * effect added later would first bite.
 */
export function runMenu(ctx: LauncherContext): Promise<OpenPlan | null> {
  return new Promise((resolve) => {
    const chosen: { plan: OpenPlan | null } = { plan: null };
    const { waitUntilExit } = render(
      <App onOpen={(p) => { chosen.plan = p; }} filterRoot={ctx.filterRoot} hostSession={ctx.hostSession} />,
    );
    waitUntilExit().then(() => resolve(chosen.plan));
  });
}
