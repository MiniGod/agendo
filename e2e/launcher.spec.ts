// End-to-end tests for the launcher TUI, rendered in a real browser via the
// wterm harness against a fully mocked environment (Azure DevOps, sessions on
// disk, tmux, git — all faked; see e2e/harness). Every test drives the UI with
// keystrokes and asserts on what the browser actually shows, or on what the
// launcher tried to spawn (recorded by the fake-bin shims).
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { test, expect, KEY } from "./harness/test.ts";
import { COMPACTING_PANE, RUNNING_TARGET, tmuxState } from "./harness/fixtures.ts";

// Regression guard for the "session-detection regresses often" area: a launcher
// scoped to a repo whose BASENAME CONTAINS A DOT (`kappflug.is-2`). The host
// session name is slugified (`.`→`-`), but live-session detection must key on the
// pane cwd / session id — never the lossy slug — so a session actually running in
// that context is detected as running and attachable, not shown cold.
test("path scope: a running session in a dotted-basename repo is detected as running", async ({ launch, mock }) => {
  // Keep the backend on ADO so this stays a pure detection test (a github.com
  // remote would force the GitHub backend — covered by its own test).
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // A repo whose basename has a dot, plus a worktree under it.
  const repo = join(mock.home, "git", "kappflug.is-2");
  const worktree = join(repo, ".claude", "worktrees", "add-keppni-7");
  const SID = "11112222-3333-4444-5555-666677778888";
  const shortId = SID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12); // → 111122223333

  // Write an on-disk claude session whose cwd is the dotted worktree.
  const logDir = join(mock.home, ".claude", "projects", "kappflug-dot");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    join(logDir, `${SID}.jsonl`),
    JSON.stringify({ type: "summary", cwd: worktree, gitBranch: "worktree-add-keppni-7", timestamp: "2026-06-25T10:00:00.000Z" }) +
      "\n" +
      JSON.stringify({ type: "ai-title", aiTitle: "Add keppni scoring", timestamp: "2026-06-25T10:00:01.000Z" }) +
      "\n",
  );

  // Make it live via an ID-LESS work-item window (`cl-wi-…`) whose pane cwd is the
  // dotted worktree — the cwd-attribution path (the fragile one), inside a
  // slugified host session `agendo-kappflug-is-2`.
  const READY = ["  ● Add keppni scoring", "  ────────────────────────────", "  ❯ ", "  ────────────────────────────", "  ? for shortcuts"].join("\n");
  await mock.setTmuxState({
    sessions: [RUNNING_TARGET, "agendo-kappflug-is-2"],
    windows: [{ session: "agendo-kappflug-is-2", index: 1, name: "cl-wi-777" }],
    panes: [
      { session: RUNNING_TARGET, window: RUNNING_TARGET, cwd: "/run/login", placeholder: false },
      { session: "agendo-kappflug-is-2", window: "cl-wi-777", cwd: worktree, placeholder: false },
    ],
    captures: { [RUNNING_TARGET]: READY, "cl-wi-777": READY },
  });

  const wt = await launch({ args: [repo], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  // The dotted-repo session must appear AND be detected running (green ● / attach),
  // not cold. `shortId` is unused here but documents the canonical name it maps to.
  const screen = await wt.waitForText("Add keppni scoring");
  expect(shortId).toBe("111122223333");
  expect(screen).toContain("kappflug.is-2"); // scoped to the dotted context
  // The session row for it shows a running marker, not the cold ○.
  expect(screen).toMatch(/●[^\n]*Add keppni scoring|Add keppni scoring[^\n]*(attach|running)/);
  expect(screen).toContain("Running now"); // it surfaces in the running section
});

