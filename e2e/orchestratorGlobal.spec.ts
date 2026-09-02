// Unit-level coverage for the GLOBAL orchestrator prompt (src/orchestratorGlobal.ts).
//
// Same reasoning as orchestrator.spec.ts next door: the prompt IS the feature.
// A global orchestrator differs from a repo one ONLY in what it was told, so a
// directive that silently vanishes here turns the top of the hierarchy back into
// an ordinary repo orchestrator — one that starts editing and merging whichever
// checkout it happens to sit in — and nothing else in the suite would notice.
//
// The prohibitions get the most assertions on purpose. "Never reach past a level"
// is the whole reason the three-level model holds together, and it is the rule an
// agent is most tempted to break when a worktree session is visibly stuck.
import { test, expect } from "./harness/test.ts";
import { globalOrchestratorSystemPrompt, systemPromptForRole } from "../src/orchestratorGlobal.ts";
import { orchestratorSystemPrompt } from "../src/orchestrator.ts";

// A distinctive stand-in for SELF_CMD — see the note in orchestrator.spec.ts.
const SELF = "npx agendo@test";
const prompt = globalOrchestratorSystemPrompt(SELF);
/** The prompt with runs of whitespace collapsed, so hard wraps aren't pinned. */
const flat = prompt.replace(/\s+/g, " ");

test("the prompt announces global mode and names the three levels", async () => {
  expect(prompt).toContain("GLOBAL ORCHESTRATOR MODE");
  expect(prompt).toContain("global orchestrator  →  per-repo orchestrators  →  per-worktree sessions");
  expect(flat).toContain("You are the TOP level of a three-level hierarchy");
});

test("the prompt forbids touching any repository — including merges", async () => {
  // The one directive that separates this level from the one below it. A repo
  // orchestrator merges; this one must not, because it cannot know whether a
  // branch's review came back clean.
  expect(prompt).toMatch(/Do NOT edit, create, or refactor source files in ANY repository/);
  expect(flat).toContain("specifically NO MERGES");
  expect(flat).toContain("Integrating a finished branch is the REPO orchestrator's job");
  expect(prompt).toContain("Do NOT run builds, tests, or linters in a repository");
});

test("the prompt discovers repos and unmanaged ones through the CLI", async () => {
  expect(prompt).toContain(`${SELF} list repos --json`);
  expect(prompt).toContain(`${SELF} list --json`);
  // The fields the JSON actually carries — if these are renamed, the prompt is
  // telling the agent to read keys that no longer exist.
  expect(prompt).toContain("`repoRoot`");
  expect(prompt).toContain("`orchestrator` (boolean)");
  expect(flat).toContain('session is UNMANAGED — nobody is coordinating it');
});

test("the prompt starts a repo orchestrator in the repo that lacks one", async () => {
  expect(prompt).toContain(`(cd <repoRoot> && ${SELF} launch --orchestrator "<that repo's goal>")`);
  expect(flat).toContain("One repo = one orchestrator");
  // It briefs, it does not decompose — decomposition is the repo level's call.
  expect(flat).toContain("do NOT hand it a list of worktree sessions to launch, that is its call");
});

test("the prompt forbids reaching past a level in EITHER direction", async () => {
  expect(prompt).toContain(`${SELF} send <repo-orchestrator-id> "<text>"`);
  expect(flat).toContain("NEVER `send` to an individual worktree session");
  expect(flat).toContain("two voices instructing one agent is how work gets duplicated, reverted, or lost");
  // The upward half: a stuck session is reported to its orchestrator, not fixed.
  expect(flat).toContain("do not answer a worktree session's question, unblock it, or relaunch it");
  // …but reading is explicitly unrestricted, or the agent will refuse to look.
  expect(flat).toContain("Reading is fine at any depth");
  // And a dead orchestrator IS this level's business — otherwise a whole repo
  // silently stops with nobody believing it is theirs to restart.
  expect(flat).toContain("If a repo orchestrator dies or stops responding, that IS your level");
});

test("the prompt keeps the task list at repo granularity, off disk", async () => {
  expect(prompt).toContain("Keep a task list at REPO granularity");
  for (const state of ["unmanaged", "starting", "running", "blocked", "done"]) {
    expect(prompt).toContain(`**${state}**`);
  }
  expect(flat).toContain("One entry per repository, not per unit of work");
  expect(flat).toContain("Keep it in your task-list tool, not in files on disk");
});

test("the prompt escalates only decisions that genuinely span repos", async () => {
  expect(flat).toContain("report UP to the user in repo-level terms");
  expect(flat).toContain("Bring a decision to the user when it genuinely spans repositories");
  expect(flat).toContain("Anything answerable inside one repository should be answered by that repository's orchestrator");
});

test("systemPromptForRole picks the level's own prompt", async () => {
  // The selector is what fresh launch AND cold resume both go through. Getting it
  // backwards would resume a global orchestrator with merge instructions.
  expect(systemPromptForRole("global", SELF)).toBe(prompt);
  expect(systemPromptForRole("repo", SELF)).toBe(orchestratorSystemPrompt(SELF));
  expect(systemPromptForRole("repo", SELF)).not.toContain("GLOBAL ORCHESTRATOR MODE");
});
