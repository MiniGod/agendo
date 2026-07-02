// Unit coverage for the live-session *detection / attribution* core — the logic
// that decides which on-disk session a live tmux window belongs to, whether it's
// running vs a dormant restore placeholder, and how it was launched. These are
// the mechanisms that regress most often, so they're pinned here as pure,
// deterministic tests that need no browser, PTY, or live tmux (the functions were
// deliberately extracted from the tmux CLI reads for exactly this).
//
// Focus: LEGACY window-name attribution. Id-less managed windows
// (`cl-wi-…`/`cl-pr-…`/`cl-free-…`) carry a work-item / PR / slug id, NOT a
// session id, so they attribute to the most-recently-used session in the same
// working directory — and the resulting `liveWindows` map is what lets the app
// attach to that existing window instead of spawning a duplicate.
import { test, expect } from "@playwright/test";
import { reconcileLive } from "../src/model.ts";
import { resolveWindowSession, bestSessionForCwd } from "../src/restore.ts";
import { managedKind, sessionName, shortId, paneReadiness } from "../src/tmux.ts";
import { freshName, prFreshName } from "../src/launch.ts";
import type { AgentSession } from "../src/types.ts";

// Minimal session factory — only the fields the attribution logic reads.
function sess(id: string, cwd: string, lastUsedMs: number, source: AgentSession["source"] = "claude"): AgentSession {
  return { id, source, cwd, title: id, lastUsed: new Date(lastUsedMs) };
}
type Managed = { name: string; cwd: string; placeholder: boolean };

test.describe("managedKind: name-prefix → launch kind", () => {
  test("classifies every known prefix and rejects unknown ones", () => {
    expect(managedKind("cl-bg-abc")).toBe("background");
    expect(managedKind("cl-new-abc")).toBe("new");
    expect(managedKind("cl-free-abc")).toBe("new"); // legacy manual prefix
    expect(managedKind("cl-wi-101")).toBe("workitem");
    expect(managedKind("cl-pr-5001")).toBe("pr");
    expect(managedKind("cl-claude-abc")).toBe("resumed");
    expect(managedKind("cl-copilot-abc")).toBe("resumed");
    expect(managedKind("cl-bogus-abc")).toBeNull();
    expect(managedKind("not-managed")).toBeNull();
  });
});

test.describe("resolveWindowSession: window name → session", () => {
  const older = sess("aaaolder", "/repo", 1_000);
  const newer = sess("bbbnewer", "/repo", 9_000); // most-recently-used in /repo
  const elsewhere = sess("ccc", "/other", 5_000);
  const all = [older, newer, elsewhere];

  test("id-bearing names match the EXACT session by short id (not cwd MRU)", () => {
    // Both live in /repo; the id in the name must win over the cwd heuristic.
    expect(resolveWindowSession(all, "cl-claude-aaaolder", "/repo")).toBe(older);
    expect(resolveWindowSession(all, "cl-claude-bbbnewer", "/repo")).toBe(newer);
  });

  test("id-bearing name with no matching session resolves to nothing", () => {
    expect(resolveWindowSession(all, "cl-claude-zzz", "/repo")).toBeUndefined();
  });

  test("legacy names (cl-wi-/cl-pr-/cl-free-) attribute to the MRU session in the cwd", () => {
    expect(resolveWindowSession(all, "cl-wi-101", "/repo")).toBe(newer);
    expect(resolveWindowSession(all, "cl-pr-5001", "/repo")).toBe(newer);
    expect(resolveWindowSession(all, "cl-free-scratch", "/repo")).toBe(newer);
  });

  test("legacy name in a cwd with no session resolves to nothing", () => {
    expect(resolveWindowSession(all, "cl-wi-101", "/nowhere")).toBeUndefined();
  });
});

