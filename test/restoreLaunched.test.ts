// Recording a just-launched session as a restore tab (src/restore.ts). The e2e
// suite launches through the real CLI, but its launched windows never land in
// the launcher's own tmux session, so the function always returned at its
// first line there. The rest is here, on a host of maps: the tab's shape, the
// title squashed and falling back to the canonical name, the dedup by that
// name, and the no-op for a window that is not the launcher's.
import { describe, expect, test } from "bun:test";
import { launchedTab, recordLaunchedSession, type RestoreHost } from "../src/restore.ts";
import type { RestoreTab } from "../src/restore/store.ts";

const id = "abcdef12-3456-7890-abcd-ef1234567890";

function fakeHost(windows: string[], tabs: RestoreTab[]): RestoreHost & { saved: RestoreTab[][] } {
  const saved: RestoreTab[][] = [];
  return {
    saved,
    windowNames: () => windows,
    load: () => tabs,
    save: (_h, t) => void saved.push(t),
  };
}

describe("launchedTab", () => {
  test("a claude session by default, its title squashed, the argv the one that resumes it", () => {
    const tab = launchedTab({ id, cwd: "/w", title: "  Fix   the\n thing " });
    expect(tab).toMatchObject({ name: "cl-claude-abcdef123456", cwd: "/w", title: "Fix the thing" });
    expect(tab.argv).toContain("--resume");
    expect(tab.argv).toContain(id);
  });

  test("no title falls back to the canonical name; the source names the agent", () => {
    const tab = launchedTab({ id, cwd: "/w", source: "codex" });
    expect(tab.name).toBe("cl-codex-abcdef123456");
    expect(tab.title).toBe("cl-codex-abcdef123456");
    expect(tab.argv.join(" ")).toContain(`codex resume ${id}`);
  });
});

describe("recordLaunchedSession", () => {
  test("a window that did not land in the launcher session records nothing", () => {
    const host = fakeHost(["cl-wi-7"], []);
    recordLaunchedSession({ id, cwd: "/w" }, "cl-bg-abcdef123456", "agendo", host);
    expect(host.saved).toEqual([]);
  });

  test("the tab is appended, replacing any prior tab of the same name and keeping the others", () => {
    const other: RestoreTab = { name: "cl-claude-000000000000", cwd: "/x", title: "x", argv: ["claude"] };
    const stale: RestoreTab = { name: "cl-claude-abcdef123456", cwd: "/old", title: "old", argv: ["claude"] };
    const host = fakeHost(["cl-bg-abcdef123456"], [stale, other]);
    recordLaunchedSession({ id, cwd: "/w", title: "new" }, "cl-bg-abcdef123456", "agendo", host);
    expect(host.saved).toHaveLength(1);
    expect(host.saved[0]!.map((t) => [t.name, t.cwd, t.title])).toEqual([
      ["cl-claude-000000000000", "/x", "x"],
      ["cl-claude-abcdef123456", "/w", "new"],
    ]);
  });
});
