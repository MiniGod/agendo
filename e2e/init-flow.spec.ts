// The new-local-repo flow driven through the real TUI (docs/new-local-repo.md):
// repo picker → name → parent folder (list, or a typed path) → `git init` →
// straight back into the ordinary session flow.
//
// `git` is the harness's fake shim, so no real repository is ever initialized;
// `init` creates `<dest>/.git` and FAKE_GIT_INIT / FAKE_GIT_COMMIT pick the
// failing outcomes. Everything is written inside the fixture HOME, which the
// harness removes on teardown.
//
// The backend is pinned to ADO throughout (FAKE_GIT_ORIGIN_HOST=ado), as in
// clone-flow.spec.ts: creating a repo is backend-independent.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { test, expect, KEY } from "./harness/test.ts";
import type { WebTerminal } from "./harness/wterm.ts";

/** Sessions view → `n` → agent picker → enter (Claude) → the repo picker. */
async function openRepoPicker(wt: WebTerminal): Promise<string> {
  await wt.press("3");
  await wt.waitForStable();
  await wt.press("n");
  await wt.waitForText("New session — pick an agent");
  await wt.press(KEY.enter);
  return wt.waitForText("New session — pick a repo");
}

/** Repo picker → the name prompt (via the `i` shortcut). */
async function openNamePrompt(wt: WebTerminal): Promise<string> {
  await wt.press("i");
  return wt.waitForText("New local repo — name");
}

/** Name prompt → type `name` → enter → whatever the parent step is. */
async function submitName(wt: WebTerminal, name: string): Promise<void> {
  wt.write(name);
  await wt.waitForText(`folder named ${name}`);
  await wt.press(KEY.enter);
}

/** A machine with no agent history at all — no sessions for any repo. */
async function wipeSessions(home: string): Promise<void> {
  await rm(join(home, ".claude", "projects"), { recursive: true, force: true });
  await rm(join(home, ".copilot"), { recursive: true, force: true });
  await rm(join(home, ".codex"), { recursive: true, force: true });
}

const initCalls = (log: string[]) => log.filter((c) => c.startsWith("git ") && c.includes('"init"'));

test("the new-repo row is offered from an UNSCOPED launcher too, and lists the known parent folder", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ cols: 140, rows: 40 }); // bare `agendo`
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  // Unlike cloning, nothing gates it on a scope — the user names the folder.
  expect(picker).not.toContain("Clone from URL");
  expect(picker).toContain("New local repo…");
  expect(picker).toContain("i new repo");

  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  // Every fixture repo lives in ~/repos, so that is the one candidate…
  const where = await wt.waitForText("where should newthing go?");
  expect(where).toMatch(/❯[^\n]*repos\/newthing/);
  // …and the free-text row is always there beside it.
  expect(where).toContain("Other path…");
});

test("the row is reachable by ↑ from the top and ↓ off the bottom, and enter opens the prompt", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);

  // ↑ from the first row wraps onto the LAST row, which is the new-repo row…
  await wt.press(KEY.up);
  expect(await wt.waitForText("New local repo")).toMatch(/❯[^\n]*New local repo/);
  // …one more ↑ is the clone row above it…
  await wt.press(KEY.up);
  expect(await wt.waitForStable()).toMatch(/❯[^\n]*Clone from URL/);
  // …and ↓ from there is the new-repo row again, then the first repo.
  await wt.press(KEY.down);
  expect(await wt.waitForStable()).toMatch(/❯[^\n]*New local repo/);
  await wt.press(KEY.down);
  const back = await wt.waitForStable();
  expect(back).toMatch(/❯\s+repos\b/);
  expect(back).not.toMatch(/❯[^\n]*New local repo/);

  // Enter on the row opens the prompt — the row is addressed by a sentinel, so
  // a repo list that grows underneath it can't steal the keystroke.
  await wt.press(KEY.up);
  await wt.waitForText("New local repo");
  await wt.press(KEY.enter);
  expect(await wt.waitForText("New local repo — name")).toContain("Folder name for the new repo");
});