test.describe("bestSessionForCwd", () => {
  test("picks the most-recently-used session in the cwd, ignoring others", () => {
    const a = sess("a", "/repo", 1_000);
    const b = sess("b", "/repo", 8_000);
    const c = sess("c", "/elsewhere", 9_999);
    expect(bestSessionForCwd([a, b, c], "/repo")).toBe(b);
    expect(bestSessionForCwd([a, b, c], "/elsewhere")).toBe(c);
    expect(bestSessionForCwd([a, b, c], "/missing")).toBeUndefined();
  });
});

test.describe("reconcileLive: fold managed windows into running state", () => {
  test("id-bearing window marks its exact session running", () => {
    const s = sess("abc123def", "/x", 1_000);
    const canon = sessionName(s); // cl-claude-abc123def
    const r = reconcileLive(new Set(), [{ name: canon, cwd: "/x", placeholder: false }], [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveKinds.get(canon)).toBe("resumed");
    expect(r.liveWindows.get(canon)).toBe(canon);
    expect(r.livePlaceholders.size).toBe(0);
  });

  test("legacy cl-wi- window attributes to the MRU session and records the window", () => {
    const older = sess("old", "/repo", 1_000);
    const newer = sess("new", "/repo", 5_000);
    const managed: Managed[] = [{ name: "cl-wi-101", cwd: "/repo", placeholder: false }];
    const r = reconcileLive(new Set(["cl-wi-101"]), managed, [older, newer]);

    const canon = sessionName(newer);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveKinds.get(canon)).toBe("workitem");
    // The recorded window is the LEGACY name — this is what the app attaches to,
    // so it never spawns a duplicate cl-claude-<id> window for the session.
    expect(r.liveWindows.get(canon)).toBe("cl-wi-101");
    // Only the MRU session is attributed; the older one in the same cwd is not.
    expect(r.live.has(sessionName(older))).toBe(false);
  });

  test("a dormant placeholder is dropped from live and reported as a placeholder", () => {
    const s = sess("xyz", "/x", 1_000);
    const canon = sessionName(s);
    // `base` counted the placeholder window as live (it carries the canonical name).
    const r = reconcileLive(new Set([canon]), [{ name: canon, cwd: "/x", placeholder: true }], [s]);
    expect(r.live.has(canon)).toBe(false); // not actually running
    expect(r.livePlaceholders.has(canon)).toBe(true); // badged restored-but-unopened
    expect(r.liveKinds.has(canon)).toBe(false);
  });

  test("a real window vouching for the same session keeps a same-named placeholder live (order-independent)", () => {
    // Regression guard: a placeholder `cl-claude-xyz` and a real `cl-wi-9` (whose
    // cwd attributes back to session xyz) share the canonical name. The two-pass
    // reconcile must keep the session running regardless of pane iteration order.
    const s = sess("xyz", "/repo", 1_000);
    const canon = sessionName(s);
    const managed: Managed[] = [
      { name: canon, cwd: "/repo", placeholder: true }, // placeholder first
      { name: "cl-wi-9", cwd: "/repo", placeholder: false }, // real window, same session by cwd
    ];
    const r = reconcileLive(new Set([canon, "cl-wi-9"]), managed, [s]);
    expect(r.live.has(canon)).toBe(true); // real window vouched → running
    expect(r.livePlaceholders.has(canon)).toBe(false); // not a dormant tab
    expect(r.liveWindows.get(canon)).toBe("cl-wi-9"); // attached via the real window
  });

  test("same, with the real window listed BEFORE the placeholder", () => {
    const s = sess("xyz", "/repo", 1_000);
    const canon = sessionName(s);
    const managed: Managed[] = [
      { name: "cl-wi-9", cwd: "/repo", placeholder: false },
      { name: canon, cwd: "/repo", placeholder: true },
    ];
    const r = reconcileLive(new Set([canon, "cl-wi-9"]), managed, [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.livePlaceholders.has(canon)).toBe(false);
  });

  test("windows with an unknown cl- kind are ignored", () => {
    const s = sess("s", "/x", 1_000);
    const r = reconcileLive(new Set(), [{ name: "cl-bogus-1", cwd: "/x", placeholder: false }], [s]);
    expect(r.live.size).toBe(0);
    expect(r.liveWindows.size).toBe(0);
  });

  test("shortId / sessionName stay consistent for id-bearing attribution", () => {
    // The attribution round-trips: a window named for a session's shortId resolves
    // back to that session. Guards the shortId slug rule the names depend on.
    const s = sess("a1b2-c3d4-e5f6-long", "/x", 1_000, "copilot");
    expect(sessionName(s)).toBe(`cl-copilot-${shortId(s.id)}`);
    const r = reconcileLive(new Set(), [{ name: sessionName(s), cwd: "/x", placeholder: false }], [s]);
    expect(r.live.has(sessionName(s))).toBe(true);
  });
});

// The pane classifier decides whether a running session is safe to send a prompt
// to. The "compacting" verdict (0369480) is the regression-prone one: compaction
// leaves an empty input box and shows no token counter, so before it was added a
// compacting pane fell through every check and read as "ready" — letting `clops
// send` inject a prompt mid-compaction. These pin the classification, especially
// the precedence: the compacting check must run before the ready/busy reads.
test.describe("paneReadiness: compacting vs the states it must outrank", () => {
  // The input box the classifier reads: text between the last two `─` rules,
  // anchored on a `❯` prompt. Empty box ⇒ ready.
  const idleBox = ["  ─────────────────────────────────────────", "  ❯ ", "  ─────────────────────────────────────────"].join("\n");

  test("a mid-compaction pane reads 'compacting', not 'ready'", () => {
    // Compaction leaves the input box empty — so without the dedicated check this
    // exact screen would misclassify as ready.
    const pane = ["  ✻ Compacting conversation…", "  ▰▰▰▱▱▱ 42%", idleBox].join("\n");
    expect(paneReadiness(pane)).toBe("compacting");
  });

  test("the compacting check outranks the busy signal too", () => {
    // Even with an "esc to interrupt" hint (normally a busy marker) present, the
    // compacting phrase wins because it's checked first.
    const pane = ["  ✻ Compacting conversation… (esc to interrupt)", idleBox].join("\n");
    expect(paneReadiness(pane)).toBe("compacting");
  });

  test("the match is case-insensitive on the phrase", () => {
    expect(paneReadiness(["COMPACTING CONVERSATION", idleBox].join("\n"))).toBe("compacting");
  });

  test("an idle pane is still 'ready' and a generating pane still 'busy'", () => {
    // Guard against the compacting check being over-eager: normal states are intact.
    expect(paneReadiness(idleBox)).toBe("ready");
    const busy = ["  ✢ Tinkering… (58s · ↓ 3.9k tokens)", idleBox].join("\n");
    expect(paneReadiness(busy)).toBe("busy");
  });
});

// GitHub issue/PR numbers collide across repos, so GitHub launches scope the tmux
// window name with the repo (cc05391); ADO ids are globally unique and pass no
// scope, keeping their names unchanged. tmux forbids `.`/`:`, so the scope is
// slugified to [a-z0-9-]. These names are what attribution later reads back.
test.describe("freshName / prFreshName: repo scoping of managed window names", () => {
  test("no scope (the ADO path) yields the bare, unchanged names", () => {
    expect(freshName(101)).toBe("cl-wi-101");
    expect(prFreshName(5001)).toBe("cl-pr-5001");
    expect(freshName(101, "")).toBe("cl-wi-101"); // empty scope ⇒ no tag
  });

  test("a scope (the GitHub path) is slugified and embedded before the id", () => {
    expect(freshName(101, "owner/repo")).toBe("cl-wi-owner-repo-101");
    expect(prFreshName(5, "My.Repo")).toBe("cl-pr-my-repo-5"); // lowercased, `.`→`-`
    expect(freshName(7, "--Foo!!__")).toBe("cl-wi-foo-7"); // trimmed of leading/trailing dashes
  });

  test("scoped names still classify to the right kind (attribution survives scoping)", () => {
    expect(managedKind(freshName(101, "owner/repo"))).toBe("workitem");
    expect(managedKind(prFreshName(5, "owner/repo"))).toBe("pr");
  });
});
