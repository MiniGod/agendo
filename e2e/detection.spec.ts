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
import { managedKind, sessionName, shortId, paneReadiness, paneResumeSafe, paneUsageLimited, resumeKeystrokes } from "../src/tmux.ts";
import { parseResetTime, shouldAutoResume, RESET_GRACE_MS, RESET_LOOKBACK_MS } from "../src/usageLimit.ts";
import { freshName, prFreshName } from "../src/launch.ts";
import { resolveContext, isUnderRoot, tmuxSafeName, normalizeCwd } from "../src/context.ts";
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

// Regression guard for the "session-detection regresses often" area: a launcher
// context whose basename contains a DOT (`kappflug.is-2`). The host session name
// is slugified (`.`→`-`), but attribution must key on the pane cwd / session id —
// never a lossy slug — and must survive path-representation drift between tmux's
// `pane_current_path` and the session's recorded cwd.
test.describe("dotted-basename contexts detect running sessions", () => {
  const DOT_REPO = "/home/me/git/kappflug.is-2";
  const DOT_WT = "/home/me/git/kappflug.is-2/.claude/worktrees/add-keppni-7";

  test("normalizeCwd collapses representation drift but preserves dots", () => {
    // Dots in a basename are meaningful path chars — never touched.
    expect(normalizeCwd(DOT_REPO)).toBe(DOT_REPO);
    // Trailing slash, doubled slashes, and `.`/`..` segments all canonicalize.
    expect(normalizeCwd(DOT_REPO + "/")).toBe(DOT_REPO);
    expect(normalizeCwd("/home/me/git//kappflug.is-2")).toBe(DOT_REPO);
    expect(normalizeCwd("/home/me/git/kappflug.is-2/x/..")).toBe(DOT_REPO);
    expect(normalizeCwd("/")).toBe("/");
  });

  test("a session in a dotted-basename context is in scope (segment-aware)", () => {
    expect(isUnderRoot(DOT_REPO, DOT_REPO)).toBe(true); // the root itself
    expect(isUnderRoot(DOT_WT, DOT_REPO)).toBe(true); // a worktree under it
    expect(isUnderRoot(DOT_WT + "/", DOT_REPO)).toBe(true); // + trailing-slash drift
    // Not fooled by a look-alike sibling that merely shares the dotted prefix.
    expect(isUnderRoot("/home/me/git/kappflug.is-2-backup/x", DOT_REPO)).toBe(false);
  });

  test("an id-less cl-wi window at a dotted worktree attributes to its session", () => {
    // The exact repro shape: session on disk in a dotted worktree, running under a
    // work-item window (cwd-attributed, the fragile path). It must be detected.
    const s = sess("keppni7id", DOT_WT, 5_000);
    const canon = sessionName(s); // cl-claude-keppni7id
    const managed: Managed[] = [{ name: "cl-wi-42", cwd: DOT_WT, placeholder: false }];
    const r = reconcileLive(new Set(["cl-wi-42"]), managed, [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveKinds.get(canon)).toBe("workitem");
    expect(r.liveWindows.get(canon)).toBe("cl-wi-42");
  });

  test("attribution survives cwd representation drift (trailing slash / dot segments)", () => {
    // tmux reports the pane cwd with a trailing slash; the session recorded it
    // clean. A raw `===` would miss this and show the session cold — normalizeCwd
    // makes them compare equal.
    const s = sess("driftid", DOT_WT, 5_000);
    const canon = sessionName(s);
    const managed: Managed[] = [{ name: "cl-pr-9", cwd: DOT_WT + "/", placeholder: false }];
    const r = reconcileLive(new Set(["cl-pr-9"]), managed, [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveWindows.get(canon)).toBe("cl-pr-9");
  });

  test("resolveContext derives a slugified host session for a dotted path", () => {
    // The host name loses the dot (tmux-safe), but that must not feed attribution.
    expect(resolveContext(DOT_REPO, "/anywhere")).toEqual({
      filterRoot: DOT_REPO,
      hostSession: "agendo-kappflug-is-2",
    });
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
// compacting pane fell through every check and read as "ready" — letting `agendo
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

// A FINISHED turn leaves a result summary — `✔ Goal achieved (1m · 1 turn · 4.6k
// tokens)` — that wears the SAME `(<time> · … tokens)` shape as the live spinner
// counter, differing only by the directional ↑/↓ arrow (present live, absent in
// the summary) and the ✔/✗ + "N turn(s)" wording. The busy check used to match
// that shape unconditionally, so an idle pane sitting at an empty prompt read as
// "busy" — blocking `agendo send` and showing the wrong state. The fix requires
// the arrow. This area regresses often; these pin the distinction verbatim.
test.describe("paneReadiness: finished-turn summary is idle, not a live counter", () => {
  const rule = "  ─────────────────────────────────────────";
  // Real capture (window cl-claude-3df67d819fd1): done, sitting at an empty box.
  const doneSummary = [
    "  ✔ Goal achieved (1m · 1 turn · 4.6k tokens)",
    "  ✻ Baked for 2m 38s",
    rule,
    "  ❯ ",
    rule,
    "  ⏵⏵ auto mode on (shift+tab to cycle)",
  ].join("\n");

  test("a done-summary pane at an empty prompt reads 'ready' (was the bug: 'busy')", () => {
    expect(paneReadiness(doneSummary)).toBe("ready");
  });

  test("a genuinely generating pane (live ↑/↓ counter) still reads 'busy'", () => {
    // Real active spinner: the ↓ arrow on the token counter is the live signal.
    const busy = [
      "  ✢ Tinkering… (58s · ↓ 3.9k tokens)",
      rule,
      "  ❯ ",
      rule,
      "  esc to interrupt",
    ].join("\n");
    expect(paneReadiness(busy)).toBe("busy");
  });

  test("a live counter with no 'esc to interrupt' hint is still 'busy' (arrow alone)", () => {
    const busy = ["  ✽ Baking… (2s · ↑ 1.2k tokens)", rule, "  ❯ ", rule].join("\n");
    expect(paneReadiness(busy)).toBe("busy");
  });

  test("a done-summary pane with unsent text queued reads 'queued', not 'busy'", () => {
    const queued = [
      "  ✔ Goal achieved (1m · 1 turn · 4.6k tokens)",
      rule,
      "  ❯ a follow-up question",
      rule,
    ].join("\n");
    expect(paneReadiness(queued)).toBe("queued");
  });

  test("an open dialog still reads 'dialog' even next to a done summary", () => {
    const dialog = [
      "  ✔ Goal achieved (1m · 1 turn · 4.6k tokens)",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. No",
      rule,
      "  ❯ ",
      rule,
    ].join("\n");
    expect(paneReadiness(dialog)).toBe("dialog");
  });
});

// The "limited" verdict marks a session sitting at its usage/token cap (the
// 5-hour rolling window or the weekly limit). Claude Code stops mid-flight and
// prints a notice with (usually) a reset time; without this state such a pane —
// an idle input box under a notice — would read "ready" and invite a doomed
// send/auto-resume. The exact wording matched here is verbatim from a throttled
// pane; see src/usageLimit.ts.
// VERBATIM capture from a REAL throttled Claude Code session (read-only capture
// of tmux window cl-claude-b5652803ec7e / agendo:8). Reproduced exactly, control
// chars spelled out: ⎿ = U+23BF (tool-result glyph),   = NBSP padding,
// · = the `·` separator, ’ = the curly apostrophe in "you're". Line 1
// uses a straight apostrophe in "You've", as captured. This is the fixture the
// detector MUST fire on — agendo previously read this pane as "ready".
const REAL_LIMIT_PANE = [
  "  ⎿  You've hit your session limit · resets 7:20pm (Atlantic/Reykjavik)",
  "     /usage-credits to finish what you’re working on.",
].join("\n");

// NEGATIVE fixture: the SAME session after it RECOVERED — verbatim head + tail
// from cl-claude-b5652803ec7e (the long resumed-turn table in the middle elided;
// it doesn't affect detection). The limit line sits far up in scrollback; the
// user's typed "❯ continue" and a full completed turn come AFTER it, and the pane
// now rests at an empty input box. Detection must read this as ready, NOT limited
// — the notice is stale history, not the active state.
const RECOVERED_PANE = [
  "✻ Worked for 4m 54s",
  "",
  '● Background command "Timer before polling e2e retry result" completed (exit code 0)',
  "  ⎿  You've hit your session limit · resets 7:20pm (Atlantic/Reykjavik)",
  "     /usage-credits to finish what you’re working on.",
  "",
  "✻ Cogitated for 0s",
  "",
  "❯ continue",
  "",
  "● Checking the e2e retry result on build 546343.",
  "",
  "● Build 546343 (iteration 6) now: SUCCEEDED ✅ — CI fully green.",
  "",
  "✻ Worked for 25s",
  "",
  "─────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────",
  "  20:11:25 | 30% ctx | Opus 4.8 | fix/236653-smart-button-emulated-click [$] | ~/repos/mc-applications",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
].join("\n");

// POSITIVE fixture: a session BLOCKED right now — the limit notice is the last
// content, immediately above the (empty) input box, with nothing after it.
const BLOCKED_PANE = [
  "● Continuing the build investigation.",
  "",
  "● Background command completed (exit code 0)",
  "  ⎿  You've hit your session limit · resets 7:20pm (Atlantic/Reykjavik)",
  "     /usage-credits to finish what you’re working on.",
  "─────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────",
  "  20:15:02 | 30% ctx | Opus 4.8 | fix/236653 [$] | ~/repos/mc-applications",
].join("\n");

test.describe("paneReadiness: usage-limit detection (5-hour + weekly)", () => {
  const idleBox = ["  ─────────────────────────────────────────", "  ❯ ", "  ─────────────────────────────────────────"].join("\n");

  test("REGRESSION: the REAL captured session-limit pane reads 'limited', not 'ready'", () => {
    // The credit/session cap wording ("hit your session limit" + "/usage-credits")
    // inside a ⎿ result block, with NBSP padding — the exact text agendo missed.
    expect(paneReadiness(REAL_LIMIT_PANE)).toBe("limited");
    // Even followed by a normal idle input box (as on a live limited pane).
    expect(paneReadiness([REAL_LIMIT_PANE, idleBox].join("\n"))).toBe("limited");
  });

  test("REGRESSION (negative): a RECOVERED session with the notice only in scrollback reads 'ready'", () => {
    // The message persists in history after the user types "continue"; a later
    // completed turn sits between it and the idle box. Must NOT read as limited.
    expect(paneReadiness(RECOVERED_PANE)).toBe("ready");
    expect(paneUsageLimited(RECOVERED_PANE)).toBe(false);
    expect(paneResumeSafe(RECOVERED_PANE)).toBe(false); // never nudge a recovered session
  });

  test("REGRESSION (positive): a currently-BLOCKED pane (notice is the last content) reads 'limited'", () => {
    // Same tokens as the recovered pane, but the notice is the active bottom-most
    // block right above the input box, with nothing after it.
    expect(paneReadiness(BLOCKED_PANE)).toBe("limited");
    expect(paneUsageLimited(BLOCKED_PANE)).toBe(true);
    expect(paneResumeSafe(BLOCKED_PANE)).toBe(true); // safe to auto-resume once reset passes
  });

  test("the canonical 5-hour notice reads 'limited', not 'ready'", () => {
    const pane = ["  Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).", idleBox].join("\n");
    expect(paneReadiness(pane)).toBe("limited");
  });

  test("the weekly-limit notice also reads 'limited'", () => {
    const pane = ["  You've reached your weekly limit.", "  Resets by 4:00 AM Friday Apr 24", idleBox].join("\n");
    expect(paneReadiness(pane)).toBe("limited");
  });

  test("a still-generating pane wins over stale limit text in scrollback", () => {
    // busy is checked before limited: a recovered session that's working again
    // may still carry the old notice above a live token counter — "working now".
    const pane = [
      "  Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).",
      "  ✢ Tinkering… (58s · ↓ 3.9k tokens)",
      idleBox,
    ].join("\n");
    expect(paneReadiness(pane)).toBe("busy");
  });

  test("ordinary prose mentioning a limit does not trip detection", () => {
    const pane = ["  I reached the end of the array, up to its length limit.", idleBox].join("\n");
    expect(paneReadiness(pane)).toBe("ready");
  });

  test("prose about some OTHER service's rate limit does not trip detection", () => {
    // Regression: the pre-hardening regex matched "reached your … limit" broadly,
    // so a session quoting an API error would misclassify as limited.
    const pane = ["  Note: you have reached your rate limit for the OpenAI API.", idleBox].join("\n");
    expect(paneReadiness(pane)).toBe("ready");
  });
});

test.describe("parseResetTime: extract the reset instant from the notice", () => {
  test("time + IANA timezone → that wall-clock time in the named zone", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const at = parseResetTime("Your limit will reset at 3pm (America/Santiago).", now);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(now.getTime());
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at!))
      .find((p) => p.type === "hour")!.value;
    expect(hour).toBe("15");
  });

  test("weekly 'Resets by 4:00 AM Friday Apr 24' → that explicit local date/time", () => {
    const now = new Date(2026, 3, 20, 9, 0); // Apr 20 2026, local
    const at = parseResetTime("Resets by 4:00 AM Friday Apr 24", now);
    expect(at).not.toBeNull();
    const d = new Date(at!);
    expect(d.getMonth()).toBe(3); // April
    expect(d.getDate()).toBe(24);
    expect(d.getHours()).toBe(4);
    expect(d.getMinutes()).toBe(0);
  });

  test("bare time-of-day → today if still ahead", () => {
    const now = new Date(2026, 5, 15, 14, 0); // 2pm local
    const at = parseResetTime("Your limit will reset at 3pm.", now);
    const d = new Date(at!);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(15);
  });

  test("bare time-of-day → tomorrow once it has already passed today", () => {
    const now = new Date(2026, 5, 15, 16, 0); // 4pm local, past 3pm
    const at = parseResetTime("Your limit will reset at 3pm.", now);
    const d = new Date(at!);
    expect(d.getDate()).toBe(16);
    expect(d.getHours()).toBe(15);
  });

  test("weekday without an explicit date → the next occurrence of that weekday", () => {
    const now = new Date(2026, 5, 15, 8, 0); // Mon Jun 15 2026, 8am local
    const at = parseResetTime("Your limit will reset at 9am Wednesday", now);
    const d = new Date(at!);
    expect(d.getDay()).toBe(3); // Wednesday
    expect(d.getHours()).toBe(9);
    expect(at!).toBeGreaterThan(now.getTime());
  });

  test("REGRESSION: the REAL captured pane's 'resets 7:20pm (Atlantic/Reykjavik)' parses", () => {
    const now = new Date("2026-07-06T12:00:00Z");
    const at = parseResetTime(REAL_LIMIT_PANE, now);
    expect(at).not.toBeNull();
    expect(at!).toBeGreaterThan(now.getTime());
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Atlantic/Reykjavik", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(at!));
    const hm = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
    expect(hm).toBe("19:20"); // 7:20pm in Reykjavik (UTC+0 year-round)
  });

  test("no parseable reset time → null (still limited, just not auto-resumable)", () => {
    expect(parseResetTime("Claude usage limit reached.", new Date())).toBeNull();
    expect(parseResetTime("Your limit will reset soon.", new Date())).toBeNull();
  });

  test("a stray 'reset' in scrollback does not hijack the reset time", () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const pane = [
      "$ git reset --hard origin/master at 10:00",
      "Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).",
    ].join("\n");
    const at = parseResetTime(pane, now);
    expect(at).not.toBeNull();
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at!))
      .find((p) => p.type === "hour")!.value;
    expect(hour).toBe("15"); // the notice's 3pm, not the git line's 10:00
  });

  test("a weekday token inside the timezone name is not read as a weekday", () => {
    // "(America/Monterrey)" contains "Mon" — must NOT become "next Monday".
    const now = new Date(2026, 5, 15, 14, 0); // Mon Jun 15 2026, 2pm local
    const at = parseResetTime("Your limit will reset at 3pm (America/Monterrey).", now);
    const d = new Date(at!);
    expect(d.getDate()).toBe(15); // today, not pushed to a later Monday
  });

  test("a malformed dotted time is rejected rather than mis-parsed", () => {
    // "4.30pm": the hour is bounded 1-12 so a stray "30pm" can't match → null.
    expect(parseResetTime("Your limit will reset at 4.30pm.", new Date())).toBeNull();
  });

  test("12am/12pm hour math", () => {
    const now = new Date(2026, 5, 15, 6, 0);
    expect(new Date(parseResetTime("resets at 12pm", now)!).getHours()).toBe(12);
    const nowLate = new Date(2026, 5, 15, 13, 0);
    expect(new Date(parseResetTime("resets at 12am", nowLate)!).getHours()).toBe(0);
  });

  test("lookback: a just-passed reset resolves to the past instant, not tomorrow", () => {
    const now = new Date(2026, 5, 15, 15, 30); // 3:30pm, notice said 3pm
    const rolled = parseResetTime("Your limit will reset at 3pm.", now); // default: next occurrence
    expect(new Date(rolled!).getDate()).toBe(16); // tomorrow
    const current = parseResetTime("Your limit will reset at 3pm.", now, RESET_LOOKBACK_MS);
    expect(new Date(current!).getDate()).toBe(15); // today (already reopened → act now)
    expect(current!).toBeLessThan(now.getTime());
  });
});

