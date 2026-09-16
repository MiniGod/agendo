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
  // good (a crash before the log flushed, or — the real-world case — a
  // fabricated or corrupted snapshot entry that never matched a resumable
  // session) used to be kept in the snapshot forever. Nothing else ever drops
  // it: killing its placeholder window only kills the tmux window, not the
  // snapshot entry (see placeholderArgv), and a window nothing can attribute
  // never surfaces as a row the user could `agendo close`. So on every fresh
  // host-session creation, `restoreTabs` read the same immortal entry and
  // respawned the same placeholder window in REAL tmux — indefinitely, no
  // matter how many times the window itself was closed.
  test("is forgotten once the grace period elapses, so restore stops respawning it", () => {
    const firstSeen = 1_000_000;
    const stamped: RestoreTab = { ...ORPHAN, unattributedSince: firstSeen };
    const tabs = buildTabs([WINDOW], [], [stamped], firstSeen + 5 * 60 * 1000);
    expect(tabs).toEqual([]);
  });

  test("once forgotten, the still-open window does not get re-stamped from scratch", () => {
    // buildTabs only ever PRESERVES an entry that was already in `existing`; it
    // never invents one from a live window alone. So once a tab is forgotten
    // (dropped from the snapshot), the same still-open orphan window does not
    // start a fresh grace period on the next pass — restore only respawns what's
    // still in the snapshot, and the whole point of forgetting is that nothing
    // brings the tab back on its own.
    const firstSeen = 1_000_000;
    const stamped: RestoreTab = { ...ORPHAN, unattributedSince: firstSeen };
    const forgotten = buildTabs([WINDOW], [], [stamped], firstSeen + 5 * 60 * 1000);
    expect(forgotten).toEqual([]);
    const again = buildTabs([WINDOW], [], forgotten, firstSeen + 5 * 60 * 1000 + 1);
    expect(again).toEqual([]);
  });

  // A hand-edited or otherwise corrupted snapshot could carry a malformed
  // `unattributedSince` (loadRestore's well-formedness filter only checks
  // name/cwd/argv, see store.ts) — a non-number must not defeat the grace
  // period by making the elapsed-time check permanently false.
  test("a non-numeric stamp (a corrupted snapshot) is treated as freshly unattributed, not as immortal", () => {
    const corrupted = { ...ORPHAN, unattributedSince: "not-a-number" } as unknown as RestoreTab;
    const t0 = 1_000_000;
    const tabs = buildTabs([WINDOW], [], [corrupted], t0);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.unattributedSince).toBe(t0);
    // And it still expires normally from that fresh stamp.
    expect(buildTabs([WINDOW], [], tabs, t0 + 5 * 60 * 1000)).toEqual([]);
  });

  // A stamp from the future (a clock moved back, a snapshot copied from another
  // machine) must not buy the tab indefinite preservation — it restarts the
  // clock from `now` instead of trusting a delta that would never reach the
  // grace threshold.
  test("a stamp from the future is not trusted, so the tab still eventually expires", () => {
    const t0 = 1_000_000;
    const futureStamped: RestoreTab = { ...ORPHAN, unattributedSince: t0 + 60 * 60 * 1000 };
    const tabs = buildTabs([WINDOW], [], [futureStamped], t0);
    expect(tabs[0]!.unattributedSince).toBe(t0);
    expect(buildTabs([WINDOW], [], tabs, t0 + 5 * 60 * 1000)).toEqual([]);
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