// A path-scoped launcher (`agendo <path>`) filters the TUI to sessions under the
// path, and `a` toggles back to the global view. The fixture home has sessions
// under three repos (appweb ×2, applib ×1, standalone ×1); scoping to appweb
// hides the other two until the toggle reveals them again.
test("path scope: agendo <path> filters sessions; 'a' toggles global", async ({ launch, mock }) => {
  // appweb has an ADO origin here, so the path context does NOT force GitHub — it
  // keeps the persisted ADO default (see the github-forcing test below).
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const appweb = join(mock.home, "repos", "appweb");
  const wt = await launch({ args: [appweb], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  let screen = await wt.waitForText("appweb (2)");

  // Scoped: the scope line names the agendo-namespaced host session + advertises
  // the toggle; only the appweb repo is present — applib / standalone filtered out.
  expect(screen).toContain("agendo-appweb"); // host session is agendo-<context>, not bare "appweb"
  expect(screen).toContain("show all"); // scoped-state hint (a → show all)
  expect(screen).toContain("Implement login form"); // running appweb session
  expect(screen).not.toContain("applib (1)");
  expect(screen).not.toContain("standalone (1)");

  // Toggle to global with `a`: the other repos reappear, and the scope line flips
  // to a "rescope to agendo-appweb" hint.
  wt.write("a");
  screen = await wt.waitForText("applib (1)");
  expect(screen).toContain("standalone (1)");
  expect(screen).toContain("global — all paths");
  expect(screen).toContain("rescope to agendo-appweb");

  // Toggle back: scoped again, other repos hidden once more.
  wt.write("a");
  screen = await wt.waitForText("show all");
  expect(screen).not.toContain("applib (1)");
});

// When the path context is a github.com repo, the launcher FORCES the GitHub
// backend even though the persisted default is ADO — proving provider detection
// from the git remote overrides the configured default for a path context.
test("path scope: a github.com remote forces the GitHub backend over the ADO default", async ({ launch, mock }) => {
  // Persisted default stays ADO (fixture seeds provider: "ado"); we do NOT call
  // setProvider. The default git shim serves a github.com origin for the repo, so
  // detectRepoProvider → "github" wins. Seed the fake gh so the GitHub view loads.
  mock.env.FAKE_GIT_ORIGIN_HOST = "github";
  await mock.setGhState({
    authed: true,
    user: { login: "ada", name: "Ada Lovelace" },
    issues: {
      "ada/appweb": [
        { number: 301, title: "Header overlaps on mobile", state: "OPEN", url: "https://github.com/ada/appweb/issues/301", labels: [], author: { login: "ada" } },
      ],
    },
    prs: { "ada/appweb": { "involves:ada": [], "author:ada": [], "review-requested:ada": [] } },
  });

  const appweb = join(mock.home, "repos", "appweb");
  const wt = await launch({ args: [appweb], cols: 140, rows: 40 });

  // GitHub vocab proves the override: ADO would show "Current sprint" / "Work
  // items"; GitHub shows "Created by me" / "Issues", and the issue from gh.
  const screen = await wt.waitForText("Created by me", 20000);
  expect(screen).toContain("Issues"); // GitHub itemsTab (ADO would say "Work items")
  expect(screen).not.toContain("Current sprint"); // the ADO primary header is gone
  expect(screen).toContain("Header overlaps on mobile"); // data pulled via the gh code path
});

// Drive the new-session picker from the sessions view to the repo step:
// `3` → sessions, `n` → agent picker, enter (Claude) → repo picker. Returns the
// repo-picker screen text. Fails (via waitForText) if `n` bailed to a notice
// instead of opening the picker — exactly the scoped-empty dead-end we fix.
async function openRepoPicker(wt: import("./harness/wterm.ts").WebTerminal): Promise<string> {
  await wt.press("3");
  await wt.waitForStable();
  await wt.press("n");
  await wt.waitForText("New session — pick an agent");
  await wt.press(KEY.enter); // Claude is the first/default agent
  return wt.waitForText("New session — pick a repo");
}

// The picker's repo rows in RENDER ORDER, name column only. Every row carries a
// count cell (`N sessions` or the zero-count hint), which is what distinguishes
// them from the title/hint lines — keying on that rather than the root path also
// means a row long enough for Ink to WRAP contributes only its first line here,
// since a bare path fragment matches neither alternative.
// Order assertions must compare against the WHOLE list: `indexOf` anchors read
// as passing when a row is missing entirely (-1 is less than everything), so a
// reorder that silently DROPS repos would slip past a chain of toBeGreaterThan.
// No `.filter(Boolean)` on the way out, deliberately: a row that failed to yield
// a name should shorten the list and fail the toEqual loudly, not vanish from it.
function pickerRepoOrder(screen: string): string[] {
  return screen
    .split("\n")
    .filter((l) => /\d+ sessions|\(no sessions yet\)/.test(l))
    .map((l) => l.replace(/^\s*❯?\s*/, "").split(/\s{2,}/)[0]!.trim());
}

// The scoped folder itself must always be an offerable new-session repo, even
// when it has zero sessions — otherwise `agendo <fresh-dir>` → "＋ new session"
// dead-ends on an empty picker. These four cases pin the ensureRepoAtTop wiring.
test("new-session picker: scoped to a dir with NO sessions offers that dir as the top choice", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado"; // stay on the ADO backend (no github remote)
  // A real, session-less folder under the fake home — nothing in the fixtures
  // has ever run here, so it never appears in the session-derived repo list.
  const fresh = join(mock.home, "repos", "greenfield");
  await mkdir(fresh, { recursive: true });

  const wt = await launch({ args: [fresh], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // The scoped folder is present as a zero-count entry — the empty-state that
  // used to dead-end the flow ("No repos under this path") is gone.
  expect(picker).toContain("greenfield");
  expect(picker).toContain("(no sessions yet)");
  expect(picker).not.toContain("No repos under this path");
  // It's the only entry, so it's the top (highlighted ❯) choice.
  expect(picker).toMatch(/❯[^\n]*greenfield/);
});

test("new-session picker: scoped to an existing repo with sessions lists it once, ranked first", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // appweb has two sessions in the fixtures, so it's a real session-derived repo.
  const appweb = join(mock.home, "repos", "appweb");
  const wt = await launch({ args: [appweb], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // Present exactly once (no synthesized duplicate), keeping its real count, and
  // ranked first as the scoped folder.
  expect(picker).toMatch(/❯[^\n]*appweb[^\n]*2 sessions/);
  // Exactly one repo row (no synthesized duplicate) — one "N sessions" cell.
  expect(picker.match(/\d+ sessions/g)?.length).toBe(1);
  expect(picker).not.toContain("(no sessions yet)"); // it has sessions
  // Scoped: the other repos are filtered out entirely.
  expect(picker).not.toContain("applib");
  expect(picker).not.toContain("standalone");
});

test("new-session picker: scoped to a SUBDIR of a repo offers the repo root (resolved up)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // A fresh git checkout (…/labs with a .git marker) and a nested subdir. No
  // sessions here, so repoRootForCwd must walk UP from the subdir to the root.
  const repoRoot = join(mock.home, "repos", "labs");
  const subdir = join(repoRoot, "packages", "core");
  await mkdir(join(repoRoot, ".git"), { recursive: true });
  await mkdir(subdir, { recursive: true });

  const wt = await launch({ args: [subdir], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // The repo ROOT is offered (basename "labs"), not the scoped subdir "core",
  // so a worktree lands at the git root.
  expect(picker).toMatch(/❯[^\n]*\blabs\b/);
  expect(picker).toContain("(no sessions yet)");
  expect(picker).not.toMatch(/❯[^\n]*\bcore\b/);
});

// The hardest case, and a deliberate one: a scope that is a plain PARENT folder
// of several session-bearing repos. The folder still outranks them all, because
// a session in the folder itself is the orchestrator that supervises the agendo
// sessions running in the repos beneath it — that's the point of scoping there,
// so it must win cursor 0 over any child's session count.
test("new-session picker: scoped to a non-repo PARENT offers the parent itself as the top choice, above its repos", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // ~/repos is the fixtures' container dir: no `.git` of its own (and none up the
  // chain — the fake home lives in a fresh tmpdir), but it holds appweb (2
  // sessions), applib (1) and standalone (1).
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // The parent is the highlighted default, as a zero-count synth row — ranked
  // above appweb despite appweb having the most sessions in scope.
  expect(picker).toMatch(/❯\s+repos\b[^\n]*\(no sessions yet\)/);
  // Its children are all still listed below it, keeping their real counts —
  // being outranked is not being hidden.
  expect(picker).toMatch(/\n[^\n]*\bappweb\b[^\n]*2 sessions/);
  expect(picker).toMatch(/\n[^\n]*\bapplib\b[^\n]*1 sessions/);
  expect(picker).toMatch(/\n[^\n]*\bstandalone\b[^\n]*1 sessions/);
  // …and none of them stole the cursor from the parent.
  expect(picker).not.toMatch(/❯[^\n]*\bappweb\b/);

  // One step further: taking that default lands on the where-to-run choice, and
  // because ~/repos is NOT a git checkout the default must be "Main repo
  // checkout" (run in place). Defaulting to a worktree here would make the
  // enter-enter-enter happy path dead-end on "fatal: not a git repository".
  await wt.press(KEY.enter);
  const where = await wt.waitForText("choose where to run");
  expect(where).toMatch(/❯[^\n]*Main repo checkout/);
  expect(where).not.toMatch(/❯[^\n]*New git worktree/);
  expect(where).toContain("New git worktree"); // still offered, just not the default
});

// The mirror of the assertion above, so the where-to-run default is pinned in
// BOTH directions: a hardcoded "always run in place" would sail through the
// parent-folder test but must fail here. In a real checkout the worktree option
// works and stays the default — the run-in-place steer is only for non-repos.
test("new-session picker: a real git checkout still defaults to New git worktree", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // A session-less git checkout (the `.git` marker is what isGitCheckout reads),
  // so it reaches the picker as the scoped folder's synth row.
  const repo = join(mock.home, "repos", "greenlab");
  await mkdir(join(repo, ".git"), { recursive: true });

  const wt = await launch({ args: [repo], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  expect(picker).toMatch(/❯[^\n]*\bgreenlab\b/);

  await wt.press(KEY.enter);
  const where = await wt.waitForText("choose where to run");
  expect(where).toMatch(/❯[^\n]*New git worktree/);
  expect(where).not.toMatch(/❯[^\n]*Main repo checkout/);
});

// The scoped-folder-first rule is a NEW-SESSION rule, and stops at the flows
// that can honour it. A work item (and likewise a PR) always creates a worktree
// — there is no run-in-place option to fall back to — so a non-repo scoped
// parent at cursor 0 would turn the enter-enter-enter path into "fatal: not a
// git repository". It gets demoted to last for those targets, but stays on the
// list. Drives the fresh flow from a work item, not `n`, to reach that branch.
test("fresh-session picker (work item): a non-repo scoped parent is demoted below the real repos", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos"); // no `.git`; holds appweb / applib / standalone
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  // WI 101 → "+ start a fresh session…" → agent picker → repo picker.
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // session row
  await wt.press(KEY.down); // fresh row
  await wt.press(KEY.enter);
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // Claude
  const picker = await wt.waitForText("Pick a repo to create the worktree in");

  // A repo that can actually host a worktree holds the cursor…
  expect(picker).toMatch(/❯[^\n]*\bappweb\b[^\n]*2 sessions/);
  // …while the scoped parent is still offered, just never the default…
  expect(picker).toContain("(no sessions yet)");
  expect(picker).not.toMatch(/❯[^\n]*\(no sessions yet\)/);
  // …and demoted below every real repo. Full-order compare, so a partition that
  // dropped or reordered the hostable repos can't hide behind a positional check.
  expect(pickerRepoOrder(picker)).toEqual(["appweb", "applib", "standalone", "repos"]);
});

// The above with the scoped parent no longer session-less — which is where the
// feature LANDS after one use, not an exotic edge: the orchestrator free session
// runs in ~/repos itself, the local scan picks it up, and `discoverRepos` starts
// emitting a ~/repos entry. That entry is NOT evidence of a repo — repoRootForCwd
// falls back to the raw cwd when its walk-up finds no `.git`, so a session in a
// plain folder produces one just the same. The demotion must key on "can this
// host a worktree", never on "has this been used".
test("fresh-session picker (work item): a non-repo scoped parent stays demoted once it has its own session", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");

  // A session whose cwd is the parent folder ITSELF (what the orchestrator entry
  // point creates). Its branch is digit-free and matches no PR, so it stays an
  // unlinked session and can't perturb WI 101's expanded rows below.
  const logDir = join(mock.home, ".claude", "projects", "orchestrator");
  await mkdir(logDir, { recursive: true });
  await writeFile(
    join(logDir, "orchestrator-session.jsonl"),
    JSON.stringify({ type: "summary", cwd: parent, gitBranch: "orchestration", timestamp: "2026-06-21T10:00:00.000Z" }) +
      "\n" +
      JSON.stringify({ type: "ai-title", aiTitle: "Supervise the fleet", timestamp: "2026-06-21T10:00:01.000Z" }) +
      "\n",
  );

  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // session row
  await wt.press(KEY.down); // fresh row
  await wt.press(KEY.enter);
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // Claude
  const picker = await wt.waitForText("Pick a repo to create the worktree in");

  // ~/repos now carries a session count, so it renders as a normal row — but it
  // still can't host a worktree, so appweb keeps the cursor and the parent sits
  // last. A `total`-based "is this synthesized" shortcut fails right here.
  expect(picker).toMatch(/❯[^\n]*\bappweb\b[^\n]*2 sessions/);
  expect(picker).toMatch(/\brepos\b[^\n]*1 sessions/); // present, with its real count
  expect(picker).not.toMatch(/❯[^\n]*\brepos\s{2}/); // but not holding the cursor
  expect(pickerRepoOrder(picker)).toEqual(["appweb", "applib", "standalone", "repos"]);
});

// The demotion has to hold for EVERY position, not just the head. A plain folder
// with more sessions than any real checkout sorts above them all, so after the
// scoped parent is pushed down, the next entry in line is another folder that
// can't host a worktree either — and it would silently inherit cursor 0. Only
// checking index 0 turns one dead-end into a different one.
test("fresh-session picker (work item): a session-rich plain folder mid-list never inherits the cursor", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const scratch = join(parent, "scratch"); // plain folder, no `.git`, never a checkout
  await mkdir(scratch, { recursive: true });

  // Three sessions in scratch, so it out-counts appweb (2) and sorts to the top
  // of the discovered list — above every real repo. Digit-free branches, so none
  // of them links to a work item and perturbs WI 101's expanded rows.
  const logDir = join(mock.home, ".claude", "projects", "scratch");
  await mkdir(logDir, { recursive: true });
  for (const slug of ["notes", "spike", "triage"]) {
    await writeFile(
      join(logDir, `scratch-${slug}.jsonl`),
      JSON.stringify({ type: "summary", cwd: scratch, gitBranch: slug, timestamp: "2026-06-21T10:00:00.000Z" }) +
        "\n" +
        JSON.stringify({ type: "ai-title", aiTitle: `Scratch ${slug}`, timestamp: "2026-06-21T10:00:01.000Z" }) +
        "\n",
    );
  }

  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // session row
  await wt.press(KEY.down); // fresh row
  await wt.press(KEY.enter);
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // Claude
  const picker = await wt.waitForText("Pick a repo to create the worktree in");

  // scratch is listed with its winning session count, but a real checkout holds
  // the cursor — the partition ranks ALL hostable repos above ALL unhostable
  // ones, so neither the scoped parent nor scratch can take the default.
  expect(picker).toMatch(/\bscratch\b[^\n]*3 sessions/);
  expect(picker).toMatch(/❯[^\n]*\bappweb\b[^\n]*2 sessions/);
  expect(picker).not.toMatch(/❯[^\n]*\bscratch\b/);
  // Every hostable repo above every unhostable one, each group keeping its own
  // session-count ranking — the exact contract of the stable partition. scratch
  // (3) outranks appweb (2) in the raw list and still lands below it here.
  expect(pickerRepoOrder(picker)).toEqual(["appweb", "applib", "standalone", "repos", "scratch"]);
});

test("new-session picker: UNSCOPED lists all session-derived repos, unchanged ranking", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch(); // bare `agendo` → global launcher, no filterRoot
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // All three session-derived repos show, ranked by session count: appweb (2)
  // first, then applib / standalone. No synthesized zero-count entry appears.
  expect(picker).toContain("appweb");
  expect(picker).toContain("applib");
  expect(picker).toContain("standalone");
  expect(picker).toMatch(/❯[^\n]*appweb[^\n]*2 sessions/);
  expect(picker).not.toContain("(no sessions yet)");
});

// ── the brand-new user: no sessions anywhere ──────────────────────────────────
// The unscoped repo list is derived ENTIRELY from where past sessions ran, so a
// fresh install has nothing to offer — and since the only way a repo enters that
// list is by already having a session in it, an empty picker locks the user out
// permanently. Reproduced the only safe way: an empty fixture HOME, never by
// touching real session data. `cwd` is what the launcher falls back to, so these
// pass it explicitly rather than a `[path]` arg (which takes the scoped route).

/** Strip every session out of the fixture home — both agent backends' stores —
 *  leaving the ADO/config fixtures intact so the TUI still loads normally. */
async function wipeSessions(home: string): Promise<void> {
  await rm(join(home, ".claude", "projects"), { recursive: true, force: true });
  await rm(join(home, ".copilot"), { recursive: true, force: true });
}

test("new-session picker: a brand-new user with NO sessions is offered the launcher's cwd", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await wipeSessions(mock.home);
  // The checkout the user is standing in when they run bare `agendo`.
  const repo = join(mock.home, "repos", "firstrepo");
  await mkdir(join(repo, ".git"), { recursive: true });

  const wt = await launch({ cwd: repo, cols: 140, rows: 40 }); // bare `agendo`, no path arg
  await wt.waitForText("Current sprint", 20000);

  // `n` must open the picker, not bail to the old "open or resume a session in a
  // repo first" notice — advice that was impossible to follow from here.
  const picker = await openRepoPicker(wt);
  expect(picker).toMatch(/❯[^\n]*\bfirstrepo\b/);
  expect(picker).toContain("(no sessions yet)");
  expect(picker).not.toContain("open or resume a session");

  // It's a real checkout, so the happy path stays enter-enter-enter into a worktree.
  await wt.press(KEY.enter);
  const where = await wt.waitForText("choose where to run");
  expect(where).toMatch(/❯[^\n]*New git worktree/);
});