// The auto-resume send must not clobber a session that has queued a draft or has
// an open dialog, even though such a pane still classifies as "limited" (the
// limit check outranks queued/dialog in paneReadiness). paneResumeSafe is the
// stricter gate used right before sending the keystrokes.
test.describe("paneResumeSafe: only fire into an empty, dialog-free limited pane", () => {
  const notice = "  Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).";
  const rule = "  ─────────────────────────────────────────────";

  test("limited with an empty input box → safe", () => {
    expect(paneResumeSafe([notice, rule, "  ❯ ", rule].join("\n"))).toBe(true);
  });

  test("limited but the user queued a draft → not safe (would be clobbered)", () => {
    expect(paneResumeSafe([notice, rule, "  ❯ ask me later", rule].join("\n"))).toBe(false);
  });

  test("limited but a dialog is open → not safe (Escape would dismiss it)", () => {
    const pane = [notice, "  ❯ 1. Yes", "  Enter to confirm · Esc to cancel"].join("\n");
    expect(paneResumeSafe(pane)).toBe(false);
  });

  test("not limited → never safe", () => {
    expect(paneResumeSafe(["  ● all good", rule, "  ❯ ", rule].join("\n"))).toBe(false);
  });
});

// The auto-resume decision must never clobber a recovered session, must wait for
// the reset (plus a grace buffer), and must fire at most once per limit window.
test.describe("shouldAutoResume: timing + clobber + duplicate-fire safety", () => {
  const reset = new Date("2026-06-15T15:00:00Z").getTime();
  const base = { enabled: true, readiness: "limited" as const, resetAt: reset, firedFor: null };

  test("off by default: disabled never fires", () => {
    expect(shouldAutoResume({ ...base, enabled: false, now: reset + RESET_GRACE_MS + 1 })).toBe(false);
  });

  test("does not fire while the reset (plus grace) is still in the future", () => {
    expect(shouldAutoResume({ ...base, now: reset - 1 })).toBe(false);
    expect(shouldAutoResume({ ...base, now: reset + RESET_GRACE_MS - 1 })).toBe(false);
  });

  test("fires once the reset + grace has passed and it hasn't fired yet", () => {
    expect(shouldAutoResume({ ...base, now: reset + RESET_GRACE_MS })).toBe(true);
  });

  test("never fires unless the pane is STILL limited (no clobbering a recovery)", () => {
    for (const r of ["ready", "busy", "queued", "dialog"] as const)
      expect(shouldAutoResume({ ...base, readiness: r, now: reset + RESET_GRACE_MS + 1 })).toBe(false);
  });

  test("no reset time → never fires (we can't know when)", () => {
    expect(shouldAutoResume({ ...base, resetAt: null, now: reset + RESET_GRACE_MS + 1 })).toBe(false);
  });

  test("fire-at-most-once: already fired for this exact reset → skip", () => {
    expect(shouldAutoResume({ ...base, firedFor: reset, now: reset + RESET_GRACE_MS + 1 })).toBe(false);
  });

  test("a NEW limit window (different reset instant) is eligible again", () => {
    const later = reset + 5 * 3600_000;
    expect(shouldAutoResume({ ...base, resetAt: later, firedFor: reset, now: later + RESET_GRACE_MS + 1 })).toBe(true);
  });
});

