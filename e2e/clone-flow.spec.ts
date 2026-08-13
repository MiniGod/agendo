// The clone flow driven through the real TUI (docs/cloning.md): repo picker →
// URL prompt → `git clone` → straight back into the ordinary session flow.
//
// `git` is the harness's fake shim, so nothing here goes near the network or
// creates a real repository; FAKE_GIT_CLONE picks the outcome (success / auth
// failure / other failure) and the shim leaves a partial directory behind on
// failure so the cleanup can be asserted. Everything is written inside the
// fixture HOME, which the harness removes on teardown.
//
// The backend is pinned to ADO throughout (FAKE_GIT_ORIGIN_HOST=ado): the fake
// origin decides which provider a path context forces, and cloning is
// backend-independent — a GitHub URL is pasted into an ADO-backed launcher in
// these tests and must work exactly the same.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
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

/** Repo picker → the clone prompt (via the `c` shortcut). */
async function openClonePrompt(wt: WebTerminal): Promise<string> {
  await wt.press("c");
  return wt.waitForText("Clone a repo into");
}

test("the clone row is offered only when the launcher was given a directory", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  expect(picker).toContain("Clone from URL…");
  // …and it says where it would clone to, so the destination is never a guess.
  expect(picker).toMatch(/Clone from URL…[^\n]*clone into[^\n]*repos/);
  expect(picker).toContain("c clone");
});

test("an UNSCOPED launcher offers no cloning at all — there is no directory to write to", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const wt = await launch({ cols: 140, rows: 40 }); // bare `agendo`
  await wt.waitForText("Current sprint", 20000);

  const picker = await openRepoPicker(wt);
  expect(picker).toContain("appweb"); // the picker itself still works
  expect(picker).not.toContain("Clone from URL");
  expect(picker).not.toContain("c clone");
  // The shortcut is inert too, not just hidden.
  await wt.press("c");
  await wt.waitForStable();
  expect(await wt.screen()).not.toContain("Clone a repo into");
});

test("a bad URL is refused at the prompt — nothing is cloned", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://example.com/owner/repo");
  await wt.waitForText("not a recognizable");
  await wt.press(KEY.enter);
  await wt.waitForStable();
  // Still on the prompt: enter on an unparseable URL does nothing at all.
  expect(await wt.screen()).toContain("Clone a repo into");
  expect((await mock.callLog()).filter((c) => c.includes('"clone"'))).toEqual([]);
});

// REGRESSION: `q` is the global quit key, and the URL prompt is a TEXT INPUT.
// Before this was fixed, typing the `q` of `github.com/qmk/qmk_firmware` exited
// agendo — making every repo with a `q` in its name literally untypeable. Note
// the `q` is sent as its OWN keystroke: a whole URL delivered in one chunk
// arrives as one multi-character `input` and would sail past the bug.
test("REGRESSION: typing `q` in the URL prompt types a q — it does not quit agendo", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://github.com/");
  await wt.waitForStable();
  await wt.press("q");
  wt.write("mk/qmk_firmware");

  // Still alive, still on the prompt, and the URL parsed with the q in it.
  // (`clones into` rather than the identity line: the destination is resolved
  // off the render path, so it lands a beat after the parse.)
  const screen = await wt.waitForText("clones into");
  expect(screen).toContain("Clone a repo into");
  expect(screen).toContain("qmk/qmk_firmware");
  expect(screen).toMatch(/clones into[^\n]*repos\/qmk_firmware/);
});

test("the destination is shown BEFORE enter — a clone is never a surprise", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  // A web URL with a trailing path, which is what a user actually pastes.
  wt.write("https://github.com/ada/newthing/tree/main/src");
  const screen = await wt.waitForText("clones into");
  expect(screen).toContain("ada/newthing");
  expect(screen).toMatch(/clones into[^\n]*repos\/newthing/);
});

test("a successful clone lands in the target directory and continues into the normal flow", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://github.com/ada/newthing");
  await wt.waitForText("clones into");
  await wt.press(KEY.enter);

  // It hands off to the SAME where-to-run dialog a pre-existing repo would, and
  // reports what it did (the clone step's own screens are already gone by then).
  const where = await wt.waitForText("choose where to run", 20000);
  expect(where).toContain("newthing");
  expect(where).toMatch(/cloned ada\/newthing/);

  // On disk: a checkout at the sibling path, cloned from the CANONICAL remote
  // (the pasted web URL is never handed to git verbatim).
  const dest = join(parent, "newthing");
  expect(existsSync(join(dest, ".git"))).toBe(true);
  expect(readFileSync(join(dest, ".git", "fake-origin"), "utf-8"))
    .toBe("https://github.com/ada/newthing.git");
  // …and `--` guards the arguments.
  const clone = (await mock.callLog()).find((c) => c.startsWith("git ") && c.includes('"clone"'));
  expect(clone).toContain('"--"');
});