test("new-session picker: no sessions and cwd is a SUBDIR of a repo offers the repo root", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await wipeSessions(mock.home);
  const repo = join(mock.home, "repos", "firstrepo");
  const subdir = join(repo, "packages", "core");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(subdir, { recursive: true });

  const wt = await launch({ cwd: subdir, cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  // Resolved UP to the git root, so a worktree lands at the root — same rule the
  // scoped picker applies to a `[path]` inside a checkout.
  const picker = await openRepoPicker(wt);
  expect(picker).toMatch(/❯[^\n]*\bfirstrepo\b/);
  expect(picker).not.toMatch(/❯[^\n]*\bcore\b/);
});

// $HOME tracked as a git repo (chezmoi / yadm / a bare dotfiles checkout) is a
// common setup, and it poisons the cwd fallback: `repoRootForCwd` walks up to
// the nearest ancestor `.git`, so ANY non-repo cwd resolves to $HOME. Offering
// that as a checkout would make enter-enter-enter `git worktree add` into
// `$HOME/.claude/worktrees/<name>` — a worktree of the user's dotfiles inside the
// live Claude Code config dir agendo itself scans for sessions. The fallback
// must stop below $HOME instead (bootstrapRepoRoot).
test("new-session picker: a dotfiles $HOME is never inferred as the bootstrap repo", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await wipeSessions(mock.home);
  await mkdir(join(mock.home, ".git"), { recursive: true }); // $HOME is a checkout
  const plain = join(mock.home, "projects", "newthing"); // …but the cwd is not
  await mkdir(plain, { recursive: true });

  const wt = await launch({ cwd: plain, cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // The cwd is offered, NOT the dotfiles repo the walk-up would have reached.
  expect(picker).toMatch(/❯[^\n]*\bnewthing\b/);
  expect(pickerRepoOrder(picker)).toEqual(["newthing"]);

  // And because it isn't a checkout, the where-to-run step defaults to running in
  // place — never "New git worktree", which is the step that would have written
  // into ~/.claude/worktrees.
  await wt.press(KEY.enter);
  const where = await wt.waitForText("choose where to run");
  expect(where).toMatch(/❯[^\n]*Main repo checkout/);
  expect(where).not.toMatch(/❯[^\n]*New git worktree/);
});

// The genuinely undiscoverable case: no sessions AND the cwd isn't a checkout.
// The free flow can still run in place there, but a work item structurally must
// create a worktree — so instead of an empty list (or an enter that dead-ends on
// "fatal: not a git repository") the picker has to say what would unblock it.
test("fresh-session picker (work item): no sessions and a non-repo cwd shows an actionable hint", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await wipeSessions(mock.home);
  const plain = join(mock.home, "somewhere"); // no `.git`, nothing under it
  await mkdir(plain, { recursive: true });

  const wt = await launch({ cwd: plain, cols: 140, rows: 40 });
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  // WI 101 → "+ start a fresh session…" → agent picker → repo picker. With no
  // sessions the item has no session rows, so the fresh row is one step down.
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // fresh row
  await wt.press(KEY.enter);
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // Claude
  const picker = await wt.waitForText("Pick a repo to create the worktree in");

  expect(picker).toContain("No git checkout here");
  expect(picker).toContain("somewhere"); // still offered, for someone about to `git init`

  // The free flow gets no such warning — running in place is a valid outcome there.
  await wt.press(KEY.escape); // → agent picker
  await wt.waitForStable();
  await wt.press(KEY.escape); // → list
  await wt.waitForStable();
  const free = await openRepoPicker(wt);
  expect(free).toMatch(/❯[^\n]*\bsomewhere\b/);
  expect(free).not.toContain("No git checkout here");
});

// Poll an async predicate until it's true, or fail. Used for side effects that
// land in the fake-bin logs slightly after a keystroke.
async function waitUntil(fn: () => Promise<boolean>, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

test("work items view: sprint grouping, PR badge, running count, backlog toggle", async ({ launch }) => {
  const wt = await launch();
  const screen = await wt.waitForText("Current sprint", 20000);

  // Current iteration name comes from the mocked ADO iterations endpoint.
  expect(screen).toContain("Sprint 42");
  // WI 101 with its linked PR (badge shows approval 1/1 + ✓ CI from policy
  // enrichment) and a running session (● 1/1).
  expect(screen).toContain("Add login screen");
  expect(screen).toMatch(/Add login screen.*!5001 1\/1 ✓.*●\s*1\/1/);
  // WI 102 has no PR but a session matched by id-in-branch.
  expect(screen).toContain("Fix crash on startup");
  // WI 103 is in an older sprint → collapsed under the backlog toggle.
  expect(screen).toContain("Everything else assigned (1)");
  expect(screen).not.toContain("Update docs");
});

test("backlog toggle expands to reveal the older-sprint item", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Everything else assigned (1)", 20000);
  await wt.waitForStable();
  // Move to the toggle row (item101 → item102 → toggle) and open it.
  await wt.press(KEY.down);
  await wt.press(KEY.down);
  await wt.press(KEY.enter);
  const screen = await wt.waitForText("Update docs");
  expect(screen).toMatch(/#103\s+Task\s+New\s+Update docs/);
});

test("PRs view: linked PR with work-item context and orphan draft PR", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("2");
  const screen = await wt.waitForText("PRs on your work items");
  // Linked PR row: approval ✓ 1/1, CI ✓ pass, the work-item context cell.
  expect(screen).toMatch(/!5001\s+✓ 1\/1\s+✓ pass\s+Add login screen\s+#101 User Story/);
  expect(screen).toContain("PRs without a work item");
  // Orphan PR 6001 is a draft on the applib repo (draft replaces the CI cell).
  // Its context cell shows repo:branch (truncated by the narrow CONTEXT column).
  expect(screen).toMatch(/!6001\s+—\s+draft\s+Experiment spike/);
  expect(screen).toMatch(/applib:draft\/exp/);
  // The review section surfaces Grace's PRs where Ada is a requested reviewer.
  expect(screen).toContain("Awaiting your review");
  expect(screen).toMatch(/!7001\s+✓ 0\/1\s+● running\s+Refactor the parser/);
  expect(screen).toMatch(/!7002\s+✓ 1\/1\s+✓ pass\s+Speed up startup/);
});

test("sessions view: Running now section plus per-repo groups", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  const screen = await wt.waitForText("Running now");
  // The single live session surfaces in Running now (green ●, attach hint).
  // Its pane capture is an idle claude TUI → readiness "ready".
  expect(screen).toMatch(/Running now\s+\(1\)/);
  expect(screen).toContain("Implement login form");
  expect(screen).toContain("(ready → attach)");
  // Repos grouped, ranked by session count: appweb(2), applib(1), standalone(1).
  expect(screen).toContain("appweb (2)");
  expect(screen).toContain("applib (1)");
  expect(screen).toContain("standalone (1)");
});

test("sessions view: a compacting session says so, and how far along it is", async ({ launch, mock }) => {
  // Before this, `runningStatus` had no `compacting` case at all, so a session
  // rewriting its own context fell through to the green "running → attach" — the
  // one blocking state the menu rendered as idle and attachable. The percentage
  // comes off the pane's own progress bar, so the row says whether to wait.
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: COMPACTING_PANE } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  const screen = await wt.waitForText("Running now");
  expect(screen).toContain("(compacting… · 42%)");
  expect(screen).not.toContain("ready → attach");
});