test.describe("resumeKeystrokes: the continue sequence", () => {
  test("is exactly Escape, literal 'continue', Enter to the target", () => {
    expect(resumeKeystrokes("cl-claude-abc")).toEqual([
      ["send-keys", "-t", "cl-claude-abc", "Escape"],
      ["send-keys", "-t", "cl-claude-abc", "-l", "continue"],
      ["send-keys", "-t", "cl-claude-abc", "Enter"],
    ]);
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

// Path-scoped launchers: a `[path]` argument resolves to (filterRoot, hostSession)
// and the segment-aware prefix match decides which sessions a scoped launcher
// shows. These are the pure core the TUI filter and `agendo list <dir>` share.
test.describe("resolveContext: path → (filterRoot, hostSession)", () => {
  test("no path is the global launcher (null root, default session)", () => {
    expect(resolveContext(undefined, "/home/me")).toEqual({ filterRoot: null, hostSession: "agendo" });
    expect(resolveContext("", "/home/me")).toEqual({ filterRoot: null, hostSession: "agendo" });
  });

  test("a relative path resolves against cwd; host session is agendo-<basename>", () => {
    expect(resolveContext(".", "/home/me/repos/appweb")).toEqual({
      filterRoot: "/home/me/repos/appweb",
      hostSession: "agendo-appweb",
    });
    expect(resolveContext("work", "/home/me")).toEqual({
      filterRoot: "/home/me/work",
      hostSession: "agendo-work",
    });
  });

  test("an absolute path is used as-is", () => {
    expect(resolveContext("/home/me/work", "/anywhere")).toEqual({
      filterRoot: "/home/me/work",
      hostSession: "agendo-work",
    });
  });

  test("-s overrides the derived host session name verbatim (basename collisions)", () => {
    // The override is honored as-is (no `agendo-` prefix) — it's the explicit
    // escape hatch for naming a launcher, e.g. disambiguating basename clashes.
    expect(resolveContext("/a/proj", "/x", "left")).toEqual({ filterRoot: "/a/proj", hostSession: "left" });
    // A bare -s with no path names a global launcher.
    expect(resolveContext(undefined, "/x", "scratch")).toEqual({ filterRoot: null, hostSession: "scratch" });
  });

  test("basename is prefixed and sanitized to a tmux-safe session name", () => {
    // tmux forbids `.`/`:` in session names — collapsed to `-`, then prefixed.
    expect(resolveContext("/repos/my.app", "/x").hostSession).toBe("agendo-my-app");
    // A path whose basename sanitizes to nothing falls back to the bare default.
    expect(resolveContext("/", "/x").hostSession).toBe("agendo");
  });
});

test.describe("tmuxSafeName", () => {
  test("collapses forbidden chars and trims dashes", () => {
    expect(tmuxSafeName("my.repo")).toBe("my-repo");
    expect(tmuxSafeName("a:b c")).toBe("a-b-c");
    expect(tmuxSafeName("...")).toBe("");
    expect(tmuxSafeName("plain")).toBe("plain");
  });
});

test.describe("isUnderRoot: segment-aware prefix match", () => {
  test("a path is under itself and under an ancestor", () => {
    expect(isUnderRoot("/home/me/work", "/home/me/work")).toBe(true);
    expect(isUnderRoot("/home/me/work/repo/.claude/worktrees/x", "/home/me/work")).toBe(true);
    expect(isUnderRoot("/home/me/work/repo", "/home/me")).toBe(true);
  });

  test("a sibling with a shared prefix does NOT match (the ~/work vs ~/workshop guard)", () => {
    expect(isUnderRoot("/home/me/workshop", "/home/me/work")).toBe(false);
    expect(isUnderRoot("/home/me/work-notes", "/home/me/work")).toBe(false);
  });

  test("an ancestor is not under its descendant", () => {
    expect(isUnderRoot("/home/me", "/home/me/work")).toBe(false);
  });

  test("root '/' contains every absolute path; trailing slashes are normalized", () => {
    expect(isUnderRoot("/anything/here", "/")).toBe(true);
    expect(isUnderRoot("/home/me/work/", "/home/me/work")).toBe(true);
    expect(isUnderRoot("/home/me/work", "/home/me/work/")).toBe(true);
  });
});
