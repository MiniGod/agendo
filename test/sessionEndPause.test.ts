// What pausing needs that closing does not (src/app/sessionEnd/pause.ts). The
// e2e suite pauses a real launcher tab against the fake tmux; the shapes a pause
// must refuse — a pane-hosted session, a standalone tmux session, one with no
// transcript, one whose directory is gone — are each decided here, before any
// kill, so they are pinned on their own.
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { loneTabRefusal, pausedTab, unpausableReason } from "../src/app/sessionEnd/pause.ts";
import type { AgentSession } from "../src/shared/types.ts";

const session = {
  source: "claude",
  id: "abcdef12-3456-7890-abcd-ef1234567890",
  cwd: tmpdir(),
  title: "  Fix   the\nlogin  ",
  lastUsed: new Date(0),
} as AgentSession;
const canon = "cl-claude-abcdef123456";
const window = { name: canon, target: canon };

describe("the paused tab", () => {
  test("is the canonical resume tab buildTabs would persist, its title on one line", () => {
    const tab = pausedTab(session);
    expect(tab.name).toBe(canon);
    expect(tab.cwd).toBe(tmpdir());
    expect(tab.title).toBe("Fix the login");
    expect(tab.argv.join(" ")).toContain(session.id);
  });

  test("an untitled session's tab is titled by its name", () => {
    expect(pausedTab({ ...session, title: " " }).title).toBe(canon);
  });
});

describe("unpausableReason", () => {
  test("a launcher tab of an indexed session whose directory exists can be paused", () => {
    expect(unpausableReason(session, "abcdef123456", canon, window, "agendo:3")).toBeNull();
  });

  test("each missing precondition is an error naming close as the way out", () => {
    const pane = unpausableReason(session, "ab", "cl-glob", { name: "cl-glob", target: "%7" }, null);
    expect(pane?.code).toBe(1);
    expect(pane?.message).toBe(
      "Not pausing ab (cl-glob): it runs in a pane of another window, so there is no tab of its own to leave paused — close it instead.",
    );
    expect(unpausableReason(session, "ab", canon, window, null)?.reason).toContain("tmux session of its own");
    expect(unpausableReason(undefined, "ab", canon, window, "agendo:3")?.reason).toContain("no transcript yet");
    const gone = { ...session, cwd: "/nonexistent/agendo-pause-test" };
    expect(unpausableReason(gone, "ab", canon, window, "agendo:3")?.reason).toBe(
      "its working directory is gone (/nonexistent/agendo-pause-test), so a paused tab could never resume there",
    );
  });
});

describe("loneTabRefusal", () => {
  // The lone-window refusal itself reads tmux, so the e2e suite pins it against
  // the fake; what is decided without a read is that there is nothing to count.
  test("a target with no host session is not counted at all", () => {
    expect(loneTabRefusal("ab", canon, null)).toBeNull();
  });
});