test("expanding a work item reveals its session and lazily-loaded activity", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("Implement login form");
  await wt.press(KEY.down); // move onto the session row
  await wt.press(KEY.right); // expand it → triggers lazy activity load
  const screen = await wt.waitForText("bun test login", 8000);
  // Last prompt header + parsed action lines from the session's JSONL log.
  expect(screen).toContain('"Add a login form with validation"');
  expect(screen).toContain("login.tsx");
  expect(screen).toContain("Edit");
  expect(screen).toContain("+ start a fresh session…");

  // Capture a reference screenshot of the fully-rendered TUI for documentation.
  await wt.screenshot(join(import.meta.dirname, "screenshots", "launcher.png"));
});

test("expanded session shows the agent's task checklist with per-item status", async ({ launch }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("Implement login form");
  await wt.press(KEY.down); // move onto the session row
  await wt.press(KEY.right); // expand it → lazy activity load (incl. checklist)

  // The latest TodoWrite checklist renders as three rows with distinct glyphs:
  // ✔ completed, ◐ in-progress, ☐ pending.
  const screen = await wt.waitForText("Wire up the submit handler", 8000);
  expect(screen).toMatch(/✔\s*Write the login form/);
  expect(screen).toMatch(/◐\s*Add validation/);
  expect(screen).toMatch(/☐\s*Wire up the submit handler/);
});

