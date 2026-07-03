// Deterministic fixtures for the e2e harness.
//
// `materializeHome` writes a fake $HOME containing exactly the on-disk session
// state the launcher discovers (Claude JSONL logs + a Copilot session dir) and
// a config.json, so `src/sessions.ts` / `src/config.ts` read fixtures instead
// of the real machine. `ADO` + the `resolve*` helpers below model the REST
// surface the mock server serves. `tmuxState` is the initial fake-tmux state
// (which `cl-…` targets are "live", and what their panes show).
//
// The data is shaped to exercise every branch of the view model:
//   • identities: Ada (the authenticated "you"), Grace, Alan (Team A roster),
//     so the identity switcher + per-person work-item/PR queries are testable
//   • WI 101 (current sprint, HMI-tagged) → PR 5001 → a running Claude session
//   • WI 102 (current sprint) → no PR, matched to a session by id-in-branch
//   • WI 103 (older sprint)   → lands under "Everything else assigned"
//   • WI 201 (Grace's)        → only shows when viewing as Grace
//   • PR 6001                 → orphan PR (no work item) + a Copilot session
//   • PR 7001 / 7002          → Grace's PRs where Ada is a reviewer ("Awaiting
//                               your review"), with running / passing CI
import { mkdir, writeFile, utimes } from "node:fs/promises";
import { join } from "node:path";

// ── identity helpers ─────────────────────────────────────────────────────────
// Mirror of src/tmux.ts sessionName(), duplicated so the harness never imports
// app code. Kept in sync by the "running badge" test, which asserts the name.
export function sessionName(source: string, id: string): string {
  const shortId = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  return `cl-${source}-${shortId}`;
}

// Session ids (also the Claude log filenames). Chosen to be human-readable.
export const LOGIN_SESSION_ID = "login-session";
export const CRASH_SESSION_ID = "crash-session";
export const STANDALONE_SESSION_ID = "standalone-session";
export const COPILOT_SESSION_ID = "cop-exp-01";

/** The canonical tmux target for the running login session. */
export const RUNNING_TARGET = sessionName("claude", LOGIN_SESSION_ID);

// Repo roots live under the fake home so worktree paths resolve purely by
// string (the `<root>/.claude/worktrees/<name>` convention), except the
// standalone checkout which forces the git walk-up in repoRootForCwd.
function paths(home: string) {
  const appweb = join(home, "repos", "appweb");
  const applib = join(home, "repos", "applib");
  const standalone = join(home, "repos", "standalone");
  return {
    appweb,
    applib,
    standalone,
    loginCwd: join(appweb, ".claude", "worktrees", "login"),
    crashCwd: join(appweb, ".claude", "worktrees", "fix-crash-102"),
    expCwd: join(applib, ".claude", "worktrees", "experiment"),
  };
}

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