test("a name that isn't a single folder name is refused at the prompt — nothing is created", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ args: [join(mock.home, "repos")], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);

  wt.write("nested/thing");
  await wt.waitForText("folder named nested/thing");
  await wt.press(KEY.enter);
  const screen = await wt.waitForText("no slashes");
  // Still on the prompt, with the name still typed so it can be fixed.
  expect(screen).toContain("New local repo — name");
  expect(screen).toContain("nested/thing");
  expect(initCalls(await mock.callLog())).toEqual([]);
});

// `q` is the global quit key, and the name prompt is a TEXT INPUT — the same
// trap the clone prompt fell into once (`github.com/qmk/…`). Sent as its own
// keystroke: a whole name in one chunk would sail past the bug.
test("typing `q` in the name prompt types a q — it does not quit agendo", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ args: [join(mock.home, "repos")], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);

  await wt.press("q");
  wt.write("uick");
  const screen = await wt.waitForText("folder named quick");
  expect(screen).toContain("New local repo — name");
});

test("the scoped folder is offered first, ahead of the folder holding the most checkouts", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // A scoped folder OF checkouts that has none yet, beside ~/repos with three.
  const other = join(mock.home, "other");
  await mkdir(other, { recursive: true });
  const wt = await launch({ args: [other], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");

  const where = await wt.waitForText("where should newthing go?");
  // Both are listed, each showing the exact folder enter would create, and the
  // scoped one carries the cursor.
  expect(where).toMatch(/❯[^\n]*other\/newthing[\s\S]*repos\/newthing[\s\S]*Other path…/);

  await wt.press(KEY.enter);
  // It hands off to the SAME where-to-run dialog a pre-existing repo would, and
  // reports what it did (the flow's own screens are already gone by then).
  const dialog = await wt.waitForText("choose where to run", 20000);
  expect(dialog).toContain("New session in newthing");
  expect(dialog).toMatch(/✓ created new repo at[^\n]*other\/newthing/);
  // A checkout with history, so the worktree default stands.
  expect(dialog).toMatch(/❯\s+New git worktree/);

  // On disk: mkdir + `git init` in it, then the empty initial commit.
  const dest = join(other, "newthing");
  expect(existsSync(join(dest, ".git"))).toBe(true);
  const log = await mock.callLog();
  expect(log).toContain(`git ${JSON.stringify(["-C", dest, "init", "--quiet"])}`);
  const commit = log.find((c) => c.startsWith("git ") && c.includes('"commit"'));
  expect(commit).toContain(`"-C","${dest}"`);
  expect(commit).toContain('"--allow-empty"');
  expect(commit).toContain('"commit.gpgsign=false"');
  expect(commit).toContain('"--no-verify"');
});

test("a typed path: `~/…` expands, a missing parent is created and reported", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ args: [join(mock.home, "repos")], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");

  // ↑ from the top wraps onto the free-text row, which renders last.
  await wt.press(KEY.up);
  expect(await wt.waitForStable()).toMatch(/❯[^\n]*Other path…/);
  await wt.press(KEY.enter);
  await wt.waitForText("parent folder for newthing");

  wt.write("~/brand/new");
  // The exact folder that will be created is on screen BEFORE enter.
  const preview = await wt.waitForText("→ creates");
  expect(preview).toContain(join(mock.home, "brand", "new", "newthing"));
  await wt.press(KEY.enter);

  const dialog = await wt.waitForText("choose where to run", 20000);
  expect(dialog).toContain("created new repo at");
  expect(dialog).toContain("parent folder didn't exist — created it too");
  expect(existsSync(join(mock.home, "brand", "new", "newthing", ".git"))).toBe(true);
});

test("a relative path is refused — it would resolve against a cwd the user can't see", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ args: [join(mock.home, "repos")], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");
  await wt.press(KEY.up);
  await wt.waitForText("❯ ＋ Other path…");
  await wt.press(KEY.enter);
  await wt.waitForText("parent folder for newthing");

  wt.write("somewhere/relative");
  expect(await wt.waitForText("not an absolute path")).toContain("start with / or ~/");
  await wt.press(KEY.enter);
  const screen = await wt.waitForText("Type an absolute path");
  expect(screen).toContain("parent folder for newthing"); // still on the prompt
  expect(initCalls(await mock.callLog())).toEqual([]);
});