test("open-in-browser dialog opens the work item via xdg-open", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();
  wt.write("o"); // open-in-browser dialog for the hovered WI 101
  const dialog = await wt.waitForText("Open in browser");
  expect(dialog).toContain("PR !5001");
  expect(dialog).toContain("issue #101");

  wt.write("i"); // open the issue (work item)
  await wt.waitForText("Opening #101 in browser…");
  await waitUntil(async () =>
    (await mock.callLog()).some((l) => l.startsWith("xdg-open ") && l.includes("/_workitems/edit/101")),
  );
});

test("fresh-session flow creates a worktree and launches claude in tmux", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  await wt.press(KEY.enter); // expand WI 101
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // onto the session row
  await wt.press(KEY.down); // onto "+ start a fresh session…"
  await wt.press(KEY.enter); // → agent picker (first step of every fresh flow)

  // Every fresh flow now begins by choosing the agent; Claude is the first entry.
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // pick Claude → repo picker

  await wt.waitForText("Pick a repo to create the worktree in");
  await wt.press(KEY.enter); // pick the top repo (appweb)

  const branchScreen = await wt.waitForText("New branch off origin/HEAD");
  // Default branch derived from the work item id + slugified title.
  expect(branchScreen).toContain("worktree-add-login-screen-101");
  await wt.press(KEY.enter); // create worktree & launch

  const expectedCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "add-login-screen-101");

  // git worktree add was invoked for that path (fake git just mkdir's it).
  await waitUntil(async () =>
    (await mock.callLog()).some(
      (l) => l.startsWith("git ") && l.includes("worktree") && l.includes(expectedCwd),
    ),
  );
  // claude was launched in a tmux session named cl-wi-101 in the new worktree.
  await waitUntil(async () => {
    const log = await mock.tmuxLog();
    return log.some(
      (argv) =>
        argv[0] === "new-session" &&
        argv.includes("cl-wi-101") &&
        argv.includes(expectedCwd) &&
        argv.includes("claude"),
    );
  });
});