// ── the fake HOME tree ────────────────────────────────────────────────────────
export async function materializeHome(home: string): Promise<void> {
  const p = paths(home);

  // config.json lives in the HISTORICAL ~/.claude-launcher/ dir on purpose: it
  // exercises the post-rename read-fallback (config.ts reads ~/.agendo/ first,
  // then the old dir), proving an existing install keeps working. The org /
  // project / team are set here because the shipped defaults are now blank.
  const cfgDir = join(home, ".claude-launcher");
  await mkdir(cfgDir, { recursive: true });
  await writeFile(
    join(cfgDir, "config.json"),
    JSON.stringify({ org: "acme", project: "Widgets", team: "Team A" }, null, 2),
  );

  // state.json in the NEW ~/.agendo/ dir pins the backend to Azure DevOps. This
  // is essential for determinism: `gh` and `az` may both be installed on the
  // test machine, and with no persisted choice GitHub would win the auto-detect
  // tie — flipping the whole TUI to the GitHub backend (and shelling out to the
  // real `gh`). Persisting "ado" forces the ADO path regardless of the machine.
  const stateDir = join(home, ".agendo");
  await mkdir(stateDir, { recursive: true });
  await writeFile(join(stateDir, "state.json"), JSON.stringify({ provider: "ado" }, null, 2));

  // A `.git` marker so repoRootForCwd resolves the standalone session's repo.
  await mkdir(join(p.standalone, ".git"), { recursive: true });

  const projects = join(home, ".claude", "projects");

  // 1) login session — running. Its gitBranch DELIBERATELY progresses across the
  // log: it starts on the base branch `master`, spends most records on an interim
  // worktree branch `worktree-login-101`, then settles on `feature/login` in the
  // final record. This exercises the d5d226c rule: a session files under its
  // *most-recent non-base* branch (feature/login), NOT the most-frequent one
  // (worktree-login-101) and NOT a base branch (master). feature/login is what
  // matches PR 5001, so every downstream "!5001 → WI 101" assertion (launcher /
  // features / `agendo status … feature/login`) is a regression guard for that
  // rule — under the old most-frequent logic they'd resolve to the wrong branch.
  const loginDir = join(projects, "appweb-login");
  await mkdir(loginDir, { recursive: true });
  await writeFile(
    join(loginDir, `${LOGIN_SESSION_ID}.jsonl`),
    jsonl([
      { type: "summary", cwd: p.loginCwd, gitBranch: "master", timestamp: "2026-06-20T10:00:00.000Z" },
      { type: "ai-title", aiTitle: "Implement login form", timestamp: "2026-06-20T10:00:01.000Z" },
      { type: "user", message: { role: "user", content: "Add a login form with validation" }, cwd: p.loginCwd, gitBranch: "worktree-login-101", timestamp: "2026-06-20T10:00:05.000Z" },
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "x".repeat(400) }] }, cwd: p.loginCwd, gitBranch: "worktree-login-101", timestamp: "2026-06-20T10:00:10.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: join(p.loginCwd, "src/login.tsx") } }] }, timestamp: "2026-06-20T10:00:12.000Z" },
      // An early TodoWrite checklist — SUPERSEDED by the later one below, proving
      // only the LATEST TodoWrite is surfaced (the whole list, not a diff).
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [
        { content: "Write the login form", activeForm: "Writing the login form", status: "in_progress" },
        { content: "Add validation", activeForm: "Adding validation", status: "pending" },
      ] } }] }, timestamp: "2026-06-20T10:00:15.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(p.loginCwd, "src/login.tsx") } }] }, timestamp: "2026-06-20T10:00:20.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun test login" } }] }, timestamp: "2026-06-20T10:00:25.000Z" },
      // The authoritative checklist: one done, one in-progress, one pending.
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TodoWrite", input: { todos: [
        { content: "Write the login form", activeForm: "Writing the login form", status: "completed" },
        { content: "Add validation", activeForm: "Adding validation", status: "in_progress" },
        { content: "Wire up the submit handler", activeForm: "Wiring up the submit handler", status: "pending" },
      ] } }] }, timestamp: "2026-06-20T10:00:27.000Z" },
      { type: "assistant", message: { content: [{ type: "text", text: "Done — login form added with validation. " + "x".repeat(400) }] }, cwd: p.loginCwd, gitBranch: "feature/login", timestamp: "2026-06-20T10:00:30.000Z" },
    ]),
  );

  // 2) crash session — branch embeds work-item id 102 (no PR on that item).
  const crashDir = join(projects, "appweb-crash");
  await mkdir(crashDir, { recursive: true });
  await writeFile(
    join(crashDir, `${CRASH_SESSION_ID}.jsonl`),
    jsonl([
      { type: "summary", cwd: p.crashCwd, gitBranch: "worktree-fix-crash-102", timestamp: "2026-06-19T09:00:00.000Z" },
      { type: "ai-title", aiTitle: "Investigate startup crash", timestamp: "2026-06-19T09:00:01.000Z" },
      { type: "user", message: { content: "App crashes on startup" }, cwd: p.crashCwd, gitBranch: "worktree-fix-crash-102", timestamp: "2026-06-19T09:00:05.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "bun run start" } }] }, timestamp: "2026-06-19T09:00:08.000Z" },
      // No TodoWrite here: the checklist is reconstructed from des-workflow
      // TaskCreate/TaskUpdate events. Mirrors REAL transcripts — TaskCreate carries
      // only a subject (the taskId is assigned in the tool_result, not the input),
      // and TaskUpdate references tasks by the ordinal ids "1","2" handed out in
      // creation order. This exercises the create↔update correlation, last status
      // winning; a third task is deleted mid-way and must NOT appear.
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate", input: { subject: "Reproduce the crash" } }] }, timestamp: "2026-06-19T09:00:09.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate", input: { subject: "Patch the null deref" } }] }, timestamp: "2026-06-19T09:00:10.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskCreate", input: { subject: "Write a regression test" } }] }, timestamp: "2026-06-19T09:00:10.500Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }] }, timestamp: "2026-06-19T09:00:11.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskUpdate", input: { taskId: "2", status: "active" } }] }, timestamp: "2026-06-19T09:00:12.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "TaskUpdate", input: { taskId: "3", status: "deleted" } }] }, timestamp: "2026-06-19T09:00:13.000Z" },
    ]),
  );

  // 3) standalone session — plain checkout, exercises the repoRoot git walk-up.
  const standaloneDir = join(projects, "standalone");
  await mkdir(standaloneDir, { recursive: true });
  await writeFile(
    join(standaloneDir, `${STANDALONE_SESSION_ID}.jsonl`),
    jsonl([
      { type: "summary", cwd: p.standalone, gitBranch: "main", timestamp: "2026-06-18T08:00:00.000Z" },
      { type: "custom-title", customTitle: "Misc fixes", timestamp: "2026-06-18T08:00:01.000Z" },
      { type: "user", message: { content: "clean up imports" }, cwd: p.standalone, gitBranch: "main", timestamp: "2026-06-18T08:00:05.000Z" },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: join(p.standalone, "x.ts") } }] }, timestamp: "2026-06-18T08:00:09.000Z" },
    ]),
  );

  // A sidechain transcript that MUST be ignored (agent-*.jsonl).
  await writeFile(join(loginDir, "agent-deadbeef.jsonl"), jsonl([{ type: "summary", cwd: p.loginCwd }]));

  // 4) copilot session — branch draft/experiment (matches orphan PR 6001).
  const copDir = join(home, ".copilot", "session-state", COPILOT_SESSION_ID);
  await mkdir(copDir, { recursive: true });
  await writeFile(
    join(copDir, "workspace.yaml"),
    [
      `id: ${COPILOT_SESSION_ID}`,
      "name: Experiment spike",
      `cwd: ${p.expCwd}`,
      "branch: draft/experiment",
      "repository: acme/Widgets/applib",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(copDir, "events.jsonl"),
    jsonl([
      { type: "user.message", timestamp: "2026-06-17T07:00:00.000Z", data: { content: "try an experiment" } },
      { type: "assistant.message", timestamp: "2026-06-17T07:00:03.000Z", data: { content: "", toolRequests: [{ name: "bash", arguments: { command: "npm test" } }] } },
      { type: "assistant.message", timestamp: "2026-06-17T07:00:06.000Z", data: { content: "Looks good.", toolRequests: [] } },
    ]),
  );

  // Set mtimes (== lastUsed) so ordering is deterministic: login newest.
  const now = Date.now();
  const min = 60_000;
  await utimes(join(loginDir, `${LOGIN_SESSION_ID}.jsonl`), now / 1000, (now - 5 * min) / 1000);
  await utimes(join(crashDir, `${CRASH_SESSION_ID}.jsonl`), now / 1000, (now - 60 * min) / 1000);
  await utimes(copDir, now / 1000, (now - 120 * min) / 1000);
  await utimes(join(standaloneDir, `${STANDALONE_SESSION_ID}.jsonl`), now / 1000, (now - 300 * min) / 1000);
}

