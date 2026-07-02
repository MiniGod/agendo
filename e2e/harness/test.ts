// Playwright fixtures shared by the e2e specs. Each test gets:
//   • `mock`   — a fresh isolated environment (createMockEnv), torn down after
//   • `launch` — a factory that boots the launcher in the wterm harness against
//                that environment; every terminal it returns is closed on teardown
import { test as base } from "@playwright/test";
import { join } from "node:path";
import { createMockEnv, REPO_ROOT, type MockEnv } from "./mockEnv.ts";
import { WebTerminal } from "./wterm.ts";

interface Fixtures {
  mock: MockEnv;
  launch: (opts?: { cols?: number; rows?: number; args?: string[] }) => Promise<WebTerminal>;
}

export const test = base.extend<Fixtures>({
  mock: async ({}, use) => {
    const m = await createMockEnv();
    await use(m);
    await m.cleanup();
  },
  launch: async ({ page, mock }, use) => {
    const terminals: WebTerminal[] = [];
    const factory = async (opts: { cols?: number; rows?: number; args?: string[] } = {}) => {
      const wt = await WebTerminal.launch({
        page,
        command: "bun",
        // --no-tmux: render the menu inline (tmux mode is the default now), which
        // is the path these specs drive. insideTmux() is still false here (TMUX
        // is unset in the mock env), so the outside-tmux behaviour is unchanged.
        // Extra `args` (e.g. a `[path]` to scope the launcher) follow the entrypoint.
        args: ["run", join(REPO_ROOT, "src", "index.tsx"), "--no-tmux", ...(opts.args ?? [])],
        cwd: REPO_ROOT,
        env: mock.env,
        cols: opts.cols,
        rows: opts.rows,
      });
      terminals.push(wt);
      return wt;
    };
    await use(factory);
    for (const t of terminals) await t.close();
  },
});

export { expect } from "@playwright/test";
export { KEY } from "./wterm.ts";