// ── orchestrator mode from the TUI (`O` in the Sessions view) ─────────────────
// The one-keypress entry point. It must be advertised, reuse the existing
// repo → worktree → name flow (including the scoped-repo behaviour), and end up
// spawning a claude that actually carries the orchestrator instructions.
test("O in the Sessions view launches an orchestrator through the normal worktree flow", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3"); // Sessions view
  let screen = await wt.waitForText("Running now");
  // The action is discoverable, alongside the existing `n new`.
  expect(screen).toContain("O orchestrator");

  wt.write("O");
  // Straight to the repo picker — no agent step, since the mode is Claude-only.
  screen = await wt.waitForText("Orchestrator session — pick a repo");
  expect(screen).toContain("writes no code itself");
  expect(screen).not.toContain("Which agent should run this session?");
  // Same repo list the plain new-session flow offers (scoped-repo behaviour reused).
  expect(screen).toContain("appweb");

  await wt.press(KEY.enter); // top repo (appweb) → worktree-vs-main choice
  screen = await wt.waitForText("choose where to run");
  expect(screen).toContain("Orchestrator session in appweb");
  // The choice explains itself, and the cursor already sits on the main checkout —
  // git keeps the main branch in one working tree, and merging is the whole job.
  expect(screen).toContain("git keeps that");
  expect(screen).toMatch(/❯\s+Main repo checkout/);

  // Accepting that default launches immediately: there's no branch to name, so no
  // prompt whose value would just be discarded.
  await wt.press(KEY.enter);

  // It runs in the repo ROOT, not a worktree, under a `cl-new-…` target, carrying
  // the orchestrator instructions.
  const expectedCwd = join(mock.home, "repos", "appweb");
  await waitUntil(async () => {
    const spawned = (await mock.tmuxLog()).find(
      (argv) => argv[0] === "new-session" && argv.includes(expectedCwd) && argv.includes("claude"),
    );
    if (!spawned) return false;
    const appended = spawned[spawned.indexOf("--append-system-prompt") + 1] ?? "";
    return (
      spawned.some((a) => a.startsWith("cl-new-")) &&
      appended.includes("ORCHESTRATOR MODE") &&
      appended.includes("Never write project code yourself") &&
      appended.includes("do not open a pull request") &&
      // The launcher's own pointer must still ride along in the same value.
      appended.includes("You are running inside agendo")
    );
  });
  // No worktree was created for it.
  expect((await mock.callLog()).some((l) => l.startsWith("git ") && l.includes("worktree"))).toBe(false);
});

// The isolation escape hatch is still reachable in the TUI: pick "New git worktree"
// and the role-slug branch prompt appears as before.
test("the orchestrator flow can still opt into its own worktree", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  await wt.waitForText("Running now");
  wt.write("O");
  await wt.waitForText("Orchestrator session — pick a repo");
  await wt.press(KEY.enter); // appweb → wtchoice (cursor on "Main repo checkout")
  await wt.waitForText("choose where to run");
  await wt.press(KEY.up); // move up to "New git worktree"
  await wt.press(KEY.enter);

  // Now the branch prompt appears, prefilled with the ROLE slug. Assert on the
  // labelled field, not a bare "orchestrator" substring — the same screen renders
  // "→ claude (orchestrator mode)", which would satisfy that even if empty.
  const screen = await wt.waitForText("New branch off origin/HEAD");
  expect(screen).toMatch(/branch:\s*orchestrator/);
  expect(screen).toContain("(orchestrator mode)");

  await wt.press(KEY.enter);
  const expectedCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "orchestrator");
  await waitUntil(async () =>
    (await mock.callLog()).some((l) => l.startsWith("git ") && l.includes("worktree") && l.includes(expectedCwd)),
  );
});

test("n in the Sessions view still launches a plain session (no orchestrator prompt)", async ({ launch, mock }) => {
  // The inverse guard: adding `O` must not have turned every manual session into
  // an orchestrator, and `n` must still offer the agent picker it always did.
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  wt.write("3");
  await wt.waitForText("Running now");

  wt.write("n");
  await wt.waitForText("Which agent should run this session?"); // agent step is intact
  await wt.press(KEY.enter); // Claude
  await wt.waitForText("New session — pick a repo");
  await wt.press(KEY.enter); // appweb
  await wt.waitForText("choose where to run");
  await wt.press(KEY.enter); // new worktree
  await wt.waitForText("New session in appweb");
  // A plain free session has no prefilled name — type one.
  wt.write("scratch");
  await wt.waitForText("scratch");
  await wt.press(KEY.enter);

  const expectedCwd = join(mock.home, "repos", "appweb", ".claude", "worktrees", "scratch");
  await waitUntil(async () =>
    (await mock.tmuxLog()).some((argv) => argv[0] === "new-session" && argv.includes(expectedCwd) && argv.includes("claude")),
  );
  const spawned = (await mock.tmuxLog()).find(
    (argv) => argv[0] === "new-session" && argv.includes(expectedCwd) && argv.includes("claude"),
  )!;
  const appended = spawned[spawned.indexOf("--append-system-prompt") + 1] ?? "";
  expect(appended).toContain("You are running inside agendo");
  expect(appended).not.toContain("ORCHESTRATOR MODE");
});

test("renders identically with the running session flipped off", async ({ launch, mock }) => {
  // Flip fake-tmux to have no live sessions before launch: badge goes gray.
  await mock.setTmuxState({ sessions: [], windows: [], panes: [] });
  const wt = await launch();
  const screen = await wt.waitForText("Add login screen", 20000);
  // No green running count for WI 101 now — just "1 sess".
  expect(screen).toMatch(/Add login screen.*1 sess/);
  expect(screen).not.toContain("● 1/1");
  // Sanity: the canonical target we toggled is the login session's.
  expect(RUNNING_TARGET).toBe("cl-claude-loginsession");
});

