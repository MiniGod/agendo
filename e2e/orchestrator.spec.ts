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
import { ORCHESTRATOR_SLUG, orchestratorSystemPrompt } from "../src/orchestrator.ts";
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

test("the prompt ends finished sessions through close, not raw tmux", async () => {
  // An orchestrator that can start sessions but not end them reaches for
  // `tmux kill-window` — which resolves its target by prefix, so it can kill a
  // DIFFERENT session (`cl-pr-5` matching `cl-pr-50`). The command has to be in
  // the list it is given, and the guarantee has to be stated, or it won't be used.
  expect(prompt).toContain(`${SELF} close <id>`);
  expect(flat).toContain("Never `tmux kill-window` yourself");
  expect(flat).toContain("its worktree, branch and commits stay on disk");
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