test("a folder that already exists with something in it is REFUSED — nothing is touched", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  await mkdir(join(parent, "newthing"), { recursive: true });
  await writeFile(join(parent, "newthing", "notes.txt"), "keep me\n");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");

  await wt.press(KEY.enter); // ~/repos
  const screen = await wt.waitForText("already exists and is not empty");
  expect(screen).toContain("where should newthing go?"); // back on the list, to pick again
  expect(initCalls(await mock.callLog())).toEqual([]);
  expect(existsSync(join(parent, "newthing", "notes.txt"))).toBe(true);
  expect(existsSync(join(parent, "newthing", ".git"))).toBe(false);

  // Moving the cursor drops the message: it was about the row just left.
  await wt.press(KEY.down);
  expect(await wt.waitForStable()).not.toContain("already exists");
});

test("a folder that is already a repo is offered as-is; a second enter uses it", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "appweb"); // a fixture checkout
  await wt.waitForText("where should appweb go?");

  await wt.press(KEY.enter);
  const offer = await wt.waitForText("is already a git repo");
  expect(offer).toContain("enter again to use it as-is");
  expect(initCalls(await mock.callLog())).toEqual([]);

  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("choose where to run", 20000);
  expect(dialog).toContain("New session in appweb");
  expect(dialog).toMatch(/✓ using the existing repo at[^\n]*repos\/appweb/);
  // No init ran, and no second copy appeared.
  expect(initCalls(await mock.callLog())).toEqual([]);
  expect(existsSync(join(parent, "appweb-2"))).toBe(false);
});

test("a failed `git init` reports git's own words and removes the folder it made", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  mock.env.FAKE_GIT_INIT = "fail"; // git exits 128 having written a partial .git
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");

  await wt.press(KEY.enter);
  const screen = await wt.waitForText("Permission denied");
  expect(screen).toContain("where should newthing go?"); // back on the list
  // Nothing half-made is left behind.
  expect(existsSync(join(parent, "newthing"))).toBe(false);
});

test("a failed initial commit is reported, but the repo still exists and the flow continues", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  mock.env.FAKE_GIT_COMMIT = "fail"; // "Please tell me who you are"
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");

  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("choose where to run", 20000);
  expect(dialog).toContain("created new repo at");
  expect(dialog).toContain("no initial commit");
  expect(dialog).toContain("auto-detect email address");
  expect(existsSync(join(parent, "newthing", ".git"))).toBe(true);
});

test("esc walks back: path prompt → list → name (kept) → picker", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ args: [join(mock.home, "repos")], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");
  await wt.press(KEY.up);
  await wt.waitForText("❯ ＋ Other path…");
  await wt.press(KEY.enter);
  await wt.waitForText("parent folder for newthing");

  await wt.press(KEY.escape);
  expect(await wt.waitForText("where should newthing go?")).toMatch(/❯[^\n]*Other path…/);
  await wt.press(KEY.escape);
  expect(await wt.waitForText("New local repo — name")).toContain("newthing");
  await wt.press(KEY.escape);
  await wt.waitForText("New session — pick a repo");
  expect(initCalls(await mock.callLog())).toEqual([]);
});

