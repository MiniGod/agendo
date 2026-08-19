// Unit-level coverage for the orchestrator-mode prompt module (src/orchestrator.ts).
//
// These are pure assertions on the generated instruction text — no TUI, no child
// process, no filesystem. The prompt IS the feature: if a directive silently
// disappears from it, an "orchestrator" session quietly turns back into an
// ordinary implementer, and nothing else in the suite would notice. So each of
// the required behaviours gets its own assertion here.
//
// The marker file (markOrchestratorSession / isOrchestratorSession) is deliberately
// NOT exercised in-process: it writes under `homedir()`, which in this Playwright
// process is the developer's real home. Its round-trip is covered end-to-end in
// cli.spec.ts instead, where $HOME is the mock fixture home.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./harness/test.ts";
import {
  ORCHESTRATOR_SLUG,
  globalOrchestratorSystemPrompt,
  orchestratorSystemPrompt,
  systemPromptForRole,
} from "../src/orchestrator.ts";
import { commonParent, globalOrchestratorCwd } from "../src/repos.ts";
import { freeWorktreeBranch, worktreePath } from "../src/worktree.ts";

// A distinctive stand-in for SELF_CMD, so every assertion that the prompt points
// at the launcher's own CLI is provably reading the injected value (and not a
// hard-coded `bunx agendo` that would break for a globally-installed binary).
const SELF = "npx agendo@test";
const prompt = orchestratorSystemPrompt(SELF);
/**
 * The prompt with all runs of whitespace collapsed. Used for assertions on
 * phrases that span a hard-wrapped line: the wrap position is formatting, not
 * meaning, so pinning it makes every reflow of a paragraph a test failure.
 */
const flat = prompt.replace(/\s+/g, " ");

test("the prompt announces orchestrator mode and forbids writing project code", async () => {
  expect(prompt).toContain("ORCHESTRATOR MODE");
  // The single most important directive: it coordinates, it does not implement.
  expect(prompt).toContain("Never write project code yourself");
  expect(prompt).toMatch(/Do NOT edit, create, or refactor project source files/);
  // …including the escape hatch being "delegate", not "just this once do it myself".
  expect(prompt).toMatch(/delegate it to a sub-agent or another session/);
});

test("the prompt delegates each unit of work to a background agendo session", async () => {
  // One unit = one session = one isolated worktree, launched through OUR cli.
  expect(prompt).toContain(`${SELF} launch --name <slug>`);
  expect(prompt).toContain("One unit of work = one session = one worktree.");
  expect(prompt).toContain(`${SELF} --llm`); // where the full launch usage lives
});

test("the prompt mandates a sub-agent dev→review loop in every session", async () => {
  // The loop must be stated as something the SESSION does with a SUB-AGENT (not
  // the session's own main thread), and must repeat until a pass is clean.
  expect(prompt).toMatch(/have a SUB-AGENT review your change/);
  expect(prompt).toMatch(/a fresh\s+sub-agent, not your own main thread/);
  expect(prompt).toMatch(/Fix every finding/);
  expect(prompt).toMatch(/Repeat implement → sub-agent review → fix until a review\s+pass comes back clean/);
  // Completion is only reported after the clean pass.
  expect(prompt).toMatch(/Only then report that the work is\s+complete/);
});

test("the prompt requires a task list with the five states", async () => {
  expect(prompt).toContain("Keep a task list, always current");
  for (const state of ["pending", "running", "in-review", "done", "blocked"]) {
    expect(prompt).toContain(`**${state}**`);
  }
  expect(prompt).toMatch(/Update it as sessions/);
});

test("the prompt parallelizes independent units and serializes only real dependencies", async () => {
  // Plain substrings, not `/…/s` regexes: with the dotAll flag `.` crosses
  // newlines, so anchors could be satisfied from two unrelated sections.
  expect(flat).toContain("Independent units (disjoint files, separate features, per-module work) launch in parallel");
  expect(flat).toContain("do not queue work that has no reason to wait.");
  expect(prompt).toContain("Serialize ONLY where there is a genuine dependency");
});

