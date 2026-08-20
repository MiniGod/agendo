import React from "react";
import { render } from "ink";
import App from "../ui/App.tsx";
import type { LauncherContext } from "../context.ts";
import type { OpenPlan } from "../launch.ts";

/** Render the menu once; resolves with the chosen plan, or null if the user quit. */
export function runMenu(ctx: LauncherContext): Promise<OpenPlan | null> {
  return new Promise((resolve) => {
    const chosen: { plan: OpenPlan | null } = { plan: null };
    const { waitUntilExit } = render(
      <App onOpen={(p) => { chosen.plan = p; }} filterRoot={ctx.filterRoot} hostSession={ctx.hostSession} />,
    );
    waitUntilExit().then(() => resolve(chosen.plan));
  });
}
