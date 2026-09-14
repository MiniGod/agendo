// buildTabs (src/runtime/restore/index.ts): which live launcher windows survive
// into the next restore snapshot. The e2e suite never runs long enough to prove
// the unattributed-tab grace period expires, and driving it would mean waiting
// out real minutes — exactly what `now` is a parameter for.
import { describe, expect, test } from "bun:test";
import { buildTabs } from "../src/runtime/restore/index.ts";
import type { RestoreTab } from "../src/runtime/restore/store.ts";

const ORPHAN: RestoreTab = {
  name: "cl-claude-orphan1",
  cwd: "/home/dev",
  title: "orphan",
  argv: ["claude", "--resume", "orphan1"],
};
const WINDOW = { name: ORPHAN.name, cwd: ORPHAN.cwd };

describe("buildTabs: a window that never attributes to an on-disk session", () => {
  test("is preserved right after it first goes unattributed", () => {
    const t0 = 1_000_000;
    const tabs = buildTabs([WINDOW], [], [ORPHAN], t0);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ name: ORPHAN.name, unattributedSince: t0 });
  });

  test("is still preserved shortly before the grace period elapses", () => {
    const firstSeen = 1_000_000;
    const stamped: RestoreTab = { ...ORPHAN, unattributedSince: firstSeen };
    const tabs = buildTabs([WINDOW], [], [stamped], firstSeen + 5 * 60 * 1000 - 1);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.unattributedSince).toBe(firstSeen);
  });

  // The regression this file exists for: a tab whose session record is gone for
  // good (a crash before the log flushed, a pruned worktree, or — the real-world
  // case — a hand-built id that was never a resumable session) used to be kept
  // in the snapshot forever. Nothing else ever drops it: killing its placeholder
  // window only kills the tmux window, not the snapshot entry (see
  // placeholderArgv), and a window nothing can attribute never surfaces as a row
  // the user could `agendo close`. So on every fresh host-session creation,
  // `restoreTabs` read the same immortal entry and respawned the same
  // placeholder window in REAL tmux — indefinitely, no matter how many times the
  // window itself was closed.
  test("is forgotten once the grace period elapses, so restore stops respawning it", () => {
    const firstSeen = 1_000_000;
    const stamped: RestoreTab = { ...ORPHAN, unattributedSince: firstSeen };
    const tabs = buildTabs([WINDOW], [], [stamped], firstSeen + 5 * 60 * 1000);
    expect(tabs).toEqual([]);
  });

  test("once forgotten, it does not come back just because the window is still there", () => {
    const firstSeen = 1_000_000;
    const stamped: RestoreTab = { ...ORPHAN, unattributedSince: firstSeen };
    const forgotten = buildTabs([WINDOW], [], [stamped], firstSeen + 10 * 60 * 1000);
    const again = buildTabs([WINDOW], [], forgotten, firstSeen + 20 * 60 * 1000);
    expect(again).toEqual([]);
  });
});

describe("buildTabs: a window that DOES attribute to a session", () => {
  test("is never subject to the grace period, however long it has been unattributed", () => {
    const firstSeen = 1_000_000;
    const stamped: RestoreTab = { ...ORPHAN, unattributedSince: firstSeen };
    const session = { id: "orphan1", source: "claude" as const, cwd: ORPHAN.cwd, title: "back", lastUsed: new Date() };
    const tabs = buildTabs([WINDOW], [session], [stamped], firstSeen + 60 * 60 * 1000);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.unattributedSince).toBeUndefined();
  });
});
