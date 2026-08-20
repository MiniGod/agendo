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
import { readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { reconcileLive, filterModelByRepos, itemInRepoScope, prInRepoScope, type LoadedModel } from "../src/model.ts";
import {
  discoverGitReposUnder,
  mergeRepos,
  repoScopeKeys,
  ensureRepoAtTop,
  bootstrapRepoRoot,
  type RepoInfo,
} from "../src/repos.ts";
import { resolveWindowSession, bestSessionForCwd } from "../src/restore.ts";
import { type ManagedTarget, windowTarget, managedKind, sessionName, shortId, paneReadiness, paneResumeSafe, paneUsageLimited, paneLimitDialogActive, resumeKeystrokes, dialogRevealKeystrokes, stripAnsi, paneResumeDialogActive, paneAcceptsPaste, resumeDialogOption, resumeDialogStep, resumeDialogSelection, paneResumeMenuSuspect, paneCompactionPercent } from "../src/tmux.ts";
import { resumeDialogChoice, DEFAULT_CONFIG } from "../src/config.ts";
import { envLocale, formatResetTime, parseResetTime, paneResetAt, shouldAutoResume, shouldRevealDialog, isLimitDialog, isUsageLimited, RESET_GRACE_MS, RESET_LOOKBACK_MS } from "../src/usageLimit.ts";
import { freshName, prFreshName } from "../src/launch.ts";
import { resolveContext, isUnderRoot, tmuxSafeName, normalizeCwd } from "../src/context.ts";
import { SessionIndex } from "../src/sessions.ts";
import { resolveScopeRoots, makeSessionScope, describeScope, scopeFilter } from "../src/scope.ts";
import type { AgentSession, PullRequest, WorkItem } from "../src/types.ts";

// Minimal session factory — only the fields the attribution logic reads.
function sess(id: string, cwd: string, lastUsedMs: number, source: AgentSession["source"] = "claude"): AgentSession {
  return { id, source, cwd, title: id, lastUsed: new Date(lastUsedMs) };
}
type Managed = { name: string; cwd: string; placeholder: boolean };
/**
 * Fixture shape → producer shape. `liveManagedPaths` now pairs every managed
 * name with the target that ADDRESSES it, because a bare window name resolves
 * only inside the caller's own tmux session (#39). These fixtures all model a
 * single host, where the addressable target IS the exact-pinned bare name — so
 * the fixtures keep saying exactly what they said, and this fills in the half
 * that used to be implicit. Multi-host targets are asserted separately below.
 */
const qualify = (m: Managed): ManagedTarget => ({ ...m, target: `=${m.name}` });

test.describe("managedKind: name-prefix → launch kind", () => {
  test("classifies every known prefix and rejects unknown ones", () => {
    expect(managedKind("cl-bg-abc")).toBe("background");
    expect(managedKind("cl-new-abc")).toBe("new");
    expect(managedKind("cl-free-abc")).toBe("new"); // legacy manual prefix
    expect(managedKind("cl-wi-101")).toBe("workitem");
    expect(managedKind("cl-pr-5001")).toBe("pr");
    expect(managedKind("cl-claude-abc")).toBe("resumed");
    expect(managedKind("cl-copilot-abc")).toBe("resumed");
    expect(managedKind("cl-codex-abc")).toBe("resumed");
    expect(managedKind("cl-bogus-abc")).toBeNull();
    expect(managedKind("not-managed")).toBeNull();
  });

  test("a tagged id-less fresh name still classifies by its kind prefix", () => {
    // Codex can't be handed a session id, so its fresh windows carry an extra
    // `<agent>-` segment. The badge must still read bg/new.
    expect(managedKind("cl-bg-codex-abc123")).toBe("background");
    expect(managedKind("cl-new-codex-abc123")).toBe("new");
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

  test("a tagged id-less fresh name attributes by cwd, like the legacy names", () => {
    // `cl-bg-codex-<uniquifier>` embeds no session id — the uniquifier is only
    // there to keep window names distinct. Falling through to the cwd MRU is
    // what lets a codex session (whose id codex assigns itself) be found at all.
    expect(resolveWindowSession(all, "cl-bg-codex-aaaolder", "/repo")).toBe(newer);
    expect(resolveWindowSession(all, "cl-new-codex-zzz", "/other")).toBe(elsewhere);
  });
});

test.describe("SessionIndex.forWorkItem: repo-scoped id-in-branch/cwd match (M1)", () => {
  // Build an index directly from in-memory sessions (bypassing the disk scan).
  // Worktree-shaped cwds resolve to a repo root purely by string, so no fs.
  function indexOf(...sessions: AgentSession[]): SessionIndex {
    const idx = new SessionIndex();
    idx.all.push(...sessions);
    return idx;
  }
  const mk = (id: string, cwd: string, branch: string): AgentSession =>
    ({ id, source: "claude", cwd, branch, title: id, lastUsed: new Date(0) });

  test("a repo scope keeps GitHub issue #2 off same-numbered branches in OTHER repos", () => {
    const inRepo = mk("s1", "/home/me/git/appweb/.claude/worktrees/fix-2", "worktree-fix-2");
    // A different repo whose name AND branch merely contain "2" — the false match.
    const otherRepo = mk("s2", "/home/me/git/app2/.claude/worktrees/rework", "v2-fixes");
    const idx = indexOf(inRepo, otherRepo);
    // Unscoped, BOTH match on the bare "2" (the pre-fix behaviour, still the ADO path).
    expect(idx.forWorkItem(2).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
    // Scoped to the issue's repo slug → only the session actually in appweb.
    expect(idx.forWorkItem(2, "ada/appweb").map((s) => s.id)).toEqual(["s1"]);
  });

  test("a bare repo name scopes just as well as a slug", () => {
    const inRepo = mk("s1", "/home/me/git/appweb/.claude/worktrees/fix-2", "worktree-fix-2");
    const otherRepo = mk("s2", "/home/me/git/app2/.claude/worktrees/rework", "v2-fixes");
    expect(indexOf(inRepo, otherRepo).forWorkItem(2, "appweb").map((s) => s.id)).toEqual(["s1"]);
  });

  test("Copilot's recorded repository field also satisfies the scope", () => {
    const cop: AgentSession = {
      id: "c1", source: "copilot", cwd: "/tmp/checkout", branch: "fix-2",
      repository: "ada/appweb", title: "c1", lastUsed: new Date(0),
    };
    expect(indexOf(cop).forWorkItem(2, "ada/appweb").map((s) => s.id)).toEqual(["c1"]);
    expect(indexOf(cop).forWorkItem(2, "ada/other")).toEqual([]);
  });

  test("Codex's recorded repository field satisfies the scope the same way", () => {
    // Codex records the raw origin URL; the provider reduces it to a slug so it
    // lands in the same identity domain as the scope (see repoIdFromRemote).
    const cdx: AgentSession = {
      id: "x1", source: "codex", cwd: "/tmp/gone", branch: "fix-2",
      repository: "ada/appweb", title: "x1", lastUsed: new Date(0),
    };
    expect(indexOf(cdx).forWorkItem(2, "ada/appweb").map((s) => s.id)).toEqual(["x1"]);
    expect(indexOf(cdx).forWorkItem(2, "ada/other")).toEqual([]);
  });

  test("unscoped (ADO) match is unchanged, digit boundaries still hold", () => {
    const hit = mk("s1", "/home/me/git/appweb/.claude/worktrees/fix-231938", "worktree-231938");
    const near = mk("s2", "/home/me/git/appweb/.claude/worktrees/x", "b-1231938"); // 231938 inside 1231938
    expect(indexOf(hit, near).forWorkItem(231938).map((s) => s.id)).toEqual(["s1"]);
  });

  // ── real checkouts on disk: scope by owner/repo, not by directory name ──────
  // The tests above use synthetic cwds that don't exist, which exercises the
  // basename FALLBACK. These create actual git repos so the `origin` remote
  // resolves, pinning the two things a directory-name comparison gets wrong: a
  // clone whose directory isn't named after the remote (false negative — the
  // item↔session link silently dies for that repo), and two forks of the same
  // repo name under different owners (false positive — they cross-match).
  //
  // Real repos rather than a stub `git` on PATH (as provider.spec.ts uses): a
  // stub reports ONE origin for every root, so it could not distinguish
  // alice/tool from bob/tool, which is the whole point of the fork case.
  // Each gitRepo() call mints its own mkdtemp parent (so two repos can share a
  // basename, as the fork case needs); remember the parents so afterAll can
  // reclaim them — a `git init` leaves ~100KB of template files behind, and
  // without this every local run permanently litters the temp dir.
  const tempRoots: string[] = [];
  test.afterAll(() => {
    for (const dir of tempRoots) {
      // Cleanup must never be the reason a green suite reports red.
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  function gitRepo(dirName: string, origin: string | null): string {
    const parent = mkdtempSync(join(tmpdir(), "agendo-scope-"));
    tempRoots.push(parent);
    const root = join(parent, dirName);
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
    return root;
  }
  // A worktree-shaped cwd under a real checkout: repos.ts strips the
  // `.claude/worktrees/<name>` suffix by string, so the dir needn't exist.
  const worktreeIn = (root: string, name: string) => join(root, ".claude", "worktrees", name);

  test("a checkout whose DIRECTORY name differs from the remote repo still matches", () => {
    // `ada/web-app` cloned into a directory called `frontend`: the bare-basename
    // comparison sees "frontend" vs "web-app" and drops the session entirely.
    const root = gitRepo("frontend", "https://github.com/ada/web-app.git");
    const s = mk("s1", worktreeIn(root, "fix-2"), "worktree-fix-2");
    expect(indexOf(s).forWorkItem(2, "ada/web-app").map((x) => x.id)).toEqual(["s1"]);
    // …and it is still correctly excluded from a different repo's issue #2.
    expect(indexOf(s).forWorkItem(2, "ada/appweb")).toEqual([]);
  });

  test("same-named repos under different owners (forks) do NOT cross-match", () => {
    const alice = mk("s1", worktreeIn(gitRepo("tool", "git@github.com:alice/tool.git"), "fix-2"), "fix-2");
    const bob = mk("s2", worktreeIn(gitRepo("tool", "git@github.com:bob/tool.git"), "fix-2"), "fix-2");
    const idx = indexOf(alice, bob);
    expect(idx.forWorkItem(2, "alice/tool").map((s) => s.id)).toEqual(["s1"]);
    expect(idx.forWorkItem(2, "bob/tool").map((s) => s.id)).toEqual(["s2"]);
    // Unscoped (the ADO path) still sees both — scoping is opt-in.
    expect(idx.forWorkItem(2).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  test("a checkout with no GitHub origin falls back to comparing bare names", () => {
    // A real repo with no remote at all, plus one on a non-GitHub host: neither
    // resolves to a slug, so both are matched by directory basename as before.
    const noRemote = mk("s1", worktreeIn(gitRepo("appweb", null), "fix-2"), "worktree-fix-2");
    const ado = mk("s2", worktreeIn(gitRepo("appweb", "https://dev.azure.com/org/proj/_git/appweb"), "fix-2"), "fix-2");
    expect(indexOf(noRemote).forWorkItem(2, "ada/appweb").map((s) => s.id)).toEqual(["s1"]);
    expect(indexOf(ado).forWorkItem(2, "ada/appweb").map((s) => s.id)).toEqual(["s2"]);
    expect(indexOf(noRemote, ado).forWorkItem(2, "ada/other")).toEqual([]);
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
    const r = reconcileLive(new Set(["cl-wi-42"]), managed.map(qualify), [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveKinds.get(canon)).toBe("workitem");
    expect(r.liveWindows.get(canon)?.name).toBe("cl-wi-42");
  });

  test("attribution survives cwd representation drift (trailing slash / dot segments)", () => {
    // tmux reports the pane cwd with a trailing slash; the session recorded it
    // clean. A raw `===` would miss this and show the session cold — normalizeCwd
    // makes them compare equal.
    const s = sess("driftid", DOT_WT, 5_000);
    const canon = sessionName(s);
    const managed: Managed[] = [{ name: "cl-pr-9", cwd: DOT_WT + "/", placeholder: false }];
    const r = reconcileLive(new Set(["cl-pr-9"]), managed.map(qualify), [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveWindows.get(canon)?.name).toBe("cl-pr-9");
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
    const r = reconcileLive(new Set(), [{ name: canon, cwd: "/x", placeholder: false }].map(qualify), [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveKinds.get(canon)).toBe("resumed");
    expect(r.liveWindows.get(canon)?.name).toBe(canon);
    expect(r.livePlaceholders.size).toBe(0);
  });

  test("legacy cl-wi- window attributes to the MRU session and records the window", () => {
    const older = sess("old", "/repo", 1_000);
    const newer = sess("new", "/repo", 5_000);
    const managed: Managed[] = [{ name: "cl-wi-101", cwd: "/repo", placeholder: false }];
    const r = reconcileLive(new Set(["cl-wi-101"]), managed.map(qualify), [older, newer]);

    const canon = sessionName(newer);
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveKinds.get(canon)).toBe("workitem");
    // The recorded window is the LEGACY name — this is what the app attaches to,
    // so it never spawns a duplicate cl-claude-<id> window for the session.
    expect(r.liveWindows.get(canon)?.name).toBe("cl-wi-101");
    // Only the MRU session is attributed; the older one in the same cwd is not.
    expect(r.live.has(sessionName(older))).toBe(false);
  });

  test("a dormant placeholder is dropped from live and reported as a placeholder", () => {
    const s = sess("xyz", "/x", 1_000);
    const canon = sessionName(s);
    // `base` counted the placeholder window as live (it carries the canonical name).
    const r = reconcileLive(new Set([canon]), [{ name: canon, cwd: "/x", placeholder: true }].map(qualify), [s]);
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
    const r = reconcileLive(new Set([canon, "cl-wi-9"]), managed.map(qualify), [s]);
    expect(r.live.has(canon)).toBe(true); // real window vouched → running
    expect(r.livePlaceholders.has(canon)).toBe(false); // not a dormant tab
    expect(r.liveWindows.get(canon)?.name).toBe("cl-wi-9"); // attached via the real window
  });

  test("same, with the real window listed BEFORE the placeholder", () => {
    const s = sess("xyz", "/repo", 1_000);
    const canon = sessionName(s);
    const managed: Managed[] = [
      { name: "cl-wi-9", cwd: "/repo", placeholder: false },
      { name: canon, cwd: "/repo", placeholder: true },
    ];
    const r = reconcileLive(new Set([canon, "cl-wi-9"]), managed.map(qualify), [s]);
    expect(r.live.has(canon)).toBe(true);
    expect(r.livePlaceholders.has(canon)).toBe(false);
  });

  test("windows with an unknown cl- kind are ignored", () => {
    const s = sess("s", "/x", 1_000);
    const r = reconcileLive(new Set(), [{ name: "cl-bogus-1", cwd: "/x", placeholder: false }].map(qualify), [s]);
    expect(r.live.size).toBe(0);
    expect(r.liveWindows.size).toBe(0);
  });

  test("shortId / sessionName stay consistent for id-bearing attribution", () => {
    // The attribution round-trips: a window named for a session's shortId resolves
    // back to that session. Guards the shortId slug rule the names depend on.
    const s = sess("a1b2-c3d4-e5f6-long", "/x", 1_000, "copilot");
    expect(sessionName(s)).toBe(`cl-copilot-${shortId(s.id)}`);
    const r = reconcileLive(new Set(), [{ name: sessionName(s), cwd: "/x", placeholder: false }].map(qualify), [s]);
    expect(r.live.has(sessionName(s))).toBe(true);
  });

  test("a resumed codex window attributes by its canonical id-bearing name", () => {
    const s = sess("019cde00-1111-7000-8000-00000000cde0", "/x", 1_000, "codex");
    expect(sessionName(s)).toBe("cl-codex-019cde001111");
    const r = reconcileLive(new Set(), [{ name: sessionName(s), cwd: "/x", placeholder: false }].map(qualify), [s]);
    expect(r.live.has(sessionName(s))).toBe(true);
    expect(r.liveKinds.get(sessionName(s))).toBe("resumed");
  });

  test("a fresh codex window attributes to the session codex created in its cwd", () => {
    // The window name carries no session id, so this is the path that makes a
    // `agendo launch --agent codex` session show up as running at all.
    const s = sess("019cde00-1111-7000-8000-00000000cde0", "/wt", 1_000, "codex");
    const r = reconcileLive(new Set(), [{ name: "cl-bg-codex-9f8e7d6c", cwd: "/wt", placeholder: false }].map(qualify), [s]);
    expect(r.live.has(sessionName(s))).toBe(true);
    expect(r.liveKinds.get(sessionName(s))).toBe("background");
    expect(r.liveWindows.get(sessionName(s))?.name).toBe("cl-bg-codex-9f8e7d6c");
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
//   - limit-notice-task-panel.ansi  an orchestrator session with a TASK LIST: its
//                               background agents died on the limit, and the TUI's
//                               standing `7 tasks (3 done, 1 in progress, 3 open)`
//                               panel renders between the notice and the box —
//                               seven lines of persistent UI that read as the
//                               "latest content block" and hid the notice.
const fullPane = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf-8");
const REAL_MENU_PANE = fullPane("limit-dialog-menu.ansi");
const REAL_ESC_REVEALED_PANE = fullPane("limit-esc-revealed.ansi");
const REAL_RESENT_NOTICE_PANE = fullPane("limit-notice-resent.ansi");
const REAL_CLEAR_HINT_PANE = fullPane("limit-notice-clear-hint.ansi");
const REAL_TASK_PANEL_PANE = fullPane("limit-notice-task-panel.ansi");
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

  test("REGRESSION, REAL CAPTURE: notice behind the TASK PANEL reads 'limited' and yields the reset time", () => {
    // The field failure this fixture was captured for: an orchestrator session
    // whose background agents all died on the session cap ("Agent … failed: …
    // You've hit your session limit · resets 1:30pm"), sitting behind the TUI's
    // standing task list:
    //     ✻ Cogitated for 52m 16s
    //     7 tasks (3 done, 1 in progress, 3 open)
    //     ◼ … / ◻ … / ✔ …
    //      … +2 completed
    // That panel is persistent UI, not conversation output, but the
    // block-above-the-box heuristic counted it as the latest content and demoted
    // the notice to history — so the pane read 'ready' and never auto-resumed.
    expect(paneReadiness(REAL_TASK_PANEL_PANE)).toBe("limited");
    expect(paneUsageLimited(REAL_TASK_PANEL_PANE)).toBe(true);
    expect(paneResumeSafe(REAL_TASK_PANEL_PANE)).toBe(true);
    const at = parseResetTime(stripAnsi(REAL_TASK_PANEL_PANE), new Date("2026-08-10T12:40:00Z"));
    expect(at).not.toBeNull();
    // "resets 1:30pm (Atlantic/Reykjavik)" — Reykjavik is UTC+0 year-round.
    expect(new Date(at!).toISOString()).toBe("2026-08-10T13:30:00.000Z");
  });

  test("REGRESSION (negative): a task panel above a RECOVERED session still reads 'ready'", () => {
    // Skipping the panel must not skip past real turn output behind it. Same
    // capture, but with a completed turn between the notice and the panel — the
    // session moved on, so the notice is history and the pane is sendable.
    const lines = REAL_TASK_PANEL_PANE.split("\n");
    const panelAt = lines.findIndex((l) => /^\s*\d+ tasks? \(/.test(stripAnsi(l)));
    const recovered = [
      ...lines.slice(0, panelAt),
      "[38;5;231m●[39m Picked the work back up: rebuilt the index and re-ran the suite, all green.",
      "",
      ...lines.slice(panelAt),
    ].join("\n");
    expect(paneUsageLimited(recovered)).toBe(false);
    expect(paneReadiness(recovered)).toBe("ready");
    expect(paneResumeSafe(recovered)).toBe(false);
  });

  test("a task-panel-shaped line outside a panel is still content, not chrome", () => {
    // The panel is matched structurally (header + the contiguous rows beneath it),
    // so a lone glyph line of turn output between the notice and the box demotes
    // the notice exactly as before — only a real `N tasks (…)` header opens a panel.
    const notice = "  ⎿  You've hit your session limit · resets 2:10pm (Atlantic/Reykjavik)";
    const glyphOutput = "  ✔ Rebuilt the index and re-ran the suite";
    expect(paneUsageLimited([notice, "", glyphOutput, idleBox].join("\n"))).toBe(false);
    // …but the same line *under* a panel header is part of the panel, and skipped.
    expect(
      paneUsageLimited([notice, "", "  1 task (0 done, 1 open)", glyphOutput, idleBox].join("\n")),
    ).toBe(true);
    // Prose that merely counts tasks doesn't open a panel.
    expect(
      paneUsageLimited([notice, "", "  3 tasks (see the plan above)", glyphOutput, idleBox].join("\n")),
    ).toBe(false);
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

// RESUME-DIALOG fixtures: verbatim `tmux capture-pane` output from a REAL session
// blocked on the claude CLI's OWN startup prompt about how to reload itself
// (window cl-claude-…, 2026-08-13), stored under e2e/fixtures/. Home dir, session
// uuids and window names were sterilized; every line detection reads (the header,
// the option labels, the `(recommended)` marker, the rule above them, the SGR
// attributes) is byte-for-byte as captured:
//   - resume-dialog.ansi        `-p -e`, escapes intact — what capturePane feeds.
//   - resume-dialog-plain.txt   `-p`, the SAME screen with colours discarded.
// The caret sat on the `❯` of the selected option, NOT in an input box (there is
// none behind the dialog) — cursor_x=2 cursor_y=91 as captured, y=17 here.
// The capture's ~74 lines of replayed transcript above the rule were trimmed to
// the 9 that carry structure: a prompt echo, two `●` turn results and the blank
// lines between them, then the `✻ Cogitated for 1m 8s` chrome line, a blank, and
// the rule — the exact tail the block-scan heuristics (paneUsageLimited, the busy
// counter) walk, and what the splice tests below write into. What went was one
// unrelated in-flight feature's diff dump and notes: dead weight for detection,
// and not something to park in this repo's history.
const RESUME_DIALOG_PANE = fullPane("resume-dialog.ansi");
const RESUME_DIALOG_PLAIN = fullPane("resume-dialog-plain.txt");
const RESUME_DIALOG_CURSOR = { x: 2, y: 17 };

test.describe("paneReadiness: the CLI's own resume dialog is idle, not 'dialog'", () => {
  test("REGRESSION, REAL CAPTURE: the resume dialog reads 'ready' (with and without escapes)", () => {
    // The blocking bug: structurally this is a dialog (numbered options under a
    // rule, no input box), so it read "dialog" — `list`/`status` reported a
    // blocked session and `send` refused, forever. Nothing is waiting on a human
    // decision about the WORK, so it must present as an available session.
    expect(paneResumeDialogActive(RESUME_DIALOG_PANE)).toBe(true);
    expect(paneReadiness(RESUME_DIALOG_PANE, RESUME_DIALOG_CURSOR)).toBe("ready");
    // Colour is not part of the signal: the plain capture classifies identically.
    expect(paneResumeDialogActive(RESUME_DIALOG_PLAIN)).toBe(true);
    expect(paneReadiness(RESUME_DIALOG_PLAIN, RESUME_DIALOG_CURSOR)).toBe("ready");
  });

  test("but it is NOT paste-able, and never resume-safe or limited", () => {
    // "ready" here means "available", not "there's an empty box to paste into" —
    // the dialog replaced the box. paneAcceptsPaste is the check every sender
    // must make; and the usage-limit machinery must not be tempted by the
    // dialog's own "…consume a substantial portion of your usage limits" prose.
    expect(paneAcceptsPaste(RESUME_DIALOG_PANE, RESUME_DIALOG_CURSOR)).toBe(false);
    expect(paneUsageLimited(RESUME_DIALOG_PANE)).toBe(false);
    expect(paneLimitDialogActive(RESUME_DIALOG_PANE)).toBe(false);
    expect(paneResumeSafe(RESUME_DIALOG_PANE, RESUME_DIALOG_CURSOR)).toBe(false);
  });

  test("REGRESSION GUARD: a genuine agent question still reads 'dialog'", () => {
    // The detector is narrow on purpose — it must not be a loosening of isDialog,
    // which is load-bearing for auto-resume safety. A real question, a numbered
    // menu that merely mentions resuming, and the limit dialog all stay dialogs.
    const question = [
      "  ✔ Goal achieved (1m · 1 turn · 4.6k tokens)",
      "  Do you want to proceed?",
      "  ❯ 1. Yes",
      "    2. No",
      "  Enter to confirm · Esc to cancel",
    ].join("\n");
    expect(paneResumeDialogActive(question)).toBe(false);
    expect(paneReadiness(question)).toBe("dialog");

    const aboutResuming = [
      "  The session died mid-run. How should I pick it back up?",
      "  ❯ 1. Resume from summary of what we did",
      "    2. Start over",
      "  Enter to confirm · Esc to cancel",
    ].join("\n");
    // Only ONE of the two anchors is present, so this stays a question for a human.
    expect(paneResumeDialogActive(aboutResuming)).toBe(false);
    expect(paneReadiness(aboutResuming)).toBe("dialog");
  });

  test("the motivating case: a limit notice in the REPLAYED transcript above it stays 'ready'", () => {
    // The commonest reason to resume a 249k-token session is that it stopped at
    // its usage limit — so the transcript replayed above the dialog ends in that
    // very notice, and paneUsageLimited (which reads the block above the last
    // rule) sees it. Judged in the usual order the pane would read "limited":
    // `status` would print a stale reset time and `wait` would never settle —
    // the same blocked-forever report in a different costume. Nothing there is
    // the CURRENT state; no turn has run yet.
    const lines = RESUME_DIALOG_PLAIN.split("\n");
    const rule = lines.findIndex((l) => /─{20,}/.test(l));
    // Placed in the transcript tail the block scan actually reads (it anchors two
    // lines above the box's rule), which is where a replayed notice lands.
    const at = rule - 3;
    const limited = [
      ...lines.slice(0, at),
      "  ⎿  You've hit your session limit · resets 7:20pm (Atlantic/Reykjavik)",
      ...lines.slice(at),
    ].join("\n");
    expect(paneUsageLimited(limited)).toBe(true); // the notice IS on screen…
    expect(paneResumeDialogActive(limited)).toBe(true);
    expect(paneReadiness(limited, RESUME_DIALOG_CURSOR)).toBe("ready"); // …but it's history
    // And the auto-resume nudge must never fire here: it leads with Escape,
    // which is this dialog's own "Esc to cancel".
    expect(paneResumeSafe(limited, RESUME_DIALOG_CURSOR)).toBe(false);
  });

  test("a session BUSY behind stale scrollback still can't hide the dialog", () => {
    // Same shape with an interrupted spinner's counter in the replayed tail.
    const lines = RESUME_DIALOG_PLAIN.split("\n");
    const rule = lines.findIndex((l) => /─{20,}/.test(l));
    const busyTail = [...lines.slice(0, rule), "  ✢ Tinkering… (58s · ↓ 3.9k tokens)", ...lines.slice(rule)].join("\n");
    expect(paneReadiness(busyTail, RESUME_DIALOG_CURSOR)).toBe("ready");
  });

  test("FALSE-POSITIVE GUARD: turn output merely QUOTING both labels is not the dialog", () => {
    // A false positive here is fail-DANGEROUS, unlike isDialog's: it would make
    // `send` press a digit into a live agent's box. The confirm/cancel footer —
    // the affordance only a real open dialog draws — is what separates them.
    const quoted = [
      "● The CLI asked me how to reload it:",
      "    1. Resume from summary (recommended)",
      "    2. Resume full session as-is",
      "● I picked the summary and carried on.",
    ].join("\n");
    expect(paneResumeDialogActive(quoted)).toBe(false);
    expect(resumeDialogOption(quoted, "summary")).toBeNull();
    // Each anchor is load-bearing on its own: quoted text that also carries a
    // cursor still isn't the dialog without the footer, and vice versa.
    const withCursor = quoted.replace("    1. Resume", "  ❯ 1. Resume");
    expect(paneResumeDialogActive(withCursor)).toBe(false); // no footer
    expect(paneResumeDialogActive([quoted, "  Enter to confirm · Esc to cancel"].join("\n"))).toBe(false); // no cursor
    // With an input box below it (the ordinary case) it's plainly just history.
    expect(paneReadiness([quoted, "─────────────────────────────────────────────", "❯ ", "─────────────────────────────────────────────"].join("\n"))).toBe("ready");
  });

  test("a WRAPPED option label fails safe — not the dialog, but still 'suspect'", () => {
    // On a pane narrow enough to wrap a label the anchors stop matching, and the
    // pane goes back to reading `dialog` (the pre-fix behaviour: send refuses).
    // That is the safe direction — but `--force` is offered as the way past a
    // refusal, so the weak signal has to keep a forced paste out of the menu.
    const wrapped = RESUME_DIALOG_PLAIN.replace("Resume full session as-is", "Resume full session\n     as-is");
    expect(paneResumeDialogActive(wrapped)).toBe(false);
    expect(paneReadiness(wrapped)).toBe("dialog");
    expect(paneResumeMenuSuspect(wrapped)).toBe(true);
    // Even when BOTH labels wrap and only their heads survive on the numbered
    // lines — the narrow-pane case the signal exists for.
    const bothWrapped = [
      "  ❯ 1. Resume from",
      "     summary (recommended)",
      "    2. Resume full",
      "     session as-is",
      "    3. Don't ask me again",
      "  Enter to confirm · Esc",
      "   to cancel",
    ].join("\n");
    expect(paneResumeDialogActive(bothWrapped)).toBe(false);
    expect(paneResumeMenuSuspect(bothWrapped)).toBe(true);
    // An ordinary question is not suspect — force keeps working everywhere else.
    expect(paneResumeMenuSuspect("  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n  Enter to confirm")).toBe(false);
    // Nor is a LIVE session whose own output quotes the labels: they sit ABOVE
    // its input box, so they're not in the active-menu region at all and
    // `--force` keeps working there exactly as before.
    const quotingSession = [
      "● The resume dialog offers:",
      "    1. Resume from summary (recommended)",
      "    2. Resume full session as-is",
      "─────────────────────────────────────────────",
      "❯ ",
      "─────────────────────────────────────────────",
    ].join("\n");
    expect(paneResumeMenuSuspect(quotingSession)).toBe(false);
  });

  test("REGRESSION GUARD: the numbered LIMIT dialog is untouched (still limited + resume-safe)", () => {
    for (const pane of [LIMIT_DIALOG_PANE, REAL_MENU_PANE, REAL_MENU_PANE_NOTICE_HIDDEN]) {
      expect(paneResumeDialogActive(pane)).toBe(false);
      expect(paneReadiness(pane)).toBe("limited");
      expect(paneLimitDialogActive(pane)).toBe(true);
      expect(paneResumeSafe(pane)).toBe(true);
    }
    // …and the text-form limit panes keep their verdicts too.
    expect(paneReadiness(REAL_ESC_REVEALED_PANE)).toBe("limited");
    expect(paneResumeSafe(REAL_ESC_REVEALED_PANE)).toBe(true);
    expect(paneResumeSafe(REAL_TASK_PANEL_PANE)).toBe(true);
    expect(paneResumeSafe(RECOVERED_PANE)).toBe(false);
  });

  test("the dialog left in SCROLLBACK above an idle box is not active", () => {
    // Once answered, the same three options linger in history with an input box
    // (and its `─` rule) beneath them — the structural demotion isDialog uses.
    const answered = [
      RESUME_DIALOG_PLAIN,
      "● Resumed from summary. Picking the work back up.",
      "─────────────────────────────────────────────",
      "❯ ",
      "─────────────────────────────────────────────",
      "  ? for shortcuts",
    ].join("\n");
    expect(paneResumeDialogActive(answered)).toBe(false);
    expect(paneReadiness(answered)).toBe("ready");
    expect(paneAcceptsPaste(answered)).toBe(true);
  });
});

test.describe("resume dialog: which option agendo picks, and how it presses it", () => {
  test("the default follows claude's own (recommended) MARKER, not option index 1", () => {
    const summary = resumeDialogOption(RESUME_DIALOG_PANE, "summary");
    expect(summary).toEqual({ number: 1, label: "Resume from summary (recommended)", recommended: true, selected: true });
    // Same verdict without colours — the labels are the anchor, not the SGR.
    expect(resumeDialogOption(RESUME_DIALOG_PLAIN, "summary")?.number).toBe(1);

    // Position is NOT what's matched: reorder the menu and the marker still wins.
    const reordered = RESUME_DIALOG_PLAIN.replace("❯ 1. Resume from summary (recommended)", "❯ 1. Resume full session as-is")
      .replace("  2. Resume full session as-is", "  2. Resume from summary (recommended)");
    expect(resumeDialogOption(reordered, "summary")?.number).toBe(2);
    expect(resumeDialogOption(reordered, "as-is")?.number).toBe(1);
  });

  test("the 'as-is' setting picks the full-session option", () => {
    expect(resumeDialogOption(RESUME_DIALOG_PANE, "as-is")).toEqual({
      number: 2,
      label: "Resume full session as-is",
      recommended: false,
      selected: false, // the cursor starts on option 1 — answering has to move it
    });
  });

  test("'Don't ask me again' is never selectable — not even if it wore the marker", () => {
    // It permanently changes the user's global claude CLI behaviour; that's the
    // user's call, not agendo's. Filtered out before the marker is consulted.
    const marked = RESUME_DIALOG_PLAIN.replace("❯ 1. Resume from summary (recommended)", "❯ 1. Resume from summary")
      .replace("3. Don't ask me again", "3. Don't ask me again (recommended)");
    expect(resumeDialogOption(marked, "summary")?.number).toBe(1); // label fallback
    expect(resumeDialogOption(marked, "as-is")?.number).toBe(2);
    for (const choice of ["summary", "as-is"] as const) {
      expect(resumeDialogOption(marked, choice)?.label).not.toMatch(/ask me again/i);
      expect(resumeDialogOption(RESUME_DIALOG_PANE, choice)?.number).not.toBe(3);
    }
  });

  test("a pane with no resume dialog yields no option", () => {
    expect(resumeDialogOption("❯ 1. Yes\n  2. No\nEnter to confirm", "summary")).toBeNull();
  });

  test("answering moves the CURSOR and confirms — it never types the option's number", () => {
    // A digit may activate an option outright on some CLI versions and merely
    // select it on others, which leaves no safe meaning for an Enter after it.
    // Arrows only ever move the highlight, so Enter is unambiguous.
    expect(resumeDialogSelection(RESUME_DIALOG_PANE)?.number).toBe(1);
    expect(resumeDialogStep("cl-claude-abc", 1, 2)).toEqual(["send-keys", "-t", "cl-claude-abc", "Down"]);
    expect(resumeDialogStep("cl-claude-abc", 3, 2)).toEqual(["send-keys", "-t", "cl-claude-abc", "Up"]);
    // Only once the cursor is already ON the wanted option is Enter sent.
    expect(resumeDialogStep("cl-claude-abc", 2, 2)).toEqual(["send-keys", "-t", "cl-claude-abc", "Enter"]);
  });

  test("a menu with no visible cursor is not answerable (and not the dialog)", () => {
    // Without a `❯` there is no way to know where a move would land, so the
    // detector doesn't claim the pane at all.
    const noCursor = RESUME_DIALOG_PLAIN.replace("❯ 1.", "  1.");
    expect(resumeDialogSelection(noCursor)).toBeNull();
    expect(paneResumeDialogActive(noCursor)).toBe(false);
    // …but it IS still suspicious, so a forced send won't paste into it either.
    expect(paneResumeMenuSuspect(noCursor)).toBe(true);
  });

  test("TWO cursors are ambiguous, so the pane is not claimed", () => {
    // With no `─` rule the "active menu" is the whole capture, and claude echoes
    // user prompts with a bare `❯` — a replayed `❯ 1. rerun the failing spec`
    // would add a second selected option and leave a walk anchored on a highlight
    // that isn't the real one.
    const twoCursors = ["❯ 1. rerun the failing spec", RESUME_DIALOG_PLAIN.split("\n").slice(-10).join("\n")].join("\n");
    expect(resumeDialogSelection(twoCursors)).toBeNull();
    expect(paneResumeDialogActive(twoCursors)).toBe(false);
  });

  test("config: the default is the recommended option; 'as-is' is opt-in; junk falls back", () => {
    expect(resumeDialogChoice({ ...DEFAULT_CONFIG })).toBe("summary");
    expect(resumeDialogChoice({ ...DEFAULT_CONFIG, resumeDialogChoice: "as-is" })).toBe("as-is");
    // Hand-edited JSON: an unrecognized value must not leave `send` unable to
    // answer the dialog.
    expect(resumeDialogChoice({ ...DEFAULT_CONFIG, resumeDialogChoice: "dont-ask" as never })).toBe("summary");
  });
});

// GHOST-SUGGESTION fixtures: the same real pane captured three ways (window
// cl-bg-3a8335a284b7, 2026-08-11), stored under e2e/fixtures/. The box rendered
//   ❯ wait for the review, then commit and open the PR
// but NOTHING was typed — that's claude's own greyed-out autocomplete
// suggestion, waiting for Tab. Only the repo path was anonymized; every line the
// classifiers read is byte-for-byte as captured:
//   - ghost-suggestion.ansi        `capture-pane -p -e`: the suggestion wrapped in
//                                  `\e[2m` … `\e[0m` (SGR 2 = faint).
//   - ghost-suggestion-plain.txt   `capture-pane -p`: the SAME screen with the
//                                  escapes discarded — the suggestion is now
//                                  indistinguishable from typed text by color.
//   - ghost-suggestion.cursor      `display-message` readout: cursor_x=2 on
//                                  cursor_y=40 (the box's prompt row) — the caret
//                                  never left the prompt, so nothing was typed.
// A false "dirty" read here is not cosmetic: `agendo send` refuses, and
// `paneResumeSafe` vetoes the auto-resume — silently and permanently, so a
// usage-limited session never resumes hands-off however long it waits.
// NB on what these fixtures do and don't prove: with the escapes intact (what
// `capturePane` always produces today) the COLOR read already handles this exact
// pane, and the tests below pin that. The colour-stripped fixture stands in for
// the palette blind spot that has no verbatim capture: `inputRealText` recognizes
// only the grays it enumerates (256-color 8 / 236-250, truecolor 90-200), so any
// theme drawing suggestions outside them lands agendo in exactly the
// escapes-discarded position this fixture reproduces.
const GHOST_PANE = fullPane("ghost-suggestion.ansi");
const GHOST_PANE_PLAIN = fullPane("ghost-suggestion-plain.txt");
const GHOST_CURSOR_READOUT = fullPane("ghost-suggestion.cursor");
// The caret, parsed from the verbatim readout rather than hard-coded.
const GHOST_CURSOR = (() => {
  const m = GHOST_CURSOR_READOUT.match(/cursor_x=(\d+)\s+cursor_y=(\d+)/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
})();
// The capture also has a sub-agent status row below the box carrying a live
// `↓ 99.9k tokens` counter, so the WHOLE pane legitimately reads "busy" (it was
// waiting on a background agent) and that verdict outranks the input-box read.
// Dropping those trailing rows — and nothing above them, so every row index the
// caret refers to is untouched — exposes the input read the fix is about.
const idlePane = (pane: string) => pane.split("\n").slice(0, 45).join("\n");
const GHOST_IDLE = idlePane(GHOST_PANE);
const GHOST_IDLE_PLAIN = idlePane(GHOST_PANE_PLAIN);
// The same screen with REAL typed text: the identical row minus its `\e[2m`
// (default color = typed), and the caret pushed to the end of what was typed.
const TYPED_TEXT = "wait for the review, then commit and open the PR";
const TYPED_IDLE = GHOST_IDLE.split("\n")
  .map((l, i) => (i === GHOST_CURSOR.y ? l.replace("\x1b[2m", "") : l))
  .join("\n");
const TYPED_CURSOR = { x: GHOST_CURSOR.x + TYPED_TEXT.length, y: GHOST_CURSOR.y };

test.describe("paneReadiness: a greyed-out autocomplete suggestion is NOT typed input", () => {
  test("the raw capture is 'busy' — the sub-agent counter below the box outranks the box", () => {
    // Pinned so the trimming the rest of this block does is honest about what it
    // removes: the busy verdict comes from below the input box, not from it.
    expect(paneReadiness(GHOST_PANE)).toBe("busy");
  });

  test("color signal: the faint suggestion reads 'ready' (no caret needed)", () => {
    expect(paneReadiness(GHOST_IDLE)).toBe("ready");
    expect(paneReadiness(GHOST_IDLE, GHOST_CURSOR)).toBe("ready");
  });

  test("REGRESSION: with the color stripped, only the caret can tell — and it does", () => {
    // The blind spot the caret check exists for. `capture-pane` without `-e`
    // discards the `\e[2m`, and so does any theme/gray the color heuristic
    // doesn't enumerate: the suggestion then looks exactly like a draft.
    expect(paneReadiness(GHOST_IDLE_PLAIN)).toBe("queued"); // color alone: wrong
    // cursor_x=2 is the first cell after `❯ ` — nothing was typed.
    expect(paneReadiness(GHOST_IDLE_PLAIN, GHOST_CURSOR)).toBe("ready");
  });

  test("genuinely typed text still reads 'queued', with or without the caret", () => {
    expect(paneReadiness(TYPED_IDLE)).toBe("queued");
    expect(paneReadiness(TYPED_IDLE, TYPED_CURSOR)).toBe("queued");
    // Same text in a color-blind capture: the caret at the END keeps it dirty.
    expect(paneReadiness(GHOST_IDLE_PLAIN, TYPED_CURSOR)).toBe("queued");
  });

  test("the caret only speaks for the prompt's OWN row", () => {
    // A caret parked anywhere else (a stale/mismatched readout, a multi-line
    // draft whose caret sits on a later row) proves nothing, so the color read
    // stands and the box stays dirty.
    expect(paneReadiness(GHOST_IDLE_PLAIN, { x: GHOST_CURSOR.x, y: GHOST_CURSOR.y - 1 })).toBe("queued");
    expect(paneReadiness(GHOST_IDLE_PLAIN, { x: GHOST_CURSOR.x + 1, y: GHOST_CURSOR.y })).toBe("queued");
    expect(paneReadiness(GHOST_IDLE_PLAIN, null)).toBe("queued");
  });

  test("only the caret's RESTING column counts — column 0 (mid-paint) proves nothing", () => {
    // The caret comes from a second tmux read, so it can be sampled while the TUI
    // is painting, parked at column 0 of a row it's merely passing through. That
    // position is not where an untouched prompt rests, so it must not vouch for
    // the box — otherwise a repaint could hand a real draft a clean verdict.
    expect(paneReadiness(GHOST_IDLE_PLAIN, { x: 0, y: GHOST_CURSOR.y })).toBe("queued");
    expect(paneReadiness(GHOST_IDLE_PLAIN, { x: GHOST_CURSOR.x - 1, y: GHOST_CURSOR.y })).toBe("queued");
    // The resting column still reads clean.
    expect(paneReadiness(GHOST_IDLE_PLAIN, GHOST_CURSOR)).toBe("ready");
  });

  test("an empty box stays 'ready' however the caret is reported", () => {
    const empty = ["  ─────────────────────────────────────────", "  ❯ ", "  ─────────────────────────────────────────"].join("\n");
    expect(paneReadiness(empty)).toBe("ready");
    expect(paneReadiness(empty, { x: 4, y: 1 })).toBe("ready");
    expect(paneReadiness(empty, { x: 99, y: 9 })).toBe("ready");
  });
});

// BUSY-MARKER POSITION. The busy/compacting markers used to be matched against
// `stripAnsi(raw)` — the WHOLE visible pane — but they are facts about the CLI's
// own live status line, not about anything in the transcript. A session whose job
// was to document agendo's detection layer printed a comparison table containing
// `inferred (esc to interrupt, token counter)`, and `agendo list` reported the
// finished, idle session as "busy". `agendo send` refuses a non-ready pane, so the
// session was unreachable until the text scrolled off — the same blocked-forever
// failure #30 fixed by another route, and not exotic here: any session working on
// this file prints these markers.
//
// busy-quoted-marker.*: verbatim `tmux capture-pane` of that pane (session
// codex-support, 2026-08-14), sterilized (home dir → /home/user, ids zeroed) but
// otherwise byte-for-byte — `.ansi` is `-p -e`, `-plain.txt` is `-p`, `.cursor` is
// the `#{cursor_x} #{cursor_y}` readout taken with it.
const QUOTED_PANE = fullPane("busy-quoted-marker.ansi");
const QUOTED_PANE_PLAIN = fullPane("busy-quoted-marker-plain.txt");
const QUOTED_CURSOR = (() => {
  const m = fullPane("busy-quoted-marker.cursor").match(/cursor_x=(\d+)\s+cursor_y=(\d+)/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
})();

test.describe("paneReadiness: busy is read from the live status line, not the transcript", () => {
  test("REAL CAPTURE: an idle pane whose turn output QUOTES 'esc to interrupt' is ready", () => {
    // The bug, verbatim. Was: "busy".
    expect(paneReadiness(QUOTED_PANE)).toBe("ready");
    expect(paneReadiness(QUOTED_PANE, QUOTED_CURSOR)).toBe("ready");
  });

  test("the marker really is on that screen, and really is transcript", () => {
    // Guards the fixture itself: if a future re-sterilization dropped the phrase,
    // the test above would pass for the wrong reason.
    const lines = stripAnsi(QUOTED_PANE).split("\n");
    const marker = lines.findIndex((l) => /esc to interrupt/i.test(l));
    expect(marker).toBeGreaterThan(-1);
    expect(lines[marker]).toContain("│"); // inside a box-drawing table, in a table cell
    // …and it sits far above the input box, not on the status line above it.
    const rule = lines.findLastIndex((l) => /─{20,}/.test(l));
    expect(rule - marker).toBeGreaterThan(30);
    // Nothing else could have produced the verdict: no live counter anywhere.
    expect(stripAnsi(QUOTED_PANE)).not.toMatch(/[↑↓]/);
    expect(stripAnsi(QUOTED_PANE)).not.toMatch(/compacting conversation/i);
  });

  test("the same pane with a LIVE spinner on its status line is busy", () => {
    // The proof that this is positional and not a deletion: put a real spinner
    // where the CLI draws one — the line above the box, here the idle
    // `✻ Churned for 11m 13s` summary — and the very same capture reads "busy".
    const lines = QUOTED_PANE.split("\n");
    // The LAST such row: the status line is by definition the one nearest the box.
    const statusRow = lines.findLastIndex((l) => /Churned for/.test(stripAnsi(l)));
    expect(statusRow).toBeGreaterThan(-1);
    // Replaced in place, so every row index the caret refers to is untouched.
    lines[statusRow] = "✢ Tinkering… (58s · ↓ 3.9k tokens · esc to interrupt)";
    expect(paneReadiness(lines.join("\n"))).toBe("busy");
    expect(paneReadiness(lines.join("\n"), QUOTED_CURSOR)).toBe("busy");
  });

  test("REAL CAPTURE: the color-stripped form needs the caret, and the fix holds there too", () => {
    // Same screen, escapes discarded: the box's dim history suggestion looks like
    // a draft to the color read, so "queued" — but never "busy".
    expect(paneReadiness(QUOTED_PANE_PLAIN)).toBe("queued");
    expect(paneReadiness(QUOTED_PANE_PLAIN, QUOTED_CURSOR)).toBe("ready");
  });

  // Where the marker sits is the whole question, so each band gets pinned.
  const rule = "  ─────────────────────────────────────────";
  const box = [rule, "  ❯ ", rule];
  const pane = (...above: string[]) => [...above, ...box].join("\n");

  test("on the status line directly above the box: busy", () => {
    expect(paneReadiness(pane("  ✢ Tinkering… (58s · ↓ 3.9k tokens)"))).toBe("busy");
    expect(paneReadiness(pane("  ✢ Tinkering… (esc to interrupt)"))).toBe("busy");
  });

  test("in the transcript, with the status line between it and the box: ready", () => {
    expect(
      paneReadiness(
        pane(
          "  │ status │ inferred (esc to interrupt, token counter) │ Ready │",
          "",
          "  ✻ Churned for 11m 13s",
          "",
        ),
      ),
    ).toBe("ready");
  });

  test("in a task-panel item title: ready — the panel is standing UI, not CLI state", () => {
    // Item titles are the user's own words and render between the status line and
    // the box, so they must be skipped rather than read (see taskPanelLines).
    expect(
      paneReadiness(
        pane(
          "  ✻ Churned for 11m 13s",
          "",
          "  3 tasks (1 done, 1 in progress, 1 open)",
          "  ◼ Make 'esc to interrupt' positional",
          "  ◻ Add a regression fixture",
          "  ✔ Read the #30 resume-dialog code",
          "",
        ),
      ),
    ).toBe("ready");
  });

  test("…but a task panel does not HIDE a live spinner above it", () => {
    // The walk skips the panel and keeps going, so the status line is still read.
    expect(
      paneReadiness(
        pane(
          "  ✢ Tinkering… (58s · ↓ 3.9k tokens)",
          "",
          "  3 tasks (1 done, 1 in progress, 1 open)",
          "  ◼ Make 'esc to interrupt' positional",
          "",
        ),
      ),
    ).toBe("busy");
  });

  // The box-side hints are the reason the walk cannot simply stop at the first
  // non-blank line it finds. Both are right-aligned into the gap between the
  // spinner row and the box's top rule — `busy-quoted-marker-plain.txt` line 64 is
  // the context hint, 255 columns wide — so a walk that COLLECTED one would end at
  // the next blank and never reach the spinner two rows up. That misses a live
  // turn, which is the direction that lets `send` paste into a running pane. Found
  // in review, not in the field; these are the probes that failed.
  test("a right-aligned hint between the spinner and the box does not hide it", () => {
    const spinner = "  ✢ Tinkering… (58s · ↓ 3.9k tokens)";
    for (const hint of ["  new task? /clear to save 292.8k tokens", "  ● high · /effort"]) {
      expect(paneReadiness(pane(spinner, hint))).toBe("busy"); // no blank between
      expect(paneReadiness(pane(spinner, "", hint))).toBe("busy"); // and with one
      expect(paneReadiness(pane(spinner, "", hint, ""))).toBe("busy");
    }
  });

  test("hint AND task panel together still do not hide it", () => {
    // The realistic long-session layout: a task list, the context hint, and the
    // spinner three skips up.
    expect(
      paneReadiness(
        pane(
          "  ✢ Tinkering… (58s · ↓ 3.9k tokens)",
          "",
          "  3 tasks (1 done, 1 in progress, 1 open)",
          "  ◼ Make 'esc to interrupt' positional",
          "",
          "  new task? /clear to save 292.8k tokens",
        ),
      ),
    ).toBe("busy");
  });

  test("a hint does not hide mid-compaction either", () => {
    expect(
      paneReadiness(
        pane("  ✻ Compacting conversation…", "  ▰▰▰▱▱▱ 42%", "", "  new task? /clear to save 292.8k tokens"),
      ),
    ).toBe("compacting");
  });

  test("an UNRECOGNIZED task-panel row does not hide the spinner either", () => {
    // The strict taskPanelLines marks only the contiguous run under a header it
    // recognizes, so one odd line used to leave the whole panel looking like content
    // and end the walk. Two things keep it going: the loose header shape, and
    // looksLikeTaskPanelRow for a panel whose header has scrolled off entirely.
    const spinner = "  ✢ Tinkering… (58s · ↓ 3.9k tokens)";
    const rows = ["  ◼ Cache layer + eviction policy", "  ◻ UI: status, counters"];
    // Header wording outside TASK_PANEL_HEADER_RE's vocabulary.
    expect(paneReadiness(pane(spinner, "", "  5 tasks (2 completed, 3 remaining)", ...rows, ""))).toBe("busy");
    // Header wrapped on a narrow pane, so its `$` anchor misses — the leading half
    // still has the shape, so the walk gets past it.
    expect(paneReadiness(pane(spinner, "", "  7 tasks (3 done, 1 in progress,", ...rows, ""))).toBe("busy");
    // No header at all (scrolled off the top of the panel).
    expect(paneReadiness(pane(spinner, "", ...rows, ""))).toBe("busy");
  });

  test("a DONE row is only skippable under a header — and the loose header gives it back", () => {
    // `✔` is both a real done-row glyph (limit-notice-task-panel.ansi:62) and how
    // turn output is bulleted, so it can't be skipped on shape alone without
    // reopening the transcript tunnel. The loose header licenses it positionally
    // instead: a panel whose count is worded outside the strict vocabulary still
    // gets walked past, done rows and all.
    const spinner = "  ✢ Tinkering… (58s · ↓ 3.9k tokens)";
    const rows = [
      "  ◼ Cache layer + eviction policy + write path (priority 1)",
      "  ◻ UI: status, counters, verbose mode",
      "  ✔ Project skeleton that builds a debug binary",
      "  … +2 completed",
    ];
    expect(paneReadiness(pane(spinner, "", "  5 tasks (2 completed, 3 remaining)", ...rows, ""))).toBe("busy");
    expect(paneReadiness(pane(spinner, "", "  3 tasks (3 finished)", "  ✔ Only a done row", ""))).toBe("busy");
    // The strict header still works too — this is the fixture's own wording.
    expect(paneReadiness(pane(spinner, "", "  7 tasks (3 done, 1 in progress, 3 open)", ...rows, ""))).toBe("busy");
  });

  test("compaction progress is read off the bar, not off any percent on screen", () => {
    // The status region deliberately includes the footer BELOW the input box, and
    // that footer is nothing but percentages — so the bar's own `▰`/`▱` blocks are
    // what the reading is anchored on.
    const footer = "  09:14:02 | 29% ctx | 5h: 9% (3h 9m) | 7d: 63% (81h 19m) | Opus 5";
    const compacting = [...box, footer];
    expect(paneCompactionPercent(pane("  ✻ Compacting conversation…", "  ▰▰▰▱▱▱ 42%") + "\n" + footer)).toBe(42);
    // A bar that has only just appeared reports 0 — a real reading, not "none".
    expect(paneCompactionPercent(pane("  ✻ Compacting conversation…", "  ▱▱▱▱▱▱ 0%"))).toBe(0);
    expect(paneCompactionPercent(pane("  ✻ Compacting conversation…", "  ▰▰▰▰▰▰ 100%"))).toBe(100);
    // No bar drawn yet: null, so callers print nothing rather than claim 0%.
    expect(paneCompactionPercent(pane("  ✻ Compacting conversation…"))).toBeNull();
    // The footer's percentages alone must never be mistaken for progress.
    expect(paneCompactionPercent(compacting.join("\n"))).toBeNull();
    // And a transcript that merely draws a bar is history, like every other marker.
    expect(paneCompactionPercent(pane("  ▰▰▰▱▱▱ 42%", "", "  ✻ Churned for 11m 13s", ""))).toBeNull();
  });

  test("KNOWN LIMIT: prose shaped like a panel header licenses the rows under it", () => {
    // The loose header is a shape, so a sentence starting `3 tasks (` opens a run
    // and the permissive glyphs under it become skippable — the walk then reaches a
    // marker quoted above. Accepted, not fixed: it needs a digit-led `N tasks (`
    // line with NO blank and no prose before a contiguous run of glyph rows, all in
    // the gap above the box, with a quoted marker within 3 lines above that — and
    // real turn output puts such a sentence inside a `●` block, whose following
    // lines are indented continuations. The error is also the cheap one: a refused
    // `send` on an idle session, recoverable with `--force`, versus the miss the
    // loose header bought back (`send`/`close` into a running turn).
    const quoted = "  │ status │ inferred (esc to interrupt, token counter) │ Ready │";
    const bullets = ["● a", "● b", "● c"];
    expect(paneReadiness(pane(quoted, "  3 tasks (see below)", ...bullets))).toBe("busy");
    // What the licensing actually requires — either control closes it.
    expect(paneReadiness(pane(quoted, "  3 tasks (see below)", "", ...bullets))).toBe("ready");
    expect(paneReadiness(pane(quoted, "  3 tasks (see below)", "  Here they are:", ...bullets))).toBe("ready");
  });

  test("KNOWN LIMIT: a WRAPPED panel line's tail is shapeless, and does end the walk", () => {
    // Pinned, not endorsed. A continuation row is arbitrary text — `progress, 3
    // open)` here — so nothing distinguishes it from transcript, the run stops
    // there, and a genuinely busy pane reads "ready". Closing it means teaching
    // taskPanelLines about wrapping, which needs a real narrow-pane capture that
    // this repo does not have; the alternative, widening the walk by DISTANCE
    // instead of by run, buys it back at the cost of the false positives this whole
    // change exists to remove. Recorded here so the trade is deliberate and a
    // future fix has a failing case to flip.
    const spinner = "  ✢ Tinkering… (58s · ↓ 3.9k tokens)";
    const wrapped = ["  7 tasks (3 done, 1 in", "  progress, 3 open)", "  ◼ Cache layer"];
    expect(paneReadiness(pane(spinner, "", ...wrapped, ""))).toBe("ready");
  });

  test("a box whose top rule scrolled off falls back to scanning the whole pane", () => {
    // With one rule, inputBox fabricates `top = bottom - 2`, which points at a
    // transcript line, not a boundary — so there is no band to measure and the
    // permissive read stands rather than a made-up one.
    expect(paneReadiness(["  ✢ Tinkering… (58s · ↓ 3.9k tokens)", "  ❯ ", rule].join("\n"))).toBe("busy");
  });

  test("skipping chrome must not tunnel into the transcript", () => {
    // `blockAbove` bounds what it COLLECTS, not how far it descends, so an
    // over-eager skip predicate walks straight past the gap and reads history as
    // status — the original bug, re-entered through the back door. Both blockers
    // below must stop the walk: the chrome row the TUI normally draws…
    const quoted = "  │ status │ inferred (esc to interrupt, token counter) │ Ready │";
    const hint = "  new task? /clear to save 292.8k tokens";
    expect(paneReadiness(pane(quoted, "", "  ✻ Churned for 11m 13s", "", hint))).toBe("ready");
    // …and ordinary bulleted turn output, which wears the glyphs a task-panel row
    // wears (`●`, `✔`, `✗`) and must NOT be skipped for it. Caught in review: with
    // the wide glyph set, all three of these read "busy".
    expect(paneReadiness(pane(quoted, "", "  ● Reviewed the detection layer.", "", hint))).toBe("ready");
    expect(paneReadiness(pane(quoted, "", "  ✔ tests pass", "  ✗ lint failed", "", hint))).toBe("ready");
    expect(paneReadiness(pane(quoted, "", ...Array.from({ length: 12 }, (_, i) => `  ● step ${i}`), "", hint))).toBe("ready");
  });

  test("below the box: busy — nothing under the input box is ever transcript", () => {
    // Both real forms: the footer interrupt hint, and the sub-agent panel's own
    // live counter (a finished turn waiting on a background agent is still busy).
    expect(paneReadiness([...box, "  esc to interrupt"].join("\n"))).toBe("busy");
    expect(paneReadiness([...box, "  ● main", "❯ ◯ general-purpose  Review  5m 39s · ↓ 99.9k tokens"].join("\n"))).toBe("busy");
    // Pinned on the real capture too (this is what makes GHOST_PANE busy).
    expect(paneReadiness(GHOST_PANE)).toBe("busy");
  });

  test("typed INTO the box: queued, not busy — a draft is not a state", () => {
    expect(paneReadiness([rule, "  ❯ why does esc to interrupt match?", rule].join("\n"))).toBe("queued");
  });

  test("compacting is positional the same way", () => {
    expect(paneReadiness(pane("  ✻ Compacting conversation…", "  ▰▰▰▱▱▱ 42%"))).toBe("compacting");
    expect(paneReadiness(pane("  I explained how compacting conversation works.", "", "  ✻ Churned for 2s", ""))).toBe("ready");
  });

  test("with NO input box to anchor on, the whole screen is still scanned", () => {
    // Deliberately permissive: a boxless pane is un-sendable either way (it reads
    // "unknown" at best), so narrowing against rules that may not be a box costs
    // safety for nothing. Both cli.spec's boxless compacting pane and a bare
    // spinner depend on this.
    expect(paneReadiness("✻ Compacting conversation… (esc to interrupt)\n  ▰▰▰▱▱▱ 42%")).toBe("compacting");
    expect(paneReadiness("  ✢ Tinkering… (58s · ↓ 3.9k tokens)")).toBe("busy");
  });
});

// The path that actually costs something when a suggestion reads as a draft:
// auto-resume refuses to fire — silently, and for good: nothing is sent to the
// pane at all, so a usage-limited session never resumes hands-off.
test.describe("paneResumeSafe: a suggestion in the box must not block auto-resume", () => {
  // Caret coordinates are written out rather than recomputed from the pane, so
  // these tests can't share (and cancel out) an off-by-one with the code under
  // test. limit-notice-clear-hint.ansi: the `❯ stop monitoring` row is capture
  // line 92 (0-indexed) and the `❯` starts the line, so the first input cell is
  // column 2 — the same shape the verbatim ghost-suggestion.cursor readout shows.
  const CLEAR_HINT_PROMPT = { x: 2, y: 92 };

  test("REAL CAPTURE: the faint 'stop monitoring' history suggestion keeps resume safe", () => {
    // Already true from color alone; pinned again with the caret to prove the
    // second signal doesn't disturb it.
    expect(paneResumeSafe(REAL_CLEAR_HINT_PANE)).toBe(true);
    expect(paneResumeSafe(REAL_CLEAR_HINT_PANE, CLEAR_HINT_PROMPT)).toBe(true);
  });

  test("REGRESSION: with the color stripped, the caret is what keeps resume safe", () => {
    // Same limited pane, no SGR to read: the suggestion looks like a draft, so
    // resume refused to fire and the session sat at its limit forever.
    const colorBlind = stripAnsi(REAL_CLEAR_HINT_PANE);
    expect(paneUsageLimited(colorBlind)).toBe(true);
    expect(paneResumeSafe(colorBlind)).toBe(false); // color alone: wrong
    expect(paneResumeSafe(colorBlind, CLEAR_HINT_PROMPT)).toBe(true);
  });

  test("a real draft in a limited box still blocks resume", () => {
    // The guarantee auto-resume must not lose: `<esc>continue<enter>` would wipe
    // a prompt the user queued for after the reset.
    const draft = [
      "  Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).",
      "  ─────────────────────────────────────────",
      "  ❯ run the migration once we are back",
      "  ─────────────────────────────────────────",
    ].join("\n");
    // The `❯` sits at column 2 of capture line 2, so the first input cell is 4.
    expect(paneResumeSafe(draft)).toBe(false);
    // Caret at the end of the draft — where typing leaves it.
    expect(paneResumeSafe(draft, { x: 4 + "run the migration once we are back".length, y: 2 })).toBe(false);
  });

  test("a MULTI-ROW draft is never overruled by the caret, wherever it was parked", () => {
    // The caret can only vouch for a box whose other rows are blank (see
    // onlyPromptRow): a draft continued onto a second row stays dirty even with
    // the caret parked back at the prompt column — the Home/Ctrl-A (or vim `0`)
    // case, which is the one way the caret signal could clobber a real draft.
    const draft = [
      "  Claude usage limit reached. Your limit will reset at 3pm (America/Santiago).",
      "  ─────────────────────────────────────────",
      "  ❯ run the migration once we are back",
      "    and then re-run the smoke tests",
      "  ─────────────────────────────────────────",
    ].join("\n");
    expect(paneResumeSafe(draft, { x: 4, y: 2 })).toBe(false);
    expect(paneReadiness(draft.split("\n").slice(1).join("\n"), { x: 4, y: 1 })).toBe("queued");
  });
});

// CODEX fixtures: raw `tmux capture-pane -p -e` output plus the matching
// `#{cursor_x} #{cursor_y}` readout, captured live from Codex CLI v0.147.0
// running under `--approve-for-me` (window agendo:26, 2026-08-13). The only
// edit is length-preserving anonymization of the home path in the transcript
// body (`kristjan` → `someuser`, 8 chars either way, so every column stays put);
// the footer, the status line and the input box are byte-for-byte as captured.
//   - codex-idle.ansi           settled between turns: footer `… · Ready · …`,
//                               the box holding codex's DIM rotating example
//                               ("Summarize recent commits") — not typed text.
//   - codex-draft.ansi          the same box with a real 55-char prompt typed
//                               and not yet submitted; caret pushed to its end.
//   - codex-busy.ansi           25s into a 67s turn: footer `Working`, and the
//                               status line `• Working (25s • esc to interrupt)`
//                               above the box. The box still shows the dim
//                               placeholder — an empty-LOOKING box mid-turn.
//   - codex-busy-approval.ansi  the same turn while `--approve-for-me`'s
//                               automatic reviewer runs: the status line reads
//                               `• Reviewing approval request (2s • esc to
//                               interrupt)`. The verb changes; the shape doesn't.
//   - codex-done.ansi           the turn finished: footer back to `Ready`, and
//                               the completion marker `─ Worked for 1m 06s ───`
//                               where the counter used to be — no interrupt hint.
//   - codex-dialog.ansi         `/statusline` open: the field checkboxes (which
//                               is how run-state can be switched off) over a
//                               footer that still says `Ready`, and codex's own
//                               "enter to confirm and close; esc to close" line.
// The caret is deliberately NOT a busy signal here: it read `2 66` on every
// frame of the turn, busy and idle alike. It still speaks for the input box.
const codexCursor = (name: string) => {
  const m = fullPane(name).trim().match(/^(\d+)\s+(\d+)$/)!;
  return { x: Number(m[1]), y: Number(m[2]) };
};

/**
 * Simulate `/statusline` unchecking the run-state field: blank the run-state
 * WORD out of the footer line only. It is SGR-wrapped, so a plain string
 * replace over the capture misses it — match it between its escapes. Every
 * caller asserts the edit actually took, so a silently-missed edit can't turn
 * one of these into a test that passes for the wrong reason.
 */
const dropRunState = (raw: string) => {
  const lines = raw.replace(/\r/g, "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!stripAnsi(lines[i]).trim()) continue;
    lines[i] = lines[i].replace(/(\x1b\[[0-9;]*m)(Ready|Working|Thinking)(?=\x1b)/g, "$1");
    break;
  }
  const out = lines.join("\n");
  const footer = stripAnsi(out).split("\n").filter((l) => l.trim()).pop() ?? "";
  expect(footer, "the run-state word must be gone from the footer").not.toMatch(/\b(Ready|Working|Thinking)\b/);
  return out;
};

test.describe("paneReadiness: Codex CLI panes (real captures)", () => {
  test("settled between turns reads 'ready' — the dim example prompt is not a draft", () => {
    // Codex parks a rotating suggestion in the box; treating it as typed text
    // would make `agendo send` refuse forever on an idle session.
    expect(paneReadiness(fullPane("codex-idle.ansi"))).toBe("ready");
    expect(paneReadiness(fullPane("codex-idle.ansi"), codexCursor("codex-idle.cursor"))).toBe("ready");
  });

  test("a real typed prompt reads 'queued'", () => {
    expect(paneReadiness(fullPane("codex-draft.ansi"))).toBe("queued");
    expect(paneReadiness(fullPane("codex-draft.ansi"), codexCursor("codex-draft.cursor"))).toBe("queued");
  });

  test("mid-turn reads 'busy' even though the box looks empty", () => {
    // The trap this pins: codex ACCEPTS typing mid-turn (it queues it), so the
    // box being empty is not permission to send. The footer and status line are.
    expect(paneReadiness(fullPane("codex-busy.ansi"))).toBe("busy");
    expect(paneReadiness(fullPane("codex-busy.ansi"), codexCursor("codex-busy.cursor"))).toBe("busy");
  });

  test("the busy status line is matched by SHAPE, not by verb", () => {
    // `--approve-for-me` swaps `Working` for `Reviewing approval request` while
    // its classifier vets a command. Matching the verb list read those 16 frames
    // as a gap in the turn; matching the counter + interrupt hint does not.
    const approval = fullPane("codex-busy-approval.ansi");
    expect(stripAnsi(approval)).toContain("Reviewing approval request");
    expect(paneReadiness(approval)).toBe("busy");
    expect(paneReadiness(approval, codexCursor("codex-busy-approval.cursor"))).toBe("busy");
  });

  test("the finished-turn marker is not a live counter — the settled pane reads 'ready'", () => {
    // `─ Worked for 1m 06s ───` carries an elapsed time but no interrupt hint,
    // which is exactly what keeps it out of the busy match.
    const done = fullPane("codex-done.ansi");
    expect(stripAnsi(done)).toContain("Worked for 1m 06s");
    expect(paneReadiness(done)).toBe("ready");
    expect(paneReadiness(done, codexCursor("codex-done.cursor"))).toBe("ready");
  });

  test("an open dialog reads 'dialog' even with the footer still saying 'Ready'", () => {
    // The `/statusline` picker replaces the input box; the footer underneath is
    // unchanged, so the dialog check has to outrank the run-state read.
    expect(stripAnsi(fullPane("codex-dialog.ansi"))).toContain("Ready");
    expect(paneReadiness(fullPane("codex-dialog.ansi"))).toBe("dialog");
    expect(paneReadiness(fullPane("codex-dialog.ansi"), codexCursor("codex-dialog.cursor"))).toBe("dialog");
  });

  test("the status line alone proves busy when the footer's run-state is switched off", () => {
    // `/statusline` is a checkbox list, so run-state is optional. With it off,
    // a running turn is still unambiguous from the line above the box.
    expect(paneReadiness(dropRunState(fullPane("codex-busy.ansi")))).toBe("busy");
    expect(paneReadiness(dropRunState(fullPane("codex-busy-approval.ansi")))).toBe("busy");
  });

  test("with run-state off, an IDLE pane degrades to 'unknown' — never to 'ready'", () => {
    // The asymmetry the classifier is built around: "ready" is only ever
    // returned on the positive evidence of the footer saying `Ready`. Guessing
    // here would inject a prompt into a session that may well be working.
    expect(paneReadiness(dropRunState(fullPane("codex-idle.ansi")))).toBe("unknown");
    expect(paneReadiness(dropRunState(fullPane("codex-done.ansi")))).toBe("unknown");
    // And with the caret vouching for an empty box, still unknown — the caret
    // speaks for the box, not for whether the model is working.
    expect(paneReadiness(dropRunState(fullPane("codex-idle.ansi")), codexCursor("codex-idle.cursor"))).toBe("unknown");
  });

  test("the run-state word only counts as a whole footer field", () => {
    // Otherwise any transcript line quoting "Working" would fake a busy pane —
    // and any pane whose prose ends in "Ready" would fake a sendable one.
    const idle = fullPane("codex-idle.ansi").split("\n");
    // Slipped in as the last transcript line, directly above the input box.
    const boxRow = idle.length - 1 - [...idle].reverse().findIndex((l) => l.includes("›"));
    const withProse = [
      ...idle.slice(0, boxRow),
      "  • Working on the parser, then Ready to review",
      ...idle.slice(boxRow),
    ].join("\n");
    expect(paneReadiness(withProse)).toBe("ready");
  });

  test("REGRESSION: a codex transcript that QUOTES the busy line is not busy", () => {
    // The codex half of the bug #33 fixed for claude (see the busy-quoted-marker
    // block below). The busy line is a fact about codex's live status region, not
    // about anything in the scrollback — and it is exactly the sort of string that
    // gets pasted around: any session working on THIS file prints it.
    //
    // Synthesized rather than captured: there is no real codex pane quoting its
    // own marker, so it is spliced into the idle capture's transcript (row 8, far
    // above the box) with everything else left byte-for-byte. Codex writes its
    // transcript as `• …` bullets, so a turn describing the marker reproduces the
    // exact leading shape the matcher keys on — which is the point: this must be
    // a line the whole-pane scan WOULD have matched. Before the status region was
    // anchored, it read "busy".
    const quotedLine = "  • The busy marker is `• Working (25s • esc to interrupt)` above the box.";
    expect(quotedLine).toMatch(/^[ \t]*•[^\n]*\(\s*\d+s\b[^\n]*\besc to interrupt\b/);
    const idle = fullPane("codex-idle.ansi").split("\n");
    const boxRow = idle.length - 1 - [...idle].reverse().findIndex((l) => l.includes("›"));
    const quoted = [...idle.slice(0, 8), quotedLine, ...idle.slice(8)].join("\n");
    // …and it really is transcript: far above the box, not in the status region.
    expect(boxRow - 8).toBeGreaterThan(10);
    expect(paneReadiness(quoted)).toBe("ready");
    // The splice pushed every row below it down one, so the caret readout has to
    // follow or it would be vouching for the wrong row.
    const caret = codexCursor("codex-idle.cursor");
    expect(paneReadiness(quoted, { x: caret.x, y: caret.y + 1 })).toBe("ready");
  });

  test("the status walk reaches a busy line the approval reviewer pushed off the box", () => {
    // The other direction, and the one that fails dangerous: the walk must not
    // stop short of the status line. `--approve-for-me` draws a `└ /bin/bash -lc
    // …` detail row BETWEEN the busy line and the box, so a walk collecting only
    // the row nearest the box would see the detail row and call the pane ready.
    const approval = stripAnsi(fullPane("codex-busy-approval.ansi")).split("\n");
    const busyRow = approval.findIndex((l) => /Reviewing approval request/.test(l));
    const boxRow = approval.length - 1 - [...approval].reverse().findIndex((l) => l.includes("›"));
    // Pins the geometry the verdict depends on: the marker is genuinely separated
    // from the box, so "busy" here is the walk working, not the marker being adjacent.
    expect(approval[busyRow + 1]).toContain("└");
    expect(boxRow - busyRow).toBeGreaterThan(2);
    expect(paneReadiness(fullPane("codex-busy-approval.ansi"))).toBe("busy");
  });

  test("claude panes are not hijacked by the codex path", () => {
    // codexPane sniffs the CONTENT (the window name never carries the agent for
    // a `cl-wi-…` window), so the two classifiers share every capture. These are
    // the verdicts the claude fixtures had before codex existed.
    expect(paneReadiness(GHOST_PANE)).toBe("busy");
    expect(paneReadiness(REAL_CLEAR_HINT_PANE)).toBe("limited");
    expect(paneReadiness(REAL_MENU_PANE)).toBe("limited");
  });
});

// CODEX USAGE-LIMIT fixtures: raw `tmux capture-pane -p -e` output plus the
// matching `#{cursor_x} #{cursor_y}` readout, captured live from a REAL capped
// account (codex v0.148.0, `gpt-5.6-sol high`, pane 383x96, 2026-08-20) during a
// single `codex resume`. Sterilized — home dir → /home/user, session id zeroed,
// the two long user prompts in scrollback replaced with filler — but the footer,
// the notice and the dialogs are byte-for-byte as captured. Five states, in the
// order the resume produced them:
//   - codex-trust.ansi              codex's own folder-trust prompt.
//   - codex-resume-cwd.ansi         codex's own "which working directory?" resume
//                                   prompt — the analogue of claude's resume
//                                   dialog, and it means NO turn has run yet.
//   - codex-limit-idle.ansi         capped, idle at the input box. THE one: the
//                                   footer reads `Ready` AND `weekly 0% left`.
//   - codex-limit-model-switch.ansi capped, a message sent, codex's "Approaching
//                                   rate limits / Switch to gpt-5.6-luna?" menu
//                                   raised. NO footer — the dialog replaces it.
//   - codex-limit-dismissed.ansi    that menu dismissed with Esc: back to the
//                                   codex-limit-idle shape.
// See docs/codex-usage-limits.md for the full reasoning. In short: the footer's
// run-state word LIES (`Ready` at a hard cap), the truth is a different field of
// that same line (`weekly 0% left`), the reset time is a wall-clock time of day
// rather than a countdown and can already be past, and the `■ You've hit your
// usage limit…` notice is TRANSCRIPT — it scrolls, so detection must not need it.
//
// Codex's selection marker is `›` (U+203A), not claude's `❯` — the same glyph it
// uses for the input-box prompt.

/** The `■ You've hit your usage limit…` notice, read out of a fixture rather than
 *  retyped, so a re-sterilization that changed the wording can't leave these
 *  tests asserting against a string the fixture no longer contains. */
const codexLimitNotice = (name: string) => {
  const line = stripAnsi(fullPane(name)).split("\n").find((l) => /hit your usage limit/i.test(l));
  expect(line, `${name} must carry the usage-limit notice`).toBeTruthy();
  return line!.trim();
};

/**
 * Rewrite the footer's quota field — `weekly 0% left` ⇄ `weekly 99% left` — on a
 * real capture. The field is contiguous inside its SGR run, so a plain replace
 * reaches it; every caller asserts the edit took, so a silently-missed edit can't
 * turn one of these into a test that passes for the wrong reason.
 *
 * Used in BOTH directions on purpose. Patching a healthy capture down to `0%`
 * proves the footer alone is sufficient evidence (that pane has no notice on
 * screen at all); patching a capped one back up proves the notice alone is not.
 */
const patchQuota = (raw: string, from: string, to: string) => {
  expect(stripAnsi(raw), `the capture must carry the quota field "${from}"`).toContain(from);
  const out = raw.replaceAll(from, to);
  expect(stripAnsi(out)).toContain(to);
  expect(stripAnsi(out)).not.toContain(from);
  return out;
};

test.describe("paneReadiness: Codex CLI usage limits (real captures)", () => {
  test("the footer states two contradictory things on one line", () => {
    // The fixture guard the whole design rests on. `Ready` and `weekly 0% left`
    // are separate ` · ` fields of the SAME status bar, and it is their
    // DISAGREEMENT that identifies the state — neither field alone can.
    for (const name of ["codex-limit-idle.ansi", "codex-limit-dismissed.ansi"]) {
      const footer = stripAnsi(fullPane(name)).split("\n").filter((l) => l.trim()).pop()!;
      const fields = footer.split(" · ").map((f) => f.trim());
      expect(fields, name).toContain("Ready");
      expect(fields, name).toContain("weekly 0% left");
    }
    // …and every healthy codex capture in this repo carries the same field with a
    // healthy value, which is what makes `0% left` a discriminator rather than a
    // marker. Without this, "has a quota field" would look like a cap signal.
    for (const name of ["codex-idle.ansi", "codex-draft.ansi", "codex-busy.ansi", "codex-busy-approval.ansi", "codex-done.ansi"]) {
      const footer = stripAnsi(fullPane(name)).split("\n").filter((l) => l.trim()).pop()!;
      expect(footer, name).toMatch(/\bweekly (?:9\d|100)% left\b/);
    }
    // And NOT via colour: codex paints `weekly 0% left` and `weekly 99% left` in
    // the same pink, so the SGR run is no help and the text is all there is.
    const colour = /\x1b\[38;2;233;144;169m(weekly \d+% left)/;
    expect(fullPane("codex-limit-idle.ansi")).toMatch(colour);
    expect(fullPane("codex-idle.ansi")).toMatch(colour);
  });

  test("a healthy idle codex pane still reads 'ready'", () => {
    // The negative case a fix must not break. `codex-idle` sits at `weekly 99%
    // left`; treating the field's presence (rather than its value) as a cap would
    // make every codex session permanently unsendable.
    expect(stripAnsi(fullPane("codex-idle.ansi"))).toContain("weekly 99% left");
    expect(paneReadiness(fullPane("codex-idle.ansi"), codexCursor("codex-idle.cursor"))).toBe("ready");
    expect(paneAcceptsPaste(fullPane("codex-idle.ansi"), codexCursor("codex-idle.cursor"))).toBe(true);
    // Nothing pins where between 99% and 0% the field stops meaning "fine" — no
    // capture exists at a low-but-nonzero quota (see the gaps in
    // docs/codex-usage-limits.md). The assumption under test is that ONLY a
    // literal `0% left` is a cap, so a merely low quota stays sendable.
    for (const quota of ["weekly 9% left", "weekly 1% left"]) {
      const low = patchQuota(fullPane("codex-idle.ansi"), "weekly 99% left", quota);
      expect(paneReadiness(low, codexCursor("codex-idle.cursor")), quota).toBe("ready");
    }
  });

  test("a recovered footer outranks a limit notice left in scrollback", () => {
    // The notice is TRANSCRIPT: it stays on screen after the quota rolls over.
    // So a detector keyed on the notice would report a recovered session as
    // limited forever — the codex form of the staleness `paneUsageLimited`'s
    // last-content-block walk exists to avoid on the claude side.
    const recovered = patchQuota(fullPane("codex-limit-idle.ansi"), "weekly 0% left", "weekly 96% left");
    expect(stripAnsi(recovered)).toContain("hit your usage limit");
    expect(paneReadiness(recovered, codexCursor("codex-limit-idle.cursor"))).toBe("ready");
    expect(paneUsageLimited(recovered)).toBe(false);
  });

  test("busy outranks the quota field", () => {
    // Precedence: a session that is GENERATING is busy, whatever the quota field
    // says — same order as the claude path, where paneUsageLimited is checked
    // after the busy read. Synthesized (no capture exists of a busy pane at a
    // cap; see docs/codex-usage-limits.md), so this pins the intended ordering
    // rather than an observed one.
    const busyCapped = patchQuota(fullPane("codex-busy.ansi"), "weekly 95% left", "weekly 0% left");
    expect(paneReadiness(busyCapped, codexCursor("codex-busy.cursor"))).toBe("busy");
  });

  test("codex's own startup prompts are the CLI asking, not the agent asking", () => {
    // Neither the folder-trust prompt nor the resume-cwd prompt is a question
    // about the WORK — codex is asking how to start. They are never `ready`,
    // never paste-safe (a message pasted into either picks a numbered option),
    // and carry no cap of their own.
    for (const state of ["trust", "resume-cwd"]) {
      const raw = fullPane(`codex-${state}.ansi`);
      const cursor = codexCursor(`codex-${state}.cursor`);
      // The `›` selection cursor on option 1 — codex's marker, not claude's `❯`.
      expect(stripAnsi(raw), state).toMatch(/^›\s*1\./m);
      expect(paneReadiness(raw, cursor), state).not.toBe("ready");
      expect(paneAcceptsPaste(raw, cursor), state).toBe(false);
      expect(paneResumeSafe(raw, cursor), state).toBe(false);
      expect(paneUsageLimited(raw), state).toBe(false);
    }
  });

  test("the model-switch menu is never safe to paste into", () => {
    // The safety floor for state 04, and it holds TODAY (via the generic dialog
    // check) — pinned so a limit-detection change can't cost it. sendToPane is
    // keystroke injection plus Enter: a message containing `1` switches the
    // user's model, and `3` permanently suppresses future rate-limit warnings.
    const raw = fullPane("codex-limit-model-switch.ansi");
    const plain = stripAnsi(raw);
    expect(plain).toContain("Approaching rate limits");
    expect(plain).toMatch(/^›\s*1\.\s+Switch to /m);
    expect(plain).toMatch(/^\s*3\.\s+Keep current model \(never show again\)/m);
    const cursor = codexCursor("codex-limit-model-switch.cursor");
    expect(paneReadiness(raw, cursor)).not.toBe("ready");
    expect(paneAcceptsPaste(raw, cursor)).toBe(false);
    // The resume keystrokes lead with Escape, which HERE is this dialog's own
    // "esc to go back" — and the `continue` + Enter behind it would land in
    // whatever the Escape revealed. No codex pane is resume-safe yet.
    expect(paneResumeSafe(raw, cursor)).toBe(false);
  });

  test("capped and idle reads 'limited', not 'ready'", () => {
    test.fixme(true, "Codex usage-limit detection is not implemented — see docs/codex-usage-limits.md");
    const raw = fullPane("codex-limit-idle.ansi");
    const cursor = codexCursor("codex-limit-idle.cursor");
    // The footer's own run-state word says `Ready`; the account is capped. Today
    // paneReadiness believes the word, and paneAcceptsPaste therefore returns
    // TRUE — `agendo send` delivers straight into a session that cannot answer.
    expect(stripAnsi(raw)).toContain("Ready");
    expect(paneUsageLimited(raw)).toBe(true);
    expect(paneReadiness(raw, cursor)).toBe("limited");
    expect(paneReadiness(raw)).toBe("limited");
    expect(paneAcceptsPaste(raw, cursor)).toBe(false);
  });

  test("dismissing the model-switch menu leaves it capped, not ready", () => {
    test.fixme(true, "Codex usage-limit detection is not implemented — see docs/codex-usage-limits.md");
    // Esc is a safe dismissal — it returns the pane to the codex-limit-idle
    // shape. Nothing about the cap changed, so neither may the verdict.
    const raw = fullPane("codex-limit-dismissed.ansi");
    const cursor = codexCursor("codex-limit-dismissed.cursor");
    expect(paneUsageLimited(raw)).toBe(true);
    expect(paneReadiness(raw, cursor)).toBe("limited");
    expect(paneAcceptsPaste(raw, cursor)).toBe(false);
  });

  test("the model-switch menu is a LIMIT state, not merely a dialog", () => {
    test.fixme(true, "Codex usage-limit detection is not implemented — see docs/codex-usage-limits.md");
    // Today this reads `dialog` — safe by luck, not by detection: nothing knows
    // the session is capped, so `agendo status` shows no cap and `agendo wait`
    // never wakes with `blocked`. It must read `limited`, which on the claude
    // path already outranks `dialog`.
    //
    // The structural wrinkle: this state has NO footer status bar (the dialog
    // replaces it), so `codexFooter` rejects the pane and `codexPane` returns
    // null — the capture never reaches `codexReadiness` at all. Codex limit
    // detection cannot live only inside that classifier.
    const raw = fullPane("codex-limit-model-switch.ansi");
    const footer = stripAnsi(raw).split("\n").filter((l) => l.trim()).pop()!;
    expect(footer.split(" · ").length, "no status bar to read a quota field from").toBe(1);
    expect(paneUsageLimited(raw)).toBe(true);
    expect(paneReadiness(raw, codexCursor("codex-limit-model-switch.cursor"))).toBe("limited");
  });

  test("the footer quota field alone is enough — with no notice on screen", () => {
    test.fixme(true, "Codex usage-limit detection is not implemented — see docs/codex-usage-limits.md");
    // The load-bearing claim of the design: the notice SCROLLS, so once it is
    // gone `weekly 0% left` is the only evidence left, and it must suffice.
    // `codex-idle` is a healthy capture with no notice anywhere in it; drop its
    // quota to zero and the pane must read limited on the footer alone.
    const capped = patchQuota(fullPane("codex-idle.ansi"), "weekly 99% left", "weekly 0% left");
    expect(stripAnsi(capped)).not.toMatch(/usage limit/i);
    expect(paneUsageLimited(capped)).toBe(true);
    expect(paneReadiness(capped, codexCursor("codex-idle.cursor"))).toBe("limited");
  });

  test("a limit notice replayed above the resume-cwd prompt is the PREVIOUS run", () => {
    test.fixme(true, "Codex usage-limit detection is not implemented — see docs/codex-usage-limits.md");
    // The codex analogue of paneResumeDialogActive's whole reason for existing
    // (#30). A session parked at "which working directory?" has run NO turn yet;
    // everything above the prompt is the previous run's replayed transcript, and
    // that transcript routinely ends in the very notice that made the user
    // resume. Judged as current state it reads `limited` today — so `agendo
    // status` would print a stale reset time and `agendo wait` would never
    // settle, which is the blocked-forever reporting this must not reintroduce.
    const notice = codexLimitNotice("codex-limit-idle.ansi");
    const replayed = [notice, "", fullPane("codex-resume-cwd.ansi")].join("\n");
    expect(stripAnsi(replayed)).toContain("hit your usage limit");
    expect(paneReadiness(replayed, codexCursor("codex-resume-cwd.cursor"))).not.toBe("limited");
    expect(paneUsageLimited(replayed)).toBe(false);
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

  test("REGRESSION: the anchor never reads a time off the NEXT line", () => {
    // The limit DIALOG has no reset time (it hides it), yet its own option line
    // ends in "…wait for limit to reset". If the anchor could cross the newline,
    // any clock time on the following line would be reported as the reset — and
    // `agendo list` would print that fabricated time next to "limited".
    const now = new Date("2026-06-15T12:00:00Z");
    const dialog = [
      "❯ 1. Stop and wait for limit to reset",
      "  2. Add funds at 4:30pm to continue with usage credits",
    ].join("\n");
    expect(parseResetTime(dialog, now)).toBeNull();
    // Same for ordinary scrollback: a bare `git reset` ending its line, with an
    // unrelated log timestamp beneath it (the old anchor returned 14:05 here).
    expect(parseResetTime("$ git reset\n[14:05] rebuilt in 3s", now)).toBeNull();
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

  test("REGRESSION (L1): a bare time hours before now rolls to TOMORROW, not 'act now'", () => {
    // 23:00 + "resets 1am": today's 1am is 22h in the past. The 8-day weekly
    // lookback must NOT treat it as just-reopened (which fired auto-resume into a
    // still-limited session, burning the one shot) — it names tomorrow's 1am.
    const now = new Date(2026, 5, 15, 23, 0); // 11pm local
    const at = parseResetTime("Your limit will reset at 1am.", now, RESET_LOOKBACK_MS);
    const d = new Date(at!);
    expect(d.getDate()).toBe(16); // tomorrow
    expect(d.getHours()).toBe(1);
    expect(at!).toBeGreaterThan(now.getTime());
    // …so an auto-resume gated on this reset does NOT fire now (would burn the shot).
    expect(
      shouldAutoResume({ enabled: true, readiness: "limited", resetAt: at, now: now.getTime(), firedFor: null }),
    ).toBe(false);
  });

  test("a bare time only a couple hours past (5-hour cap just reopened) still acts now", () => {
    // 2am + "resets 1am": 1h ago, within the 6h bare-time lookback → the lingering
    // notice of a just-reopened 5-hour window resolves to the past instant.
    const now = new Date(2026, 5, 15, 2, 0); // 2am local
    const at = parseResetTime("Your limit will reset at 1am.", now, RESET_LOOKBACK_MS);
    const d = new Date(at!);
    expect(d.getDate()).toBe(15); // today (already reopened)
    expect(d.getHours()).toBe(1);
    expect(at!).toBeLessThan(now.getTime());
  });
});

test.describe("parseResetTime: Codex's `try again at <time>` wording", () => {
  test("the reset time parses out of the codex notice", () => {
    test.fixme(true, "parseResetTime has no codex arm — see docs/codex-usage-limits.md");
    // Claude says "Your limit will reset at 3pm (America/Santiago)"; codex says
    // "…or try again at 1:22 PM." — no `reset` anchor, no timezone. parseResetTime
    // returns null on it today, which leaves resetAt unknown and auto-resume
    // unreachable even once the pane classifies as limited.
    const notice = codexLimitNotice("codex-limit-idle.ansi");
    expect(notice).toContain("try again at 1:22 PM");
    // 09:00 local, before the stated reset → today at 13:22, still ahead.
    const before = new Date(2026, 4, 15, 9, 0);
    const at = parseResetTime(notice, before, RESET_LOOKBACK_MS);
    expect(at).not.toBeNull();
    expect(at!).toBe(new Date(2026, 4, 15, 13, 22).getTime());
    // …and the pane-level read agrees, since that's what callers actually use.
    expect(paneResetAt(stripAnsi(fullPane("codex-limit-idle.ansi")), before)).toBe(at);
  });

  test("an already-past reset does not report an indefinite live limit", () => {
    test.fixme(true, "parseResetTime has no codex arm — see docs/codex-usage-limits.md");
    // The hazard this capture demonstrates in the wild: it was taken at 10:14 the
    // morning AFTER the notice was printed, so `1:22 PM` was already long past
    // while the notice sat on screen. Two rules, both already established for
    // claude's bare-time form and inherited unchanged here:
    const notice = codexLimitNotice("codex-limit-idle.ansi");
    // (a) JUST past — inside BARE_TIME_LOOKBACK_MS — is returned as-is, so the
    //     caller can act now rather than waiting another whole day.
    const justAfter = new Date(2026, 4, 15, 14, 30);
    const recent = parseResetTime(notice, justAfter, RESET_LOOKBACK_MS);
    expect(recent).toBe(new Date(2026, 4, 15, 13, 22).getTime());
    expect(recent!).toBeLessThan(justAfter.getTime());
    // (b) LONG past — beyond that lookback — rolls forward to tomorrow rather
    //     than being handed back as a stale instant that would fire auto-resume
    //     into a session which is still capped.
    const longAfter = new Date(2026, 4, 15, 23, 0);
    const rolled = parseResetTime(notice, longAfter, RESET_LOOKBACK_MS);
    expect(rolled).toBe(new Date(2026, 4, 16, 13, 22).getTime());
    expect(rolled!).toBeGreaterThan(longAfter.getTime());
    // And the liveness verdict never comes from the notice regardless: the pane
    // above stays limited only while its FOOTER says so. A past reset time on a
    // still-capped footer is limited; the same past time over a recovered footer
    // is not. Neither reading is "limited forever because a clock time elapsed".
    const stillCapped = fullPane("codex-limit-idle.ansi");
    const recovered = patchQuota(stillCapped, "weekly 0% left", "weekly 96% left");
    expect(paneUsageLimited(stillCapped)).toBe(true);
    expect(paneUsageLimited(recovered)).toBe(false);
  });
});

// How a parsed reset instant is SHOWN. Bun's default Intl locale is a hardcoded
// en-US whatever the environment says, so the display locale is resolved from the
// POSIX locale vars instead — otherwise a 24-hour user would always be handed
// 12-hour times. The env is passed in explicitly here (no process.env mutation),
// which is also how the CLI e2e pins its expected output.
test.describe("envLocale / formatResetTime: the reset clock a human sees", () => {
  const at = new Date("2026-06-15T15:00:00Z").getTime();

  test("POSIX locale vars map to BCP-47, most specific first", () => {
    expect(envLocale({ LANG: "en_GB.UTF-8" })).toBe("en-GB");
    expect(envLocale({ LC_ALL: "de_DE.UTF-8@euro", LC_TIME: "fr_FR.UTF-8", LANG: "en_US.UTF-8" })).toBe("de-DE");
    expect(envLocale({ LC_TIME: "nb_NO.UTF-8", LANG: "en_US.UTF-8" })).toBe("nb-NO");
  });

  test("no usable locale → undefined (caller falls back to the runtime default)", () => {
    expect(envLocale({})).toBeUndefined();
    expect(envLocale({ LANG: "C" })).toBeUndefined();
    expect(envLocale({ LC_ALL: "POSIX" })).toBeUndefined();
    expect(envLocale({ LANG: "xx_YY.UTF-8" })).toBeUndefined(); // well-formed, unknown to ICU
    expect(envLocale({ LANG: "en--GB" })).toBeUndefined(); // malformed: must not throw
  });

  test("the locale — not hand-rolled am/pm — decides 24h vs 12h", () => {
    const gb = formatResetTime(at, { LC_ALL: "en_GB.UTF-8" });
    const us = formatResetTime(at, { LC_ALL: "en_US.UTF-8" });
    expect(gb).not.toMatch(/[AP]M/i); // 24-hour locale: no meridiem at all
    expect(us).toMatch(/[AP]M/i);
    // Time only, both ways — no date, so it fits beside a readiness word.
    for (const s of [gb, us]) {
      expect(s).toMatch(/\d{1,2}:\d{2}/);
      expect(s).not.toMatch(/2026|Jun/i);
    }
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
    const sessionDerived = [{ root: "/r/appweb", name: "appweb", total: 2, claude: 2, copilot: 0, codex: 0 }];
    const discovered = [
      { root: "/r/appweb", name: "appweb", total: 0, claude: 0, copilot: 0, codex: 0 },
      { root: "/r/fresh", name: "fresh", total: 0, claude: 0, copilot: 0, codex: 0 },
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
  const repo = (root: string): RepoInfo => ({ root, name: root.split("/").pop()!, total: 0, claude: 0, copilot: 0, codex: 0 });
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

// The CLI's `--path` selector (`agendo list/status/wait`). isUnderRoot above is
// the matcher; this is the resolution feeding it — the only part that touches the
// filesystem, and the only place a symlinked checkout can silently scope to
// nothing. Both spellings must survive: recorded session cwds are real process
// working directories (symlink-free), but the tree a session runs in can itself
// be reached through a symlink, so neither form alone matches every setup.
test.describe("resolveScopeRoots: --path resolution", () => {
  test("a plain path resolves to exactly one root, normalized and absolute", () => {
    expect(resolveScopeRoots("repos/appweb", "/home/me")).toEqual(["/home/me/repos/appweb"]);
    expect(resolveScopeRoots("./repos/../repos/appweb/", "/home/me")).toEqual(["/home/me/repos/appweb"]);
    expect(resolveScopeRoots("/home/me/work", "/anywhere")).toEqual(["/home/me/work"]);
  });

  test("a path that isn't on disk keeps its literal form (no throw)", () => {
    expect(resolveScopeRoots("/no/such/dir/anywhere", "/")).toEqual(["/no/such/dir/anywhere"]);
  });

  test("a symlinked path keeps BOTH the literal and the resolved root", () => {
    // mkdtemp itself can sit behind a symlink (macOS /tmp), so compare against
    // the realpath of the temp dir rather than assuming the literal is unique.
    const dir = mkdtempSync(join(tmpdir(), "agendo-scope-"));
    try {
      const real = join(dir, "real-repo");
      const link = join(dir, "link-repo");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, link);
      const roots = resolveScopeRoots(link, "/");
      // Both spellings are kept, so a session recorded under either is in scope.
      expect(roots).toHaveLength(2);
      expect(isUnderRoot(join(link, "sub"), roots[0])).toBe(true);
      expect(isUnderRoot(join(real, "sub"), roots[1])).toBe(true);
      // …and the literal one the user typed stays first (it's what error
      // messages echo back).
      expect(roots[0]).toBe(normalizeCwd(link));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The predicate the three subcommands filter with. `--repo` reuses
// sessions.ts's work-item scope matcher, so a bare repo name never shells out to
// git and a worktree resolves to the repo it belongs to.
test.describe("scopeFilter: --path AND --repo", () => {
  const login = sess("login", "/h/repos/appweb/.claude/worktrees/login", 3);
  const legacy = sess("legacy", "/h/repos/appweb-legacy/.claude/worktrees/port", 2);
  const applib = sess("applib", "/h/repos/applib/.claude/worktrees/exp", 1);
  const all = [login, legacy, applib];
  const kept = (scope: Parameters<typeof scopeFilter>[0]) => all.filter(scopeFilter(scope)).map((s) => s.id);

  test("no scope keeps everything", () => {
    expect(kept(null)).toEqual(["login", "legacy", "applib"]);
  });

  test("--repo attributes a worktree to its parent repo, and stops at the name boundary", () => {
    expect(kept({ roots: [], repo: "appweb" })).toEqual(["login"]);
    expect(kept({ roots: [], repo: "appweb-legacy" })).toEqual(["legacy"]);
    expect(kept({ roots: [], repo: "APPWEB" })).toEqual(["login"]); // case-insensitive
  });

  test("--path scopes by cwd, sibling prefixes excluded", () => {
    expect(kept({ roots: ["/h/repos/appweb"], repo: null })).toEqual(["login"]);
    expect(kept({ roots: ["/h/repos"], repo: null })).toEqual(["login", "legacy", "applib"]);
  });

  test("both axes are AND-ed; any of several roots matches", () => {
    expect(kept({ roots: ["/h/repos/appweb"], repo: "applib" })).toEqual([]);
    expect(kept({ roots: ["/h/repos/appweb", "/h/repos/applib"], repo: null })).toEqual(["login", "applib"]);
  });
});

// The scope object the three subcommands share. `null` (not an empty scope) is
// what keeps "no selector given" byte-identical to the old behavior, and what
// `wait` tests to decide whether a selector was supplied at all.
test.describe("makeSessionScope / describeScope", () => {
  test("no selector yields null; either one yields a scope", () => {
    expect(makeSessionScope({}, "/home/me")).toBeNull();
    expect(makeSessionScope({ path: "", repo: "  " }, "/home/me")).toBeNull(); // blank ⇒ no selector
    expect(makeSessionScope({ repo: "appweb" }, "/home/me")).toEqual({ roots: [], repo: "appweb" });
    expect(makeSessionScope({ path: "work" }, "/home/me")).toEqual({ roots: ["/home/me/work"], repo: null });
  });

  test("describeScope names the flags that produced it, literal path first", () => {
    expect(describeScope(null)).toBe("");
    expect(describeScope({ roots: ["/a/b", "/real/b"], repo: "appweb" })).toBe("--path /a/b --repo appweb");
  });
});

// The path-scoped repo picker's "always offer the scoped folder, ranked first"
// rule. Lives next to isUnderRoot because it leans on the same normalizeCwd
// convention: the two sides being compared come from different sources — the
// scoped root is `path.resolve`d from a CLI arg, the repo roots are derived from
// recorded session cwds — so equal directories must compare equal despite
// spelling differences. The browser-driven picker tests can't reach this: every
// path they feed in is already clean, so only a direct test pins the dedupe.
test.describe("ensureRepoAtTop: the scoped folder is offered exactly once, first", () => {
  const repo = (root: string, total = 1): RepoInfo => ({ root, name: root.split("/").pop() || root, total, claude: total, copilot: 0, codex: 0 });

  test("an existing repo is promoted, not duplicated", () => {
    const out = ensureRepoAtTop([repo("/h/appweb", 2), repo("/h/applib", 1)], "/h/applib");
    expect(out.map((r) => r.root)).toEqual(["/h/applib", "/h/appweb"]);
    expect(out[0].total).toBe(1); // kept its real count — not replaced by a synth
  });

  test("an absent repo is synthesized as a zero-count entry on top", () => {
    const out = ensureRepoAtTop([repo("/h/appweb", 2)], "/h/greenfield");
    expect(out.map((r) => r.root)).toEqual(["/h/greenfield", "/h/appweb"]);
    expect(out[0]).toMatchObject({ name: "greenfield", total: 0, claude: 0, copilot: 0, codex: 0 });
  });

  test("representation drift still dedupes — the same repo never appears twice", () => {
    // A trailing slash on the recorded session cwd, a clean scoped root…
    const trailing = ensureRepoAtTop([repo("/h/appweb/", 2)], "/h/appweb");
    expect(trailing).toHaveLength(1); // a raw `===` would prepend a synth duplicate
    expect(trailing[0].total).toBe(2);
    // …and the reverse: clean repo root, drifty scoped root (`..` + doubled slash).
    const drifty = ensureRepoAtTop([repo("/h/appweb", 2)], "/h/nope/..//appweb/");
    expect(drifty).toHaveLength(1);
    expect(drifty[0].total).toBe(2);
  });

  test("a synthesized entry is normalized, so its name and root are clean", () => {
    const out = ensureRepoAtTop([], "/h/labs/packages/../");
    expect(out[0].root).toBe("/h/labs");
    expect(out[0].name).toBe("labs");
  });

  test("the filesystem root gets a non-empty name (basename('/') is '')", () => {
    // `agendo /` is legal; a blank name cell in the picker is not.
    expect(ensureRepoAtTop([], "/")[0].name).toBe("/");
  });
});

// The bootstrap fallback's walk-up guard. `agendo <path>` is intent and may
// resolve anywhere; the cwd fallback is only an INFERENCE, so it must stop below
// $HOME — otherwise a dotfiles-tracked $HOME (chezmoi / yadm) turns every
// non-repo cwd into "your dotfiles repo", and the picker's happy path writes a
// worktree into ~/.claude/worktrees. Real dirs under a temp HOME, since the
// walk-up is an `existsSync(.git)` test on the actual filesystem.
test.describe("bootstrapRepoRoot: the cwd fallback never climbs into $HOME", () => {
  let home: string;
  let realHome: string | undefined;

  test.beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agendo-boot-"));
    realHome = process.env.HOME;
    process.env.HOME = home; // os.homedir() reads $HOME on linux
  });
  test.afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("a real checkout below $HOME is still resolved by walking up", () => {
    const repo = join(home, "git", "proj");
    mkdirSync(join(repo, ".git"), { recursive: true });
    const sub = join(repo, "packages", "web");
    mkdirSync(sub, { recursive: true });
    // The guard must not cost us the normal case: a subdir still resolves to its
    // repo root, so a worktree lands at the root.
    expect(bootstrapRepoRoot(sub)).toBe(repo);
  });

  test("a dotfiles $HOME is NOT inferred from a non-repo cwd under it", () => {
    mkdirSync(join(home, ".git"), { recursive: true });
    const plain = join(home, "projects", "newthing");
    mkdirSync(plain, { recursive: true });
    // Without the guard this returns `home` — and the picker then offers the
    // dotfiles repo as a worktree host.
    expect(bootstrapRepoRoot(plain)).toBe(plain);
  });

  test("standing IN a dotfiles $HOME still resolves to it — nothing was inferred", () => {
    mkdirSync(join(home, ".git"), { recursive: true });
    // The cwd IS the checkout, so there is no walk-up to second-guess. The guard
    // is about silent climbing, not about banning $HOME outright.
    expect(bootstrapRepoRoot(home)).toBe(home);
  });

  test("a checkout ABOVE $HOME is rejected too (never just $HOME itself)", () => {
    // $HOME nested under the repo: the walk-up would reach an ancestor of $HOME,
    // which is even further from anything the user pointed at.
    const nestedHome = join(home, "users", "me");
    mkdirSync(nestedHome, { recursive: true });
    mkdirSync(join(home, ".git"), { recursive: true });
    process.env.HOME = nestedHome;
    const plain = join(nestedHome, "work");
    mkdirSync(plain, { recursive: true });
    expect(bootstrapRepoRoot(plain)).toBe(plain);
  });
});
// ── #39: a window's name and the target that addresses it are not the same ───
// `liveWindows()` used to yield a bare window name, and tmux resolves one of
// those only inside the caller's own session. With several launcher hosts live,
// every capture of a window in another host failed outright, so `list`/`status`
// reported that whole host's sessions as `unknown`. The CLI-level regression is
// pinned in cli.spec.ts; these fix the pieces it is built out of.
test.describe("#39: window targets carry their host session", () => {
  test("windowTarget pins BOTH halves of a compound target", () => {
    expect(windowTarget("agendo-mc-applications", "cl-claude-ec3d3fb21f62")).toBe(
      "=agendo-mc-applications:=cl-claude-ec3d3fb21f62",
    );
    // Unpinned, tmux resolves exact → unique-prefix → fnmatch, and these names
    // are prefixes of each other in BOTH positions: `agendo` ⊂ `agendo-agendo`
    // ⊂ `agendo-mc-applications`, and `cl-pr-5` ⊂ `cl-pr-50`.
    expect(windowTarget("agendo", "cl-pr-5")).toBe("=agendo:=cl-pr-5");
  });

  test("reconcileLive keeps the attribution name and the addressable target apart", () => {
    const s = sess("ec3d3fb21f62", "/x", 1_000);
    const canon = sessionName(s);
    const target = `=agendo-mc-applications:=${canon}`;
    const r = reconcileLive(new Set([canon]), [{ name: canon, target, cwd: "/x", placeholder: false }], [s]);
    // The name is what everything attributes, displays and kills by…
    expect(r.liveWindows.get(canon)?.name).toBe(canon);
    // …and the target is the only form that may be handed to tmux. Collapsing
    // the two into one string is exactly what #39 was.
    expect(r.liveWindows.get(canon)?.target).toBe(target);
  });

  test("the recorded target is the REAL window's, not a same-named placeholder's", () => {
    // A restored-but-unopened tab in one host carries the same canonical name as
    // the live window in another — the duplicate-name case this launcher creates
    // by design. Recording the placeholder's target would point every readiness
    // read at an idle bash and report it as the session's own screen.
    const s = sess("dupehost1", "/x", 1_000);
    const canon = sessionName(s);
    const real = `=agendo-mc-applications:=${canon}`;
    const r = reconcileLive(
      new Set([canon]),
      [
        { name: canon, target: `=agendo:=${canon}`, cwd: "/x", placeholder: true },
        { name: canon, target: real, cwd: "/x", placeholder: false },
      ],
      [s],
    );
    expect(r.live.has(canon)).toBe(true);
    expect(r.liveWindows.get(canon)?.target).toBe(real);
    // A real window vouched for the name, so it is not a dormant tab.
    expect(r.livePlaceholders.has(canon)).toBe(false);
  });
});