// ── hands-off auto-resume from the numbered limit dialog ────────────────────────
// The numbered limit dialog hides its reset time, so the resetAt-gated resume can
// never fire on it. With auto-resume ON the readiness poll must send ONE Escape to
// reveal the "resets <time>" notice, exactly once per limit window, and never a
// stray `continue`. These drive the real Ink poll against the fake tmux and assert
// on the recorded send-keys — the end-to-end proof the wiring closes the gap.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The active numbered dialog (a `─`-ruled table above it, no input-box rule below).
const LIMIT_DIALOG = [
  "  ● Done. Work item created.",
  "  ┌───────────┬─────────────────────────────────────┐",
  "  │ State     │ In Review                           │",
  "  └───────────┴─────────────────────────────────────┘",
  "  What do you want to do?",
  "  ❯ 1. Stop and wait for limit to reset",
  "    2. Add funds to continue with usage credits",
  "  Enter to confirm · Esc to cancel",
].join("\n");

// send-keys argv (from the fake-tmux log) aimed at the login window.
const keysTo = async (mock: { tmuxLog: () => Promise<string[][]> }, target: string) =>
  (await mock.tmuxLog()).filter((a) => a[0] === "send-keys" && a.includes(target));

test("auto-resume ON: the limit dialog is revealed with exactly ONE Escape, never 'continue'", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // Persist auto-resume ON (the poll reads the setting at mount); keep the ADO
  // backend the fixture pins so the model still loads.
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: true }));
  // Park the running session in the numbered dialog (no reset time shown).
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_DIALOG } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);

  // The poll sends the reveal Escape.
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).some((a) => a.includes("Escape")));
  // Several more poll cycles (READINESS_MS = 1500ms) must NOT re-send: once-only.
  await sleep(4000);
  let keys = await keysTo(mock, RUNNING_TARGET);
  expect(keys.filter((a) => a.includes("Escape"))).toHaveLength(1); // exactly one reveal
  expect(keys.some((a) => a.includes("continue"))).toBe(false); // never continue on reveal
  expect(keys.some((a) => a.includes("Enter"))).toBe(false);

  // Recovery clears the reveal guard: flip to a ready pane, then back to the dialog.
  await mock.setTmuxState({ ...tmuxState }); // default READY pane → "ready"
  await sleep(3000); // let the poll observe recovery and clear the guard
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_DIALOG } });
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).filter((a) => a.includes("Escape")).length >= 2);
  keys = await keysTo(mock, RUNNING_TARGET);
  expect(keys.filter((a) => a.includes("Escape"))).toHaveLength(2); // re-revealed for the new window
  expect(keys.some((a) => a.includes("continue"))).toBe(false);
});

test("auto-resume OFF: the limit dialog is left untouched (no Escape, no keystrokes)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // Setting OFF (default) — write it explicitly for clarity.
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: false }));
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMIT_DIALOG } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  // Give the poll several cycles; with the setting off it must never mutate the pane.
  await sleep(4000);
  const keys = await keysTo(mock, RUNNING_TARGET);
  expect(keys).toHaveLength(0);
});

// ── session-discovery staleness: the fast timer must RE-SCAN, not just reconcile ──
// The liveness poll used to reconcile fresh tmux windows against the STALE session
// index from the last full loadModel, so a session started afterwards was dropped
// (never entered liveWindows, never readiness-polled, never auto-resumed). The
// timer now re-runs the cheap local scan (loadLocalSessions). These drive the real
// app + fake tmux and assert on the recorded tmux/ADO calls.

// Write an on-disk claude session so SessionIndex.build() discovers it on rescan.
async function writeSession(home: string, id: string, cwd: string, title: string, branch = "feature/late") {
  const logDir = join(home, ".claude", "projects", `late-${id.slice(0, 8)}`);
  await mkdir(logDir, { recursive: true });
  await writeFile(
    join(logDir, `${id}.jsonl`),
    JSON.stringify({ type: "summary", cwd, gitBranch: branch, timestamp: "2026-07-08T09:00:00.000Z" }) + "\n" +
      JSON.stringify({ type: "ai-title", aiTitle: title, timestamp: "2026-07-08T09:00:01.000Z" }) + "\n",
  );
}
const shortIdOf = (id: string) => id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
const IDLE_READY = ["  ● idle", "  ────────────────────────────", "  ❯ ", "  ────────────────────────────", "  ? for shortcuts"].join("\n");

test("(a) a session started AFTER the initial load appears + is live-polled within one rescan (no `r`)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  wt.write("3"); // Sessions view
  await wt.waitForText("Running now");

  // A brand-new claude session appears on disk AND as a live id-bearing window,
  // both AFTER the initial full load — exactly the window the stale index dropped.
  const SID = "99998888-7777-6666-5555-444433332222";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "appweb");
  await writeSession(mock.home, SID, cwd, "Late arriving session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { ...tmuxState.captures, [win]: IDLE_READY },
  });

  // Without pressing `r`: the rescan discovers it, so it shows up in the list...
  await wt.waitForText("Late arriving session", 12000);
  // ...and its window entered liveWindows — proven by the readiness poll capturing
  // its pane (the poll only reads windows in model.liveWindows).
  await waitUntil(async () => (await mock.tmuxLog()).some((a) => a[0] === "capture-pane" && a.includes(win)));
});

test("(b) the fast rescan does NO backend fetch; work items stay put across several rescans", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000); // full load done (items rendered)

  await sleep(1000); // let any tail of the initial load's ADO calls settle
  const before = mock.ado.requests.length;

  // Add a new live session mid-run so rescans have real work + a model change.
  const SID = "12341234-5678-5678-9012-901290129012";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "appweb");
  await writeSession(mock.home, SID, cwd, "Another late session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { ...tmuxState.captures, [win]: IDLE_READY },
  });

  await sleep(6000); // several LIVE_POLL_MS rescans go by
  // Not one extra backend request — the slow fetch stays on the `r` cadence.
  expect(mock.ado.requests.length).toBe(before);
  // The network-derived work items are preserved from the last full load...
  const screen = await wt.waitForText("Add login screen");
  expect(screen).toContain("Add login screen");
  // ...and the rescan still surfaced the new session (proving it DID run).
  wt.write("3");
  await wt.waitForText("Another late session", 12000);
});