// ── initial fake-tmux state ────────────────────────────────────────────────────
// Only the login session's canonical target is live, so exactly one session
// shows the green running badge and appears under "Running now". The pane is an
// idle (ready) claude TUI so the CLI `list`/`status` readiness checks have
// realistic content to classify.
const READY_PANE = [
  "  ● Implement login form",
  "  ─────────────────────────────────────────────",
  "  ❯ ",
  "  ─────────────────────────────────────────────",
  "  ? for shortcuts",
].join("\n");

export const tmuxState = {
  sessions: [RUNNING_TARGET],
  windows: [] as { session: string; index: number; name: string }[],
  // A pane backs the live session so liveManagedPaths / capture-pane work for
  // both the menu's readiness poll and the `agendo list/status` CLI paths. The
  // cwd just needs to be non-empty (liveManagedPaths skips empty-cwd panes); the
  // id-bearing `cl-claude-…` name attributes back to the login session by id, so
  // the exact path is irrelevant.
  panes: [
    { session: RUNNING_TARGET, window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
  ] as { session: string; window: string; cwd: string; placeholder: boolean }[],
  // Per-target captured pane text (what `capture-pane -t <target>` prints).
  captures: { [RUNNING_TARGET]: READY_PANE } as Record<string, string>,
};

// ── identities (Team A roster) ───────────────────────────────────────────────
// The authenticated user (az) — the default identity and the "(you)" marker.
export const ME = {
  id: "ada-guid",
  displayName: "Ada Lovelace",
  emailAddress: "ada@example.com",
};
export const GRACE = { id: "grace-guid", displayName: "Grace Hopper", uniqueName: "grace@example.com" };
export const ALAN = { id: "alan-guid", displayName: "Alan Turing", uniqueName: "alan@example.com" };

// `GET …/teams/<team>/members` shape: each entry wraps an `identity`.
export const TEAM_MEMBERS = {
  value: [
    { identity: { id: ME.id, displayName: ME.displayName, uniqueName: ME.emailAddress } },
    { identity: { id: GRACE.id, displayName: GRACE.displayName, uniqueName: GRACE.uniqueName } },
    { identity: { id: ALAN.id, displayName: ALAN.displayName, uniqueName: ALAN.uniqueName } },
  ],
};

// ── pull requests ──────────────────────────────────────────────────────────────
// creationDate / a later iteration date (see PR_ITERATIONS) are chosen so the
// "created" vs "updated" sort orders differ within the review section.
const PR_5001 = {
  pullRequestId: 5001,
  title: "Add login screen",
  status: "active",
  sourceRefName: "refs/heads/feature/login",
  repository: { id: "repoA-guid", name: "appweb" },
  isDraft: false,
  createdBy: { id: ME.id },
  creationDate: "2026-06-10T10:00:00.000Z",
  reviewers: [{ vote: 10 }],
};

const PR_6001 = {
  pullRequestId: 6001,
  title: "Experiment spike",
  status: "active",
  sourceRefName: "refs/heads/draft/experiment",
  repository: { id: "repoB-guid", name: "applib" },
  isDraft: true,
  createdBy: { id: ME.id },
  creationDate: "2026-06-15T10:00:00.000Z",
  reviewers: [],
};

// Grace's PRs where Ada is a *requested* reviewer → "Awaiting your review".
const PR_7001 = {
  pullRequestId: 7001,
  title: "Refactor the parser",
  status: "active",
  sourceRefName: "refs/heads/refactor/parser",
  repository: { id: "repoB-guid", name: "applib" },
  isDraft: false,
  createdBy: { id: GRACE.id },
  creationDate: "2026-06-18T10:00:00.000Z",
  reviewers: [{ id: ME.id, isRequired: true, vote: 0 }],
};

const PR_7002 = {
  pullRequestId: 7002,
  title: "Speed up startup",
  status: "active",
  sourceRefName: "refs/heads/perf/startup",
  repository: { id: "repoA-guid", name: "appweb" },
  isDraft: false,
  createdBy: { id: GRACE.id },
  creationDate: "2026-06-12T10:00:00.000Z",
  reviewers: [{ id: ME.id, isRequired: true, vote: 10 }],
};

// ── work items ───────────────────────────────────────────────────────────────
// Raw ADO work-item objects ($expand=relations shape), keyed by id.
const WI_RAW: Record<number, any> = {
  101: {
    id: 101,
    fields: {
      "System.WorkItemType": "User Story",
      "System.Title": "Add login screen",
      "System.State": "In Progress",
      "System.BoardColumn": "Doing",
      "System.IterationPath": "Widgets\\Sprint 42",
      "System.TeamProject": "Widgets",
      "System.Tags": "HMI Framework; frontend",
    },
    relations: [
      { rel: "ArtifactLink", url: "vstfs:///Git/PullRequestId/proj-guid%2FrepoA-guid%2F5001" },
    ],
  },
  102: {
    id: 102,
    fields: {
      "System.WorkItemType": "Bug",
      "System.Title": "Fix crash on startup",
      "System.State": "Active",
      "System.IterationPath": "Widgets\\Sprint 42",
      "System.TeamProject": "Widgets",
    },
    relations: [],
  },
  103: {
    id: 103,
    fields: {
      "System.WorkItemType": "Task",
      "System.Title": "Update docs",
      "System.State": "New",
      "System.IterationPath": "Widgets\\Sprint 41",
      "System.TeamProject": "Widgets",
    },
    relations: [],
  },
  201: {
    id: 201,
    fields: {
      "System.WorkItemType": "User Story",
      "System.Title": "Tune the detector",
      "System.State": "In Progress",
      "System.BoardColumn": "Doing",
      "System.IterationPath": "Widgets\\Sprint 42",
      "System.TeamProject": "Widgets",
    },
    relations: [],
  },
};

// Which work items each person is assigned (matched on the WIQL AssignedTo).
const ASSIGNED: Record<string, number[]> = {
  [ME.emailAddress]: [101, 102, 103],
  [GRACE.uniqueName]: [201],
};
// Work items carrying the HMI Framework tag (the `f` filter narrows to these).
const HMI_TAGGED = new Set<number>([101]);

// Active PRs each person CREATED (searchCriteria.creatorId).
const CREATED: Record<string, number[]> = {
  [ME.id]: [5001, 6001],
  [GRACE.id]: [7001, 7002],
};
// Active PRs each person is a REVIEWER on (searchCriteria.reviewerId).
const REVIEWING: Record<string, number[]> = {
  [ME.id]: [7001, 7002],
  [GRACE.id]: [],
};

const PR_BY_ID: Record<number, any> = {
  5001: PR_5001,
  6001: PR_6001,
  7001: PR_7001,
  7002: PR_7002,
};

// Branch-policy evaluations per PR (artifactId carries the PR id). Shapes match
// what aggregateBuild / minApproverCount read.
const buildEval = (status: string) => ({
  configuration: { type: { displayName: "Build" } },
  status,
});
const minReviewersEval = (n: number) => ({
  configuration: { type: { displayName: "Minimum number of reviewers" }, settings: { minimumApproverCount: n } },
  status: "approved",
});
const POLICY_EVALS: Record<number, any[]> = {
  5001: [buildEval("approved"), minReviewersEval(1)], // CI ✓ pass, needs 1 approval
  7001: [buildEval("running"), minReviewersEval(1)], // CI ● running
  7002: [buildEval("approved"), minReviewersEval(1)], // CI ✓ pass
};

// Last PR iteration (push) time per PR → updatedDate. Distinct from creationDate
// so created/updated sort orders differ for 7001 vs 7002.
const PR_ITERATIONS: Record<number, string> = {
  5001: "2026-06-20T10:00:00.000Z",
  6001: "2026-06-16T10:00:00.000Z",
  7001: "2026-06-19T10:00:00.000Z", // created Jun18, updated Jun19
  7002: "2026-06-24T10:00:00.000Z", // created Jun12, updated Jun24 (newest update)
};

// Work-item ids linked from a PR (PR→workitems direction). Orphan 6001 links to
// nothing, so it stays an orphan; keeps the items view stable.
const PR_WORKITEMS: Record<number, number[]> = {};

// ── resolvers used by the mock server ───────────────────────────────────────────
/** WIQL → work-item id list, honouring the AssignedTo person + optional HMI tag. */
export function resolveWiql(query: string): { workItems: { id: number }[] } {
  const who = query.match(/\[System\.AssignedTo\]\s*=\s*'([^']+)'/)?.[1] ?? "";
  const hmiOnly = /\[System\.Tags\]\s+CONTAINS\s+'HMI Framework'/i.test(query);
  let ids = ASSIGNED[who] ?? [];
  if (hmiOnly) ids = ids.filter((id) => HMI_TAGGED.has(id));
  return { workItems: ids.map((id) => ({ id })) };
}