test("a repo already checked out in the directory is REUSED, not cloned twice", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  // With the ADO origin shim, ~/repos/appweb reports
  // `https://dev.azure.com/innovamps/proj/_git/appweb` as its origin.
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  // Pasted in a DIFFERENT form than it was cloned in (SSH triple vs. HTTPS) —
  // the match is on repo identity, not on the URL text or the folder name.
  wt.write("git@ssh.dev.azure.com:v3/innovamps/proj/appweb");
  const preview = await wt.waitForText("already cloned at");
  expect(preview).toContain("repos/appweb");

  await wt.press(KEY.enter);
  const where = await wt.waitForText("choose where to run", 20000);
  expect(where).toContain("appweb");
  expect(where).toMatch(/already cloned/);
  // No clone ran, and no second copy appeared next to it.
  expect((await mock.callLog()).filter((c) => c.includes('"clone"'))).toEqual([]);
  expect(existsSync(join(parent, "appweb-2"))).toBe(false);
});

test("an auth failure says so, and removes the partial clone", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  mock.env.FAKE_GIT_CLONE = "auth"; // git exits 128 having written a partial dir
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://github.com/ada/secretthing");
  await wt.waitForText("clones into");
  await wt.press(KEY.enter);

  // agendo's reading of the failure, plus git's own words underneath it.
  const screen = await wt.waitForText("Authentication", 20000);
  expect(screen).toContain("existing git credentials");
  expect(screen).toContain("terminal prompts disabled");
  // Back on the prompt with the URL still typed, so it can be fixed and retried.
  expect(screen).toContain("Clone a repo into");
  expect(screen).toContain("ada/secretthing");
  // Nothing half-made is left behind.
  expect(existsSync(join(parent, "secretthing"))).toBe(false);
});

test("a 404 is reported as not-found, NOT as a credentials problem", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  mock.env.FAKE_GIT_CLONE = "missing";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://github.com/ada/typodthing");
  await wt.waitForText("clones into");
  await wt.press(KEY.enter);

  // GitHub answers an unauthorized private repo with a 404 too, so the message
  // must cover both readings — and must not confidently blame credentials for
  // what is far more often a typo.
  const screen = await wt.waitForText("Not found", 20000);
  expect(screen).toContain("check the URL");
  expect(screen).toContain("if it's private");
  expect(screen).not.toContain("Authentication —");
  expect(existsSync(join(parent, "typodthing"))).toBe(false);
});

test("a non-auth failure reports git verbatim, and also cleans up", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  mock.env.FAKE_GIT_CLONE = "fail";
  const parent = join(mock.home, "repos");
  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://github.com/ada/brokenthing");
  await wt.waitForText("clones into");
  await wt.press(KEY.enter);

  const screen = await wt.waitForText("remote end hung up", 20000);
  // Not misreported as a credentials problem.
  expect(screen).not.toContain("Authentication");
  expect(existsSync(join(parent, "brokenthing"))).toBe(false);
});

test("a name collision steps aside instead of clobbering the directory", async ({ launch, mock }) => {
  mock.env.FAKE_GIT_ORIGIN_HOST = "ado";
  const parent = join(mock.home, "repos");
  // A non-empty directory that is NOT a checkout of the repo being cloned — it
  // just happens to have the name. (`applib` is a fixture repo whose ADO origin
  // is `…/_git/applib`; the URL below is a different repo entirely.)
  await mkdir(join(parent, "newthing", "some-other-work"), { recursive: true });

  const wt = await launch({ args: [parent], cols: 140, rows: 40 });
  await wt.waitForText("Current sprint", 20000);
  await openRepoPicker(wt);
  await openClonePrompt(wt);

  wt.write("https://github.com/ada/newthing");
  const preview = await wt.waitForText("clones into");
  expect(preview).toMatch(/clones into[^\n]*repos\/newthing-2/);

  await wt.press(KEY.enter);
  const where = await wt.waitForText("choose where to run", 20000);
  expect(where).toMatch(/as newthing-2/); // the landing spot is reported, not silent
  expect(existsSync(join(parent, "newthing-2", ".git"))).toBe(true);
  // The user's directory is untouched.
  expect(existsSync(join(parent, "newthing", "some-other-work"))).toBe(true);
  expect(existsSync(join(parent, "newthing", ".git"))).toBe(false);
});