// The first-run case: no sessions anywhere, nothing cloned, nothing scoped —
// so there is no parent folder to list. The name prompt goes straight to the
// typed path, which is the one option that is always there.
test("a brand-new user with no known repos goes straight to the typed path, and it works", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  await wipeSessions(mock.home);
  const wt = await launch({ cwd: mock.home, cols: 140, rows: 40 }); // bare `agendo`, in a non-repo
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openNamePrompt(wt);
  await submitName(wt, "first");

  // No list — the path prompt, directly.
  const prompt = await wt.waitForText("parent folder for first");
  expect(prompt).not.toContain("Other path…");
  // esc from it goes back to the NAME (kept), since there never was a list.
  await wt.press(KEY.escape);
  expect(await wt.waitForText("New local repo — name")).toContain("first");
  await wt.press(KEY.enter);
  await wt.waitForText("parent folder for first");

  wt.write("~/projects");
  await wt.waitForText("→ creates");
  await wt.press(KEY.enter);

  const dialog = await wt.waitForText("choose where to run", 20000);
  expect(dialog).toContain("New session in first");
  expect(existsSync(join(mock.home, "projects", "first", ".git"))).toBe(true);

  // The repo just created is now a known checkout, so the NEXT one gets a list
  // — with its parent folder on it — before a session has ever run there.
  await wt.press(KEY.escape);
  await wt.waitForText("New session — pick a repo");
  await openNamePrompt(wt);
  await submitName(wt, "second");
  expect(await wt.waitForText("where should second go?")).toMatch(/❯[^\n]*projects\/second/);
});

// ── the three entry points converge on chooseRepo ─────────────────────────────

test("from a WORK ITEM: the new repo goes straight to the work item's branch prompt", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Add login screen", 20000);
  await wt.waitForStable();

  // WI 101 → "+ start a fresh session…" → agent picker → repo picker.
  await wt.press(KEY.enter);
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down);
  await wt.press(KEY.down);
  await wt.press(KEY.enter);
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // Claude
  const picker = await wt.waitForText("Pick a repo to create the worktree in");
  expect(picker).toContain("New local repo…");

  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");
  await wt.press(KEY.enter); // ~/repos

  // Straight into the work item's branch prompt — the same one an already-present
  // repo reaches, with the worktree path under the new checkout.
  const branch = await wt.waitForText("New branch off origin/HEAD", 20000);
  expect(branch).toContain("Fresh session in newthing");
  expect(branch).toMatch(/✓ created new repo at/);
  expect(branch).toContain(join(parent, "newthing", ".claude", "worktrees"));
  expect(existsSync(join(parent, "newthing", ".git"))).toBe(true);

  // Back out to the picker: the new repo is now an ordinary row.
  await wt.press(KEY.escape);
  expect(await wt.waitForText("Pick a repo to create the worktree in")).toContain("newthing");
});

test("from a PR whose repo isn't on disk: create the repo, then the PR checkout runs in it", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // PR 7001 (top of "Awaiting your review") re-homed to a repo no checkout has,
  // so the PR flow — which otherwise skips the picker — has to show it.
  mock.setAdoPr(7001, { repository: { id: "repoC-guid", name: "newthing" } });
  const parent = join(mock.home, "repos");
  // Bare `agendo`: a scoped launcher's repo filter would hide a PR on a repo
  // that has no checkout, which is precisely the PR this test is about.
  const wt = await launch({ cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();

  await wt.press("2");
  await wt.waitForText("Refactor the parser");
  await wt.press(KEY.down); // the cursor starts on !5001; !7001 is next
  await wt.press(KEY.enter); // expand PR 7001
  await wt.waitForText("+ start a fresh session…");
  await wt.press(KEY.down); // "+ start a fresh session…" (no sessions on it)
  await wt.press(KEY.enter);
  await wt.waitForText("Which agent should run this session?");
  await wt.press(KEY.enter); // Claude
  const picker = await wt.waitForText("Pick a repo to create the worktree in");
  expect(picker).toContain("New local repo…");

  await openNamePrompt(wt);
  await submitName(wt, "newthing");
  await wt.waitForText("where should newthing go?");
  await wt.press(KEY.enter); // ~/repos

  // A PR target routes init → checkout → launch in one keystroke: the checkout
  // happens in the repo that was just created, and the launch carries the note.
  const dest = join(parent, "newthing");
  await expect
    .poll(
      async () =>
        (await mock.callLog()).some(
          (c) => c.startsWith("git ") && c.includes('"worktree"') && c.includes(`"-C","${dest}"`),
        ),
      { timeout: 10000 },
    )
    .toBe(true);
  expect(existsSync(join(dest, ".git"))).toBe(true);
  expect(initCalls(await mock.callLog())).toHaveLength(1);
});