/** workitems?ids=… → the raw WI objects for those ids (order preserved). */
export function resolveWorkItems(idsParam: string | null): { value: any[] } {
  const ids = (idsParam ?? "").split(",").map((s) => Number(s.trim())).filter(Number.isFinite);
  return { value: ids.map((id) => WI_RAW[id]).filter(Boolean) };
}

/** /pullrequests?searchCriteria.{creatorId,reviewerId}=… → the matching PRs. */
export function resolvePullRequests(search: URLSearchParams): { value: any[] } {
  const creator = search.get("searchCriteria.creatorId");
  const reviewer = search.get("searchCriteria.reviewerId");
  let ids: number[] = [];
  if (creator) ids = CREATED[creator] ?? [];
  else if (reviewer) ids = REVIEWING[reviewer] ?? [];
  return { value: ids.map((id) => PR_BY_ID[id]).filter(Boolean) };
}

/** A single PR by repo + id (work-item relation resolution). */
export function resolveSinglePr(repoId: string, prId: number): any | null {
  const pr = PR_BY_ID[prId];
  return pr && pr.repository?.id === repoId ? pr : null;
}

/** Branch-policy evaluations for the PR named in a CodeReviewId artifactId. */
export function resolvePolicy(artifactId: string): { value: any[] } {
  const prId = Number(artifactId.split("/").pop());
  return { value: POLICY_EVALS[prId] ?? [] };
}

/** PR iterations → a single most-recent push (drives updatedDate). */
export function resolvePrIterations(prId: number): { value: any[] } {
  const d = PR_ITERATIONS[prId];
  return { value: d ? [{ createdDate: d }] : [] };
}

/** Work items linked from a PR (PR→workitems). */
export function resolvePrWorkItems(prId: number): { value: { id: number }[] } {
  return { value: (PR_WORKITEMS[prId] ?? []).map((id) => ({ id })) };
}

export const ADO = {
  ME,
  // The authenticated-profile (VSSPS) payload — getMe reads id/displayName/email.
  profile: { id: ME.id, displayName: ME.displayName, emailAddress: ME.emailAddress },
  iterations: { value: [{ id: "it-42", name: "Sprint 42", path: "Widgets\\Sprint 42" }] },
  project: { id: "proj-guid", name: "Widgets" },
  teamMembers: TEAM_MEMBERS,
  // Project teams (getProjectTeams). Empty → the graph traversal short-circuits,
  // exercising the "no team memberships" fallback (review reason stays "you").
  teams: { value: [] as { id: string; name: string }[] },
};