test("the prompt monitors via list/status and coordinates via send — never in the worktree", async () => {
  expect(prompt).toContain(`${SELF} list`);
  expect(prompt).toContain(`${SELF} status <id>`);
  expect(prompt).toContain(`${SELF} send <id> "<text>"`);
  // The hand-holding rule: never reach into a session's worktree yourself.
  expect(prompt).toMatch(/Never run a background session's own git, build, test,\s+or fix commands inside its worktree/);
});

test("the prompt auto squash-merges on the two gates, and hands conflicts back", async () => {
  // Auto-merge, unprompted, gated on BOTH a clean review and a completion report.
  // Exact substring rather than a dotAll regex, so the two halves of the sentence
  // can't be matched from different sections of the prompt.
  expect(flat).toContain("Auto-merge a finished session's branch into the main branch, without asking, once BOTH hold");
  expect(prompt).toMatch(/dev→review loop came back CLEAN/);
  expect(prompt).toMatch(/its last message says the work is complete/);
  // Squash merge only — explicitly no PRs.
  expect(prompt).toContain("squash-merge that branch into the main branch as one clear commit");
  expect(prompt).toContain("do not open a pull request");
  // A conflict goes back to the owning session, it is not resolved here.
  expect(prompt).toMatch(/If the merge conflicts, do NOT resolve it yourself/);
  expect(prompt).toContain(`${SELF} send <id> "…"`);
});

test("the prompt says WHERE to merge — the main checkout, not its own worktree", async () => {
  // The orchestrator is launched into its own worktree on its own branch, so
  // "squash-merge into the main branch" is unactionable without this: merging in
  // its own worktree lands the work on the wrong branch, and it must not reach
  // into a background session's worktree either.
  expect(prompt).toContain("Merge in the repo's MAIN checkout");
  // The main checkout is the DEFAULT home, so "merge where you sit" is the primary
  // instruction; reaching out with `git -C <repo-root>` is the worktree fallback.
  expect(flat).toContain("git allows the main branch in only ONE working tree");
  expect(flat).toContain("you can merge right where you sit");
  expect(prompt).toContain("git -C <repo-root>");
  expect(flat).toContain("Never merge inside a background session's worktree");
  // And the opt-in-worktree case, now the exception rather than the norm.
  expect(flat).toContain("If you were deliberately given a worktree of your own");
  // And it must not stomp a checkout the human might be sitting in — on EVERY
  // merge, not only the first (the hazard persists across a multi-wave run).
  expect(flat).toContain("Before EACH merge — not just the first — check the main checkout is clean");
  expect(flat).toContain("STOP and ask the user");
});

test("the prompt closes the origin/HEAD gap so dependent waves see merged work", async () => {
  // Worktrees are branched off `origin/HEAD` (see `defaultBaseRef`), so a LOCAL
  // squash-merge is invisible to every session launched afterwards. Without this,
  // the prompt's own "serialize on real dependencies" rule quietly cannot work:
  // wave 2 starts from a tree missing wave 1's merged foundations.
  expect(flat).toContain("branched from `origin/HEAD`, NOT from your local main branch");
  expect(flat).toContain("git rebase <main>");
  // Delegated verification must target the local main branch, not origin's.
  expect(flat).toContain("Point any verification you delegate at the LOCAL main branch");
  // …and the fix must not be "just push" — that's outward-facing and user-gated.
  expect(flat).toContain("Do NOT push to sidestep this unless the user has explicitly approved pushing");
});

test("the prompt keeps bookkeeping off disk so the pre-merge gate can't deadlock", async () => {
  // The cleanliness gate STOPs on a dirty main checkout. If the orchestrator kept
  // its task list as files there — which the --no-worktree flow makes its cwd —
  // every merge would trip the gate forever and nothing would ever integrate.
  expect(flat).toContain("Keep your task list in your task-list tool, NOT in repository files");
  expect(flat).toContain("Your own bookkeeping never makes it dirty, because you keep no files there.");
});

test("the prompt names the merge as the one thing it does NOT delegate", async () => {
  // The escape-hatch bullet says delegate anything that must happen outside a
  // session; the merge section has it run merges itself. Reconcile explicitly.
  expect(flat).toContain("The integration merges are the one exception: those you run yourself");
});

// ── the GLOBAL orchestrator prompt ────────────────────────────────────────────
// One level above the per-repo orchestrator. Same reasoning as above: the prompt
// IS the feature, and the failure mode is silent — a global orchestrator that
// loses the "never touch a repo" or "never skip a level" directives becomes an
// ordinary orchestrator competing with the ones it is supposed to be managing.

const globalPrompt = globalOrchestratorSystemPrompt(SELF);
const globalFlat = globalPrompt.replace(/\s+/g, " ");

test("the global prompt announces its own mode and states the three-level hierarchy", async () => {
  expect(globalPrompt).toContain("GLOBAL ORCHESTRATOR MODE");
  expect(globalPrompt).toContain("global orchestrator  →  per-repo orchestrators  →  per-worktree sessions");
  // It must not read as the repo-level prompt: that one's headline directive is
  // about writing code in a repo it owns, and this one owns no repo at all.
  expect(globalPrompt).not.toContain("# You are running in ORCHESTRATOR MODE");
});

test("the global prompt forbids writing code AND operating on any repo — merges included", async () => {
  expect(globalFlat).toContain("You write no code and touch no repository — not even a merge");
  expect(globalFlat).toContain("Do NOT edit, create, or refactor source files in ANY repository");
  // The merge prohibition is the one most likely to be rationalized away ("it's
  // just an integration step"), so it's pinned explicitly, as is whose job it is.
  expect(globalFlat).toContain("NO MERGES");
  expect(globalFlat).toContain("Integrating a finished branch is the REPO orchestrator's job");
  expect(globalFlat).toContain("Do NOT run builds, tests, or linters in a repository");
});

test("the global prompt discovers repos and orchestrators through list --json", async () => {
  expect(globalPrompt).toContain(`${SELF} list --json`);
  expect(globalPrompt).toContain(`${SELF} list repos --json`);
  // The fields it parses must be named, or it will invent its own scheme.
  expect(globalFlat).toContain("`repoRoot`");
  expect(globalFlat).toContain("`orchestrator` (boolean)");
  expect(globalFlat).toContain("is UNMANAGED");
});

test("the global prompt starts a repo orchestrator where one is missing", async () => {
  expect(globalPrompt).toContain(`${SELF} launch --orchestrator`);
  // In THAT repo — a launch from wherever the global one happens to sit would
  // put the orchestrator in the wrong checkout entirely.
  expect(globalPrompt).toContain("cd <repoRoot>");
  expect(globalFlat).toContain("One repo = one orchestrator");
  // Decomposition belongs to the repo orchestrator, not to this level.
  expect(globalFlat).toContain("do NOT hand it a list of worktree sessions to launch");
});

test("the global prompt forbids reaching past a level, loudly and in both directions", async () => {
  expect(globalFlat).toContain("Talk ONLY to repo orchestrators — never to their sessions");
  expect(globalPrompt).toContain(`${SELF} send <repo-orchestrator-id>`);
  expect(globalFlat).toContain("NEVER `send` to an individual worktree session");
  expect(globalFlat).toContain("two voices instructing one agent is how work gets duplicated, reverted, or lost");
  // The other direction: it must not answer/unblock/relaunch someone else's session.
  expect(globalFlat).toContain("do not answer a worktree session's question, unblock it, or relaunch it");
  // …but reading at any depth is explicitly fine, or it would stop using `status`.
  expect(globalFlat).toContain("Reading is fine at any depth");
  // A dead repo orchestrator IS its level, so that exception is stated too.
  expect(globalFlat).toContain("If a repo orchestrator dies or stops responding, that IS your level");
});

test("the global prompt keeps a task list at REPO granularity", async () => {
  expect(globalFlat).toContain("Keep a task list at REPO granularity");
  expect(globalFlat).toContain("One entry per repository, not per unit of work");
  for (const state of ["unmanaged", "starting", "running", "blocked", "done"]) {
    expect(globalPrompt).toContain(`**${state}**`);
  }
});

test("the global prompt aggregates status and escalates only cross-repo decisions", async () => {
  expect(globalFlat).toContain("report UP to the user in repo-level terms");
  expect(globalFlat).toContain("Bring a decision to the user when it genuinely spans repositories");
  // Anything one repo can answer goes DOWN, not up — otherwise it becomes a relay.
  expect(globalFlat).toContain("forward the question to it instead of escalating");
});

test("systemPromptForRole picks the level's own instructions", async () => {
  // The single selection point every injection path shares: if it ever returned
  // the repo prompt for a global session, that session would start merging.
  expect(systemPromptForRole("repo", SELF)).toBe(orchestratorSystemPrompt(SELF));
  expect(systemPromptForRole("global", SELF)).toBe(globalOrchestratorSystemPrompt(SELF));
});

// ── where a global orchestrator runs ──────────────────────────────────────────
// It has no repo and no worktree, so its cwd is chosen rather than derived from
// a checkout. The rule that matters: don't sit inside one repo, because a
// coordinator of all of them must not look local (nor be tempted to run git).

test("globalOrchestratorCwd sits above the known repos, never inside one", async () => {
  const repos = ["/home/me/git/alpha", "/home/me/git/beta", "/home/me/work/gamma"];
  expect(globalOrchestratorCwd(repos, "/fallback")).toBe("/home/me");
  // A single repo makes the common parent the repo ITSELF — step up instead.
  expect(globalOrchestratorCwd(["/home/me/git/alpha"], "/fallback")).toBe("/home/me/git");
  // …including when the others are nested under it (worktrees resolve to their
  // main checkout, but a genuinely nested repo would produce this shape).
  expect(globalOrchestratorCwd(["/home/me/git/alpha", "/home/me/git/alpha/vendor/x"], "/fb")).toBe("/home/me/git");
  // The launcher's own scope root wins outright: it's the user's declared scope.
  expect(globalOrchestratorCwd(repos, "/fallback", "/home/me/scoped")).toBe("/home/me/scoped");
});

test("globalOrchestratorCwd falls back rather than landing on /", async () => {
  // Nothing to sit above, or roots sharing only the filesystem root: `/` is a
  // terrible cwd for an agent, so the caller's own directory is used instead.
  expect(globalOrchestratorCwd([], "/fallback")).toBe("/fallback");
  expect(globalOrchestratorCwd(["/srv/a", "/opt/b"], "/fallback")).toBe("/fallback");
  // A single top-level repo would step up to `/` — fall back for that too.
  expect(globalOrchestratorCwd(["/alpha"], "/fallback")).toBe("/fallback");
});

test("commonParent is segment-aware and slash-drift tolerant", async () => {
  // A raw string prefix would return "/home/me/git/alp" here — a path that isn't
  // a directory at all, which the launcher would then try to run an agent in.
  expect(commonParent(["/home/me/git/alpha", "/home/me/git/alphabet"])).toBe("/home/me/git");
  expect(commonParent(["/home/me/git/a/", "/home/me//git/b"])).toBe("/home/me/git");
  expect(commonParent(["/home/me/git/a"])).toBe("/home/me/git/a");
  expect(commonParent([])).toBeNull();
  expect(commonParent(["/a", "/b"])).toBeNull();
});

test("the orchestrator slug is a stable, worktree-safe name", async () => {
  expect(ORCHESTRATOR_SLUG).toBe("orchestrator");
  expect(ORCHESTRATOR_SLUG).toMatch(/^[a-z0-9-]+$/);
});

// ── collision avoidance for the role-named worktree ───────────────────────────
// Because every unnamed orchestrator derives the SAME slug, `freeWorktreeBranch`
// is what stops the second one inheriting the first one's checkout. This runs
// against a REAL throwaway git repo under the OS temp dir (the fake git shim has
// no ref database, so it can't express "branch exists but directory doesn't" —
// the case that matters most here). No user repo is touched.
test("freeWorktreeBranch steps past an occupied directory AND a leftover branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "agendo-worktree-"));
  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    git("commit", "-q", "--allow-empty", "-m", "root"); // a branch needs a commit

    // Nothing taken → the base name.
    expect(freeWorktreeBranch(root, "worktree-orchestrator")).toBe("worktree-orchestrator");

    // Directory taken → step. (This is the common case: a live orchestrator.)
    mkdirSync(worktreePath(root, "worktree-orchestrator"), { recursive: true });
    expect(freeWorktreeBranch(root, "worktree-orchestrator")).toBe("worktree-orchestrator-2");

    // Branch taken but its directory already removed — what `git worktree remove`
    // leaves behind. Checking only the directory would return `-2` here, and
    // createWorktree's "branch exists" retry would check out that STALE branch,
    // starting the new orchestrator on the old one's commits.
    expect(git("branch", "worktree-orchestrator-2").status).toBe(0);
    expect(freeWorktreeBranch(root, "worktree-orchestrator")).toBe("worktree-orchestrator-3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
