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
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { reconcileLive, filterModelByRepos, itemInRepoScope, prInRepoScope, type LoadedModel } from "../src/model.ts";
import { discoverGitReposUnder, mergeRepos, repoScopeKeys, type RepoInfo } from "../src/repos.ts";
import { resolveWindowSession, bestSessionForCwd } from "../src/restore.ts";
import { managedKind, sessionName, shortId, paneReadiness, paneResumeSafe, paneUsageLimited, paneLimitDialogActive, resumeKeystrokes, dialogRevealKeystrokes, stripAnsi } from "../src/tmux.ts";
import { parseResetTime, shouldAutoResume, shouldRevealDialog, isLimitDialog, isUsageLimited, RESET_GRACE_MS, RESET_LOOKBACK_MS } from "../src/usageLimit.ts";
import { freshName, prFreshName } from "../src/launch.ts";
import { resolveContext, isUnderRoot, tmuxSafeName, normalizeCwd } from "../src/context.ts";
import type { AgentSession, PullRequest, WorkItem } from "../src/types.ts";

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
    // A REAL active dialog REPLACES the input box: the numbered options + footer
    // are the bottom-most content, with no input-box rule below them.
    const dialog = [
      "  ✔ Goal achieved (1m · 1 turn · 4.6k tokens)",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. No",
      "  Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(paneReadiness(dialog)).toBe("dialog");
  });

  test("T8: numbered options left in SCROLLBACK above an idle box read 'ready', not 'dialog'", () => {
    // Regression: isDialog matched a `❯ 1.` line ANYWHERE, so a finished dialog's
    // options lingering in history misclassified an idle pane as 'dialog' and
    // blocked `agendo send`. The input-box rule BELOW the options now demotes them.
    const idlePastDialog = [
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. No",
      "  ● Proceeding — done.",
      rule,
      "  ❯ ",
      rule,
      "  ? for shortcuts",
    ].join("\n");
    expect(paneReadiness(idlePastDialog)).toBe("ready");
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
  "● Checking the e2e retry result on build 123456.",
  "",
  "● Build 123456 (iteration 6) now: SUCCEEDED ✅ — CI fully green.",
  "",
  "✻ Worked for 25s",
  "",
  "─────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────",
  "  20:11:25 | 30% ctx | Opus 4.8 | fix/1234-example-button-fix [$] | ~/repos/example-app",
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
  "  20:15:02 | 30% ctx | Opus 4.8 | fix/1234 [$] | ~/repos/example-app",
].join("\n");

// PRIMARY POSITIVE fixture: the NUMBERED CHOICE DIALOG — the interactive state a
// limited session actually sits in, captured VERBATIM (read-only) from the live
// limited pane agendo:cl-bg-69a05a1d3a23. The two option lines are the durable
// anchors (LIMIT_DIALOG_RE). Note: this dialog shows NO reset time, and it
// renders `─` table rules ABOVE it (elided-but-representative here) yet has NO
// input box below it — that structural fact (no `─{20,}` rule beneath the dialog)
// is how we know it's the ACTIVE dialog, not stale scrollback. agendo previously
// read this exact screen as non-"limited"; this is the false negative being fixed.
const LIMIT_DIALOG_PANE = [
  "● Done. The bug is created, fully configured, and linked.",
  "",
  "  ┌───────────┬───────────────────────────────────────────────────────┐",
  "  │   Field   │                          Value                          │",
  "  ├───────────┼───────────────────────────────────────────────────────┤",
  "  │ State     │ In Review                                               │",
  "  └───────────┴───────────────────────────────────────────────────────┘",
  "",
  "  Your uncommitted nx-migrate pipeline work remains untouched.",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   What do you want to do?",
  "",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Add funds to continue with usage credits",
  "",
  "   Enter to confirm · Esc to cancel",
].join("\n");

// NEGATIVE fixture: the SAME dialog wording, but DISMISSED and left in scrollback —
// the user pressed Escape/continued, a real turn ran, and the pane now rests at an
// empty input box (a `─{20,}` rule sits BELOW the old dialog text). Must NOT read
// as limited: the dialog is history, not the active state.
const DISMISSED_DIALOG_PANE = [
  "   What do you want to do?",
  "   ❯ 1. Stop and wait for limit to reset",
  "     2. Add funds to continue with usage credits",
  "   Enter to confirm · Esc to cancel",
  "",
  "❯ continue",
  "● Picked the work back up and finished the migration.",
  "✻ Worked for 25s",
  "─────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────",
  "  14:31:02 | 30% ctx | Opus 4.8 | worktree-x [$] | ~/repos/example-app",
].join("\n");

// ESC-REVEALED text form, captured VERBATIM (read-only) from the same live pane
// after ONE Escape dismissed the dialog: the reset time now shows, WITHOUT a
// "/usage-credits" continuation line (that line appears only in some cases — cf.
// REAL_LIMIT_PANE, which has it). Here the notice is the active block right above
// the input box. Detection must fire, and parseResetTime must read "2:10pm
// (Atlantic/Reykjavik)".
const ESC_REVEALED_PANE = [
  "❯ pr status?",
  "  ⎿  You've hit your session limit · resets 2:10pm (Atlantic/Reykjavik)",
  "─────────────────────────────────────────────",
  "❯ ",
  "─────────────────────────────────────────────",
  "  14:20:47 | 23% ctx | 5h: 101% (now) | Opus 4.8 | worktree-fix-lockfile [!?$] | /home/user/re…",
].join("\n");

// FULL-PANE fixtures: raw `tmux capture-pane -p -e` output (SGR escapes intact —
// exactly what capturePane feeds the classifiers) from a REAL limited Claude Code
// v2.1.224 session (Max plan, session cap), stored under e2e/fixtures/. Repo
// paths, branch names, and work identifiers in the captures were anonymized;
// everything detection reads (notice wording, dialog, chrome lines, rules, SGR
// attributes) is byte-for-byte as captured:
//   - limit-dialog-menu.ansi    the numbered dialog OPEN (Max wording: "2. Upgrade
//                               your plan / 3. Upgrade to Team plan"); the notice
//                               happened to be visible above it in this shallow
//                               session, but with a full scrollback the menu hides it.
//   - limit-esc-revealed.ansi   the SAME pane after ONE Escape: notice + empty box,
//                               with a `✻ Crunched for 0s` spinner summary and a
//                               right-aligned `● high · /effort` mode line between
//                               the notice and the box — the chrome that previously
//                               made this state read "ready".
//   - limit-notice-resent.ansi  a prompt re-sent while limited: the notice re-prints
//                               inline with the "/upgrade to increase your usage
//                               limit." continuation, `✻ Baked for 1s` above the box.
//   - limit-notice-clear-hint.ansi  a long-running session (the real "master-orch"
//                               agendo missed in the field): limit hit mid /loop
//                               wakeup, inline notice, and TWO chrome lines between
//                               it and the box — `✻ Cogitated for 0s` plus the
//                               right-aligned `new task? /clear to save 293k tokens`
//                               hint — with a FAINT history suggestion ("stop
//                               monitoring") sitting in the otherwise-empty box.
const fullPane = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf-8");
const REAL_MENU_PANE = fullPane("limit-dialog-menu.ansi");
const REAL_ESC_REVEALED_PANE = fullPane("limit-esc-revealed.ansi");
const REAL_RESENT_NOTICE_PANE = fullPane("limit-notice-resent.ansi");
const REAL_CLEAR_HINT_PANE = fullPane("limit-notice-clear-hint.ansi");
// The deep-scrollback menu state: the SAME dialog but with the reset-time notice
// NOT on screen (it scrolled behind the menu) — the case the reveal Escape exists
// for. Synthesized from the verbatim capture by dropping the notice line.
const REAL_MENU_PANE_NOTICE_HIDDEN = REAL_MENU_PANE.split("\n")
  .filter((l) => !/hit your session limit/i.test(stripAnsi(l)))
  .join("\n");

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

  test("REGRESSION (the real false negative): the numbered limit DIALOG reads 'limited'", () => {
    // The primary interactive state — a limited session sits in this menu. It has
    // NO reset time and no input box, so it can't be caught by the text-block
    // heuristic; the option wording ("Stop and wait for limit to reset" / "Add
    // funds to continue with usage credits") is the anchor. This is the exact
    // screen agendo missed (classified non-"limited").
    expect(paneReadiness(LIMIT_DIALOG_PANE)).toBe("limited");
    expect(paneUsageLimited(LIMIT_DIALOG_PANE)).toBe(true);
    // Resume-safe: the resume keystrokes lead with Escape, which dismisses the
    // dialog (verified live), then type + send `continue`.
    expect(paneResumeSafe(LIMIT_DIALOG_PANE)).toBe(true);
  });

  test("REGRESSION (negative): the dialog wording left in scrollback (box below) reads 'ready'", () => {
    // Once dismissed and worked past, the dialog text lingers in history with an
    // input box beneath it. The `─` rule below the dialog demotes it from active
    // for BOTH the limit check and the generic dialog check (T8), so an idle pane
    // reads 'ready' — not limited, not dialog — and is never auto-resumed.
    expect(paneReadiness(DISMISSED_DIALOG_PANE)).toBe("ready");
    expect(paneUsageLimited(DISMISSED_DIALOG_PANE)).toBe(false);
    expect(paneResumeSafe(DISMISSED_DIALOG_PANE)).toBe(false);
  });

  test("REGRESSION: the esc-revealed text form (no /usage-credits line) reads 'limited'", () => {
    // After one Escape the reset time shows; this variant has no "/usage-credits"
    // continuation. The notice is the active block above the box, so it fires.
    expect(paneReadiness(ESC_REVEALED_PANE)).toBe("limited");
    expect(paneUsageLimited(ESC_REVEALED_PANE)).toBe(true);
    expect(paneResumeSafe(ESC_REVEALED_PANE)).toBe(true);
  });

  test("REAL CAPTURE: the Max-plan numbered dialog reads 'limited', dialog-active, resume-safe", () => {
    // Verbatim full-pane capture, SGR escapes intact. Only option 1 ("Stop and
    // wait for limit to reset") matches LIMIT_DIALOG_RE — the Max plan replaces
    // the "Add funds" option with upgrade offers — so this pins the single-anchor
    // detection on a real screen.
    expect(paneReadiness(REAL_MENU_PANE)).toBe("limited");
    expect(paneLimitDialogActive(REAL_MENU_PANE)).toBe(true);
    expect(paneResumeSafe(REAL_MENU_PANE)).toBe(true);
  });

  test("REAL CAPTURE (the reveal case): menu open with the notice off-screen → limited, no reset time, reveal fires", () => {
    // With a deep scrollback the menu hides the "resets <time>" line, so the pane
    // is limited but yields no resetAt — exactly the state shouldRevealDialog's
    // one Escape exists to break out of.
    const pane = REAL_MENU_PANE_NOTICE_HIDDEN;
    expect(paneReadiness(pane)).toBe("limited");
    expect(paneLimitDialogActive(pane)).toBe(true);
    expect(parseResetTime(stripAnsi(pane), new Date("2026-08-07T12:00:00Z"))).toBeNull();
    expect(
      shouldRevealDialog({
        enabled: true,
        readiness: "limited",
        dialogActive: true,
        resetAt: null,
        revealed: false,
      }),
    ).toBe(true);
  });

  test("REGRESSION, REAL CAPTURE: the esc-revealed pane with spinner + mode-line chrome reads 'limited'", () => {
    // The v2.1.224 TUI draws a `✻ Crunched for 0s` turn summary and a right-aligned
    // `● high · /effort` mode line between the notice and the input box. The
    // block-above-the-box heuristic used to stop at that chrome and read this pane
    // as 'ready' — wiping the limit bookkeeping right after the reveal Escape and
    // breaking hands-off auto-resume. It must read 'limited' and parse the time.
    expect(paneReadiness(REAL_ESC_REVEALED_PANE)).toBe("limited");
    expect(paneUsageLimited(REAL_ESC_REVEALED_PANE)).toBe(true);
    expect(paneResumeSafe(REAL_ESC_REVEALED_PANE)).toBe(true);
    const at = parseResetTime(stripAnsi(REAL_ESC_REVEALED_PANE), new Date("2026-08-07T12:00:00Z"));
    expect(at).not.toBeNull();
    // "resets 5pm (Atlantic/Reykjavik)" — Reykjavik is UTC+0 year-round.
    expect(new Date(at!).toISOString()).toBe("2026-08-07T17:00:00.000Z");
  });

  test("REGRESSION, REAL CAPTURE (master-orch): notice behind the '/clear to save' hint reads 'limited'", () => {
    // The field failure: a /loop session hit its limit mid-wakeup and printed the
    // inline notice, but the TUI drew `✻ Cogitated for 0s` AND the right-aligned
    // `new task? /clear to save 293k tokens` hint between the notice and the box.
    // Both are chrome; agendo read the pane as 'ready', wiped its limit
    // bookkeeping, and never auto-resumed at reset. The faint "stop monitoring"
    // in the box is a history SUGGESTION, not a draft — resume must stay safe.
    expect(paneReadiness(REAL_CLEAR_HINT_PANE)).toBe("limited");
    expect(paneUsageLimited(REAL_CLEAR_HINT_PANE)).toBe(true);
    expect(paneResumeSafe(REAL_CLEAR_HINT_PANE)).toBe(true);
    const at = parseResetTime(stripAnsi(REAL_CLEAR_HINT_PANE), new Date("2026-08-07T14:00:00Z"));
    expect(at).not.toBeNull();
    expect(new Date(at!).toISOString()).toBe("2026-08-07T17:00:00.000Z");
  });

  test("REAL CAPTURE: a prompt re-sent while limited re-prints the notice ('/upgrade' variant) → 'limited'", () => {
    // Sending into an already-limited pane doesn't reopen the menu; the notice
    // re-prints inline with the Max-plan "/upgrade to increase your usage limit."
    // continuation (a third observed continuation wording, now in USAGE_LIMIT_RE)
    // and a `✻ Baked for 1s` summary above the box.
    expect(paneReadiness(REAL_RESENT_NOTICE_PANE)).toBe("limited");
    expect(paneUsageLimited(REAL_RESENT_NOTICE_PANE)).toBe(true);
    expect(isUsageLimited("     /upgrade to increase your usage limit.")).toBe(true);
    // The bare command name in prose must NOT trip it.
    expect(isUsageLimited("run /upgrade to switch plans")).toBe(false);
  });

  test("isLimitDialog matches the option wording, not ordinary prose", () => {
    expect(isLimitDialog("❯ 1. Stop and wait for limit to reset")).toBe(true);
    expect(isLimitDialog("  2. Add funds to continue with usage credits")).toBe(true);
    // Not tripped by unrelated prose that merely mentions limits or funds.
    expect(isLimitDialog("I hit a limit in the loop and had to reset the counter")).toBe(false);
    expect(isLimitDialog("add the funds to the budget spreadsheet")).toBe(false);
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

  test("REGRESSION: the esc-revealed 'resets 2:10pm (Atlantic/Reykjavik)' (no /usage-credits) parses", () => {
    // Verbatim from the live pane after one Escape. The notice ends at the reset
    // time with no continuation line — parsing must still extract the instant.
    const now = new Date("2026-07-07T09:00:00Z");
    const at = parseResetTime(ESC_REVEALED_PANE, now, RESET_LOOKBACK_MS);
    expect(at).not.toBeNull();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Atlantic/Reykjavik", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(at!));
    const hm = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
    expect(hm).toBe("14:10"); // 2:10pm in Reykjavik (UTC+0 year-round)
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

test.describe("dialogRevealKeystrokes: the one-Escape reveal nudge", () => {
  test("is exactly a single Escape to the target — no 'continue'", () => {
    expect(dialogRevealKeystrokes("cl-claude-abc")).toEqual([
      ["send-keys", "-t", "cl-claude-abc", "Escape"],
    ]);
  });
});

test.describe("paneLimitDialogActive: raw-string wrapper of the structural check", () => {
  test("true only for the active numbered dialog, not text/dismissed forms", () => {
    expect(paneLimitDialogActive(LIMIT_DIALOG_PANE)).toBe(true);
    expect(paneLimitDialogActive(DISMISSED_DIALOG_PANE)).toBe(false); // box below ⇒ scrollback
    expect(paneLimitDialogActive(ESC_REVEALED_PANE)).toBe(false); // text form, no dialog options
    expect(paneLimitDialogActive(BLOCKED_PANE)).toBe(false);
  });
});

// The dialog carries NO reset time, so shouldAutoResume can never fire on it. The
// reveal nudge (one Escape) exists to surface the timestamp; once it lands, this
// gate steps aside and shouldAutoResume takes over. These pin the whole gate.
test.describe("shouldRevealDialog: one-shot reveal of the dialog's hidden reset time", () => {
  const base = {
    enabled: true,
    readiness: "limited" as const,
    dialogActive: true,
    resetAt: null as number | null,
    revealed: false,
  };

  test("fires when ON, limited, active dialog, no reset time, not yet revealed", () => {
    expect(shouldRevealDialog(base)).toBe(true);
  });

  test("off by default: disabled never reveals", () => {
    expect(shouldRevealDialog({ ...base, enabled: false })).toBe(false);
  });

  test("only for the active dialog — never a text-form or non-dialog limited pane", () => {
    expect(shouldRevealDialog({ ...base, dialogActive: false })).toBe(false);
  });

  test("never when the pane isn't limited", () => {
    for (const r of ["ready", "busy", "queued", "dialog", "compacting", "unknown"] as const)
      expect(shouldRevealDialog({ ...base, readiness: r })).toBe(false);
  });

  test("once a reset time is known, it steps aside (shouldAutoResume's job now)", () => {
    expect(shouldRevealDialog({ ...base, resetAt: Date.now() + 3600_000 })).toBe(false);
  });

  test("once-only: already revealed → never re-Escape (parks if the time never shows)", () => {
    expect(shouldRevealDialog({ ...base, revealed: true })).toBe(false);
  });
});

// The reveal→resume handoff end to end (pure): after the Escape reveals the text
// form, parseResetTime freezes an instant, shouldRevealDialog stops, and once the
// reset (plus grace) has passed shouldAutoResume fires into a resume-safe pane.
test.describe("reveal → resume handoff on the esc-revealed text form", () => {
  test("esc-revealed 'resets 2:10pm' → resetAt parses, reveal stops, resume fires", () => {
    const now = new Date("2026-07-07T15:00:00Z"); // past 2:10pm (14:10) in Reykjavik (UTC+0)
    const resetAt = parseResetTime(ESC_REVEALED_PANE, now, RESET_LOOKBACK_MS);
    expect(resetAt).not.toBeNull();
    expect(resetAt!).toBeLessThan(now.getTime()); // already reopened

    // Reveal no longer applies — a reset time is known.
    expect(
      shouldRevealDialog({
        enabled: true,
        readiness: "limited",
        dialogActive: paneLimitDialogActive(ESC_REVEALED_PANE), // false anyway
        resetAt,
        revealed: true,
      }),
    ).toBe(false);

    // The normal fire path takes over: reset passed + grace, pane is resume-safe.
    expect(paneResumeSafe(ESC_REVEALED_PANE)).toBe(true);
    expect(
      shouldAutoResume({ enabled: true, readiness: "limited", resetAt, now: now.getTime(), firedFor: null }),
    ).toBe(true);
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

// Repo-scoped filtering: a path context (`agendo <path>`) narrows the work-item
// and PR views to the git repos found inside it. Two pure halves, both pinned
// here: the downward repo scan (real temp dirs with `.git` markers — no git
// binary needed, same existsSync test repoRootForCwd uses) and the predicates
// that decide whether an item / PR belongs to the discovered set.
test.describe("discoverGitReposUnder: repos at or under a path", () => {
  let dir: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agendo-repos-"));
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Make `<dir>/<rel>` a repo (a `.git` marker is all discovery looks for). */
  const repo = (rel: string) => mkdirSync(join(dir, rel, ".git"), { recursive: true });
  const names = (root: string) => discoverGitReposUnder(root).map((r) => r.name);

  test("a target that is itself a checkout is the only repo", () => {
    repo(".");
    mkdirSync(join(dir, "packages", "inner", ".git"), { recursive: true });
    // The scan stops at the target: a nested checkout inside a repo (a vendored
    // clone, a worktree) belongs to that root, it isn't a sibling repo.
    expect(discoverGitReposUnder(dir).map((r) => r.root)).toEqual([dir]);
  });

  test("a target below a repo root scopes to the repo it is in", () => {
    repo(".");
    const sub = join(dir, "packages", "web");
    mkdirSync(sub, { recursive: true });
    // `agendo ~/git/proj/packages/web` means proj — not "no repos here", and not
    // whatever vendored checkouts happen to sit under the subdirectory.
    expect(discoverGitReposUnder(sub).map((r) => r.root)).toEqual([dir]);
  });

  test("a parent folder inside an unrelated checkout still scopes to the repos in it", () => {
    // The `$HOME tracked as dotfiles` shape: `~/.git` exists, so the upward walk
    // from `~/git` finds it — but `agendo ~/git` means the projects in there, not
    // the dotfiles repo. What's below wins whenever the scan finds anything.
    repo(".");
    repo(join("git", "alpha"));
    repo(join("git", "beta"));
    expect(names(join(dir, "git"))).toEqual(["alpha", "beta"]);
  });

  test("a parent folder yields every repo inside it, direct or deeply nested", () => {
    repo("alpha");
    repo("beta");
    repo(join("nested", "deep", "gamma"));
    expect(names(dir)).toEqual(["alpha", "beta", "gamma"]); // sorted by name
  });

  test("worktrees and node_modules are not separate repos", () => {
    repo("alpha");
    // A launcher worktree carries its own `.git` file but belongs to its root…
    mkdirSync(join(dir, "alpha", ".claude", "worktrees", "feature", ".git"), { recursive: true });
    // …and a vendored checkout under node_modules is not the user's repo.
    mkdirSync(join(dir, "node_modules", "dep", ".git"), { recursive: true });
    expect(names(dir)).toEqual(["alpha"]);
  });

  test("a folder with no repo inside it yields nothing (callers treat that as unscoped)", () => {
    mkdirSync(join(dir, "notes", "more"), { recursive: true });
    expect(discoverGitReposUnder(dir)).toEqual([]);
  });

  test("the scan is cached per target, and `fresh` re-walks it (the `r` refresh)", () => {
    repo("alpha");
    expect(names(dir)).toEqual(["alpha"]);
    // A repo cloned into the target after launch: the cached scan can't see it…
    repo("beta");
    expect(names(dir)).toEqual(["alpha"]);
    // …until a refresh rescans, which also replaces the cached result.
    expect(discoverGitReposUnder(dir, true).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(names(dir)).toEqual(["alpha", "beta"]);
  });
});

test.describe("repo scope predicates", () => {
  const scope = new Set(["appweb", "ada/appweb"]);
  const pr = (id: number, repositoryId: string, repositoryName?: string): PullRequest => ({
    id, title: `PR ${id}`, status: "active", branch: "b", repositoryId, repositoryName,
    isDraft: false, approvals: 0, rejections: 0, waiting: 0, approvedCount: 0, requiredCount: 0,
    ci: "none", createdDate: 0, updatedDate: 0, url: "",
  });
  const item = (id: number, project: string, prs: PullRequest[] = []): WorkItem => ({
    id, type: "Bug", title: `WI ${id}`, state: "Active", iterationPath: "", project,
    inCurrentSprint: true, prs, sessions: [], url: "",
  });

  test("a PR matches on either repo identity (GitHub slug id / ADO repo name)", () => {
    expect(prInRepoScope(pr(1, "ada/appweb", "appweb"), scope)).toBe(true); // GitHub
    expect(prInRepoScope(pr(2, "repoA-guid", "appweb"), scope)).toBe(true); // ADO (guid id)
    expect(prInRepoScope(pr(3, "repoB-guid", "applib"), scope)).toBe(false);
  });

  test("a null scope (no path context, or the filter toggled off) passes everything", () => {
    expect(prInRepoScope(pr(3, "repoB-guid", "applib"), null)).toBe(true);
    expect(itemInRepoScope(item(9, "Widgets"), "ado", null)).toBe(true);
  });

  test("GitHub issues match exactly, on the owner/repo slug they carry", () => {
    expect(itemInRepoScope(item(1, "ada/appweb"), "github", scope)).toBe(true);
    expect(itemInRepoScope(item(2, "ada/applib"), "github", scope)).toBe(false);
  });

  test("ADO work items match through their PRs; PR-less items carry no repo signal", () => {
    // `project` is the ADO team project, never a repo — so linked PRs are the
    // only signal, and an item with none is kept rather than silently hidden.
    expect(itemInRepoScope(item(1, "Widgets", [pr(1, "repoA-guid", "appweb")]), "ado", scope)).toBe(true);
    expect(itemInRepoScope(item(2, "Widgets", [pr(2, "repoB-guid", "applib")]), "ado", scope)).toBe(false);
    expect(itemInRepoScope(item(3, "Widgets"), "ado", scope)).toBe(true);
  });

  test("filterModelByRepos narrows every item / PR list and leaves the rest alone", () => {
    const model = {
      provider: "ado" as const,
      current: [item(1, "Widgets", [pr(1, "repoA-guid", "appweb")]), item(2, "Widgets", [pr(2, "repoB-guid", "applib")])],
      other: [],
      prLinked: [],
      linkedPrs: [{ ...pr(1, "repoA-guid", "appweb"), sessions: [], workItemId: 1, workItemType: "Bug", workItemTitle: "", workItemUrl: "" }],
      reviewPrs: [{ ...pr(7, "repoB-guid", "applib"), sessions: [], reviewReason: "you" }],
      orphanPrs: [{ ...pr(6, "repoB-guid", "applib"), sessions: [] }],
      repos: [{ root: "/r", name: "r", total: 1, claude: 1, copilot: 0 }],
    } as unknown as LoadedModel;

    const filtered = filterModelByRepos(model, scope);
    expect(filtered.current.map((i) => i.id)).toEqual([1]);
    expect(filtered.linkedPrs.map((p) => p.id)).toEqual([1]);
    expect(filtered.reviewPrs).toEqual([]);
    expect(filtered.orphanPrs).toEqual([]);
    expect(filtered.repos).toBe(model.repos); // untouched — sessions views don't scope by repo
    expect(filterModelByRepos(model, null)).toBe(model); // inert without a scope
  });
});

test.describe("mergeRepos: session-derived ∪ path-discovered", () => {
  test("dedupes by root, keeping the entry that carries the session counts", () => {
    const sessionDerived = [{ root: "/r/appweb", name: "appweb", total: 2, claude: 2, copilot: 0 }];
    const discovered = [
      { root: "/r/appweb", name: "appweb", total: 0, claude: 0, copilot: 0 },
      { root: "/r/fresh", name: "fresh", total: 0, claude: 0, copilot: 0 },
    ];
    const merged = mergeRepos(sessionDerived, discovered);
    expect(merged.map((r) => r.name).sort()).toEqual(["appweb", "fresh"]);
    expect(merged.find((r) => r.name === "appweb")!.total).toBe(2);
  });
});

test.describe("repoScopeKeys: what a checkout matches as", () => {
  // A stub `git` on PATH answering `-C <root> remote get-url origin` per root, so
  // the key derivation is pinned without touching a real repo (same trick the
  // provider tests use for detectRepoProvider).
  function withOrigins(origins: Record<string, string>, fn: () => void): void {
    const bin = mkdtempSync(join(tmpdir(), "agendo-keys-bin-"));
    const cases = Object.entries(origins)
      .map(([p, url]) => `    "${p}") echo "${url}"; exit 0;;`)
      .join("\n");
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\ncase "$*" in\n  *"remote get-url origin"*)\n  case "$2" in\n${cases}\n  esac\n  exit 1;;\nesac\nexit 0\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = bin;
    try {
      fn();
    } finally {
      process.env.PATH = saved;
    }
  }
  // Keys are cached per root for the process lifetime, so every case gets a root
  // path of its own.
  const repo = (root: string): RepoInfo => ({ root, name: root.split("/").pop()!, total: 0, claude: 0, copilot: 0 });
  const pr = (id: number, repositoryId: string, repositoryName: string): PullRequest => ({
    id, title: `PR ${id}`, status: "active", branch: "b", repositoryId, repositoryName,
    isDraft: false, approvals: 0, rejections: 0, waiting: 0, approvedCount: 0, requiredCount: 0,
    ci: "none", createdDate: 0, updatedDate: 0, url: "",
  });

  test("a GitHub checkout matches only on its owner/repo slug, never the bare name", () => {
    // The bare name would let a same-named repo under another owner (a fork the
    // user has sessions in, so it's still fetched) slip past the PR filter via
    // PullRequest.repositoryName, while its issues were correctly dropped.
    withOrigins({ "/k1/appweb": "https://github.com/ada/appweb.git" }, () => {
      const keys = repoScopeKeys([repo("/k1/appweb")]);
      expect([...keys]).toEqual(["ada/appweb"]);
      expect(prInRepoScope(pr(1, "bob/appweb", "appweb"), keys)).toBe(false);
      expect(prInRepoScope(pr(2, "ada/appweb", "appweb"), keys)).toBe(true);
    });
  });

  test("an Azure DevOps checkout matches on its _git/<repo> name (what its PRs carry)", () => {
    withOrigins({ "/k2/web": "https://dev.azure.com/org/proj/_git/appweb" }, () => {
      const keys = repoScopeKeys([repo("/k2/web")]);
      expect([...keys]).toEqual(["appweb"]); // the remote's name, not the directory's
      expect(prInRepoScope(pr(3, "repo-guid", "appweb"), keys)).toBe(true);
    });
  });

  test("an ADO checkout cloned over ssh matches on the v3 triple's repo name", () => {
    // The modern ADO ssh remote has no `_git` segment; without its own pattern
    // the checkout would silently degrade to the directory basename ("frontend")
    // and every one of its PRs would vanish from the filtered views.
    withOrigins({ "/k4/frontend": "git@ssh.dev.azure.com:v3/org/proj/appweb" }, () => {
      const keys = repoScopeKeys([repo("/k4/frontend")]);
      expect([...keys]).toEqual(["appweb"]);
      expect(prInRepoScope(pr(4, "repo-guid", "appweb"), keys)).toBe(true);
    });
  });

  test("an ADO repo name with a space is decoded, not left percent-encoded", () => {
    // The remote URL escapes it; the PRs carry the display name. Without decoding
    // the key ("my%20repo") never matches, and every PR of that repo — plus the
    // work items linked only to them — silently disappears from the filtered views.
    withOrigins({ "/k5/myrepo": "https://dev.azure.com/org/proj/_git/My%20Repo" }, () => {
      const keys = repoScopeKeys([repo("/k5/myrepo")]);
      expect([...keys]).toEqual(["my repo"]);
      expect(prInRepoScope(pr(5, "repo-guid", "My Repo"), keys)).toBe(true);
    });
  });

  test("a checkout with no origin falls back to its directory basename", () => {
    withOrigins({}, () => {
      expect([...repoScopeKeys([repo("/k3/applib")])]).toEqual(["applib"]);
    });
  });
});