test("(c) the fast rescan spawns NO `git` process — the unpushed-work signal stays off the hot path", async ({ launch, mock }) => {
  // Sibling guard to (b), for the shell rather than the network. `agendo status`
  // / `list --json` report whether a checkout holds unpushed work; that answer is
  // read from `.git` ref files precisely because SessionIndex.build() /
  // loadLocalSessions() — which this 2s timer drives — must never spawn `git`.
  // A per-repo spawn here is the ~62% CPU regression the parse cache exists to
  // prevent, so the count of git invocations must not move across rescans.
  //
  // Scope: this catches a subprocess re-implementation of the signal. Moving the
  // (spawn-free) ref reader itself onto this path wouldn't show up here — that is
  // pinned separately by the static import check in cli.spec.ts.
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000); // full load done

  // Snapshot only once the initial load's own git calls have stopped arriving —
  // a fixed sleep would race a late one and move the count under us.
  const gitCalls = async () => (await mock.callLog()).filter((l) => l.startsWith("git ")).length;
  let before = -1;
  for (let i = 0; i < 10; i++) {
    const n = await gitCalls();
    if (n === before) break;
    before = n;
    await sleep(1000);
  }

  // A new session mid-run in a repo root the initial load has NEVER seen. That
  // matters: a naive per-repo `git` call memoized by root (the pattern already
  // in src/sessions.ts) would spawn nothing for an already-indexed root, so the
  // regression would slip past a probe pointed at appweb.
  const SID = "55556666-7777-8888-9999-aaaabbbbcccc";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "probe");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await writeSession(mock.home, SID, cwd, "Unpushed probe session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { ...tmuxState.captures, [win]: IDLE_READY },
  });

  await sleep(6000); // several LIVE_POLL_MS rescans go by
  expect(await gitCalls()).toBe(before);
  // …and the rescan really did run (otherwise the assertion above is vacuous).
  wt.write("3");
  await wt.waitForText("Unpushed probe session", 12000);
});

test("(d) a rescan must not re-fire `continue` for an already-resumed limited window", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: true }));
  // A limited pane whose reset time is an EXPLICIT past date (yesterday 3pm) — an
  // explicit month+day parses to that concrete instant (unlike a bare time, which
  // rolls forward and could land in the future near midnight), so it's reliably
  // in the past and within RESET_LOOKBACK → auto-resume fires on the first sample.
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const yst = new Date(Date.now() - 24 * 3600_000);
  const label = `3:00pm ${MON[yst.getMonth()]} ${yst.getDate()}`;
  const rule = "  ─────────────────────────────────────────────";
  const LIMITED_PAST = [
    `  Claude usage limit reached. Your limit will reset at ${label}.`,
    rule,
    "  ❯ ",
    rule,
    "  ? for shortcuts",
  ].join("\n");
  await mock.setTmuxState({ ...tmuxState, captures: { [RUNNING_TARGET]: LIMITED_PAST } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);

  // It fires the resume exactly once.
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).some((a) => a.includes("continue")));
  const continues = async () => (await keysTo(mock, RUNNING_TARGET)).filter((a) => a.includes("continue")).length;
  expect(await continues()).toBe(1);

  // Now force a rescan MODEL CHANGE (a new session appears) → the readiness effect
  // re-arms and re-samples. The frozen resetAt + fire-once guard must survive the
  // rescan, so `continue` is NOT sent again.
  const SID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
  const win = `cl-claude-${shortIdOf(SID)}`;
  const cwd = join(mock.home, "repos", "appweb");
  await writeSession(mock.home, SID, cwd, "Bystander session");
  await mock.setTmuxState({
    ...tmuxState,
    windows: [{ session: RUNNING_TARGET, index: 1, name: win }],
    panes: [...tmuxState.panes, { session: RUNNING_TARGET, window: win, cwd, placeholder: false }],
    captures: { [RUNNING_TARGET]: LIMITED_PAST, [win]: IDLE_READY },
  });
  // Wait for the rescan to pick up the bystander (proves the re-arm happened)…
  wt.write("3");
  await wt.waitForText("Bystander session", 12000);
  await sleep(3000); // …and several more samples of the still-limited login pane.
  expect(await continues()).toBe(1); // still exactly one — never re-fired
});

// ── a greyed-out suggestion must not veto hands-off auto-resume ────────────────
// claude offers an autocomplete SUGGESTION in the input box unprompted; nothing
// was typed until Tab accepts it. Read as a draft, it makes paneResumeSafe refuse
// forever, so a limited session never resumes on its own. The caret settles it —
// still parked at the prompt ⇒ nothing typed — and these drive the real Ink poll
// to prove the caret actually reaches the auto-resume gate (the pane text below
// carries no SGR escapes, so colour alone cannot tell the two cases apart).

/** A limited pane whose reset time is an explicit PAST date, with `boxText` in
 *  the input box. Same shape as (d): explicit month+day can't roll forward. */
function limitedPaneWithInput(boxText: string): string {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const yst = new Date(Date.now() - 24 * 3600_000);
  const rule = "  ─────────────────────────────────────────────";
  return [
    `  Claude usage limit reached. Your limit will reset at 3:00pm ${MON[yst.getMonth()]} ${yst.getDate()}.`,
    rule,
    `  ❯ ${boxText}`,
    rule,
    "  ? for shortcuts",
  ].join("\n");
}
const SUGGESTION = "wait for the review, then commit and open the PR";
// `❯` sits at column 2 of capture row 2, so the first input cell is column 4.
const PROMPT_CARET = { x: 4, y: 2 };

test("(e) a ghost suggestion in the box does NOT block auto-resume (caret at the prompt)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: true }));
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: limitedPaneWithInput(SUGGESTION) },
    cursors: { [RUNNING_TARGET]: PROMPT_CARET },
  });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);

  // Resume fires despite the text on screen: the caret proves it isn't typed.
  await waitUntil(async () => (await keysTo(mock, RUNNING_TARGET)).some((a) => a.includes("continue")));
});

test("(f) a REAL draft in a limited box still blocks auto-resume (caret at the end)", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await writeFile(join(mock.home, ".agendo", "state.json"), JSON.stringify({ provider: "ado", autoResumeOnUsageLimit: true }));
  // Identical screen; only the caret differs — it sits where typing leaves it.
  await mock.setTmuxState({
    ...tmuxState,
    captures: { [RUNNING_TARGET]: limitedPaneWithInput(SUGGESTION) },
    cursors: { [RUNNING_TARGET]: { x: PROMPT_CARET.x + SUGGESTION.length, y: PROMPT_CARET.y } },
  });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  // Several poll cycles (READINESS_MS = 1500ms): `<esc>continue<enter>` would wipe
  // the user's queued prompt, so nothing may be sent to the pane at all.
  await sleep(5000);
  expect(await keysTo(mock, RUNNING_TARGET)).toHaveLength(0);
});
