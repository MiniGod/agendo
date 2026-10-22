// The cleanup view (C): sessions and agendo-managed worktrees, their sizes and
// git state, and the per-row dialog that deletes them.
//
// Unlike the rest of the suite these specs need GENUINE repositories — dirty,
// unpushed and squash-merged are judged by git itself — so each test builds
// one in its own temp dir (a bare origin, a clone, worktrees under
// `.claude/worktrees/`) and the fake `git` passes calls inside that dir, and
// only those, through to the real binary (FAKE_GIT_REAL / FAKE_GIT_REAL_ROOT).
// Nothing outside the test's temp dir is ever touched.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUNNING_TARGET, sessionName, tmuxState } from "./harness/fixtures.ts";
import { REPO_ROOT, type MockEnv } from "./harness/mockEnv.ts";
import { windowTarget } from "../src/runtime/tmux/index.ts";
import { expect, KEY, test } from "./harness/test.ts";
import type { WebTerminal } from "./harness/wterm.ts";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf-8" }).trim();
const GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@example.com",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@example.com",
};

const IDS = { merged: "cleanup-merged-01", dirty: "cleanup-dirty-01", running: "cleanup-running-01", main: "cleanup-main-01" };

interface Fx {
  repo: string;
  wt: (name: string) => string;
  git: (dir: string, ...args: string[]) => string;
  tmpRoot: string;
}

/** A bare origin, its clone, and three worktrees: squash-merged, dirty + unpushed, an orphan with no session. */
async function buildFixture(mock: MockEnv): Promise<Fx> {
  const root = join(mock.tmpDir, "fx");
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const env = { ...process.env, ...GIT_ENV, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (dir: string, ...args: string[]) => {
    const r = spawnSync(REAL_GIT, ["-C", dir, ...args], { encoding: "utf-8", env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = async (dir: string, file: string, body: string) => {
    await writeFile(join(dir, file), body);
    git(dir, "add", file);
    git(dir, "commit", "-q", "-m", `edit ${file}`);
  };
  await mkdir(root, { recursive: true });
  git(root, "init", "-q", "--bare", "-b", "master", origin);
  git(root, "clone", "-q", origin, repo);
  await commit(repo, "README.md", "hello\n");
  git(repo, "push", "-q", "-u", "origin", "master");
  git(repo, "remote", "set-head", "origin", "master");
  const wt = (name: string) => join(repo, ".claude", "worktrees", name);
  for (const name of ["merged", "dirty", "orphan", "running"]) git(repo, "worktree", "add", "-q", "-b", `worktree-${name}`, wt(name), "master");

  await commit(wt("merged"), "feature.txt", "done\n");
  git(repo, "merge", "-q", "--squash", "worktree-merged");
  git(repo, "commit", "-q", "-m", "squash worktree-merged");
  git(repo, "push", "-q", "origin", "master");
  git(wt("merged"), "fetch", "-q", "origin");

  await commit(wt("dirty"), "wip.txt", "half\n");
  await writeFile(join(wt("dirty"), "scratch.txt"), "untracked\n");
  await commit(wt("orphan"), "lost.txt", "never pushed\n");

  const tmpRoot = join(mock.tmpDir, "tmp");
  Object.assign(mock.env, GIT_ENV, { FAKE_GIT_REAL: REAL_GIT, FAKE_GIT_REAL_ROOT: root, CLAUDE_CODE_TMPDIR: tmpRoot });

  // Sessions: one per worktree but the orphan, and one in the main checkout.
  const sessions: Array<[string, string, string, number]> = [
    [IDS.merged, "Merged feature", wt("merged"), 10],
    [IDS.dirty, "Half-done work", wt("dirty"), 20],
    [IDS.running, "Busy right now", wt("running"), 30],
    [IDS.main, "Main checkout chat", repo, 40],
  ];
  const now = Date.now() / 1000;
  for (const [id, title, cwd, minutesAgo] of sessions) {
    const dir = join(mock.home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(join(dir, id), { recursive: true });
    const log = join(dir, `${id}.jsonl`);
    const ts = new Date((now - minutesAgo * 60 - 3600) * 1000).toISOString();
    await writeFile(
      log,
      [
        { type: "summary", cwd, gitBranch: git(cwd, "branch", "--show-current"), timestamp: ts },
        { type: "custom-title", customTitle: title, timestamp: ts },
        { type: "user", message: { content: "go" }, cwd, timestamp: ts },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    await utimes(log, now - minutesAgo * 60, now - minutesAgo * 60);
    await mkdir(join(tmpRoot, `claude-${process.getuid?.() ?? 0}`, cwd.replace(/[^a-zA-Z0-9]/g, "-"), id, "scratchpad"), { recursive: true });
  }

  // The orphan worktree is the oldest thing here, so it sorts last by update.
  await utimes(wt("orphan"), now - 7200, now - 7200);

  const running = sessionName("claude", IDS.running);
  await mock.setTmuxState({
    sessions: [running],
    windows: [],
    panes: [{ session: running, window: running, cwd: wt("running"), placeholder: false }],
    captures: {},
  });
  return { repo, wt, git, tmpRoot };
}

async function openCleanup(launch: (o?: { args?: string[]; rows?: number; cols?: number }) => Promise<WebTerminal>, fx: Fx): Promise<WebTerminal> {
  const wt = await launch({ args: [fx.repo], rows: 40, cols: 160 });
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press("C");
  await wt.waitForText("Cleanup —");
  // Every row's git state and size have landed once no `…` is left. Generous:
  // each probe is a dozen git calls, each one through the fenced shim.
  await expect.poll(async () => (await wt.screen()).includes("…"), { timeout: 45000 }).toBe(false);
  return wt;
}

/** Move the cursor onto the row whose title contains `title`. */
async function focus(wt: WebTerminal, title: string): Promise<void> {
  const focused = async () => (await wt.screen()).split("\n").find((l) => l.startsWith("▸")) ?? "";
  for (let i = 0; i < 10; i++) {
    const line = await focused();
    if (line.includes(title)) return;
    await wt.press("j");
    // Wait for the cursor to actually move before judging the next row.
    await expect.poll(focused, { timeout: 5000 }).not.toBe(line);
  }
  throw new Error(`no row titled ${title}`);
}

const branchExists = (fx: Fx, b: string) => fx.git(fx.repo, "branch", "--list", b) !== "";

test("C lists every session and orphan worktree with run state, size and git state; esc returns", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  const screen = await wt.screen();
  expect(screen).toContain("Cleanup — 5 sessions & worktrees");
  expect(screen).toMatch(/○ idle\s+Merged feature.*clean · merged/);
  expect(screen).toMatch(/○ idle\s+Half-done work.*1 dirty · 1 unpushed · unmerged/);
  expect(screen).toMatch(/● running\s+Busy right now/);
  expect(screen).toMatch(/· no session\s+orphan.*1 unpushed · unmerged/);
  expect(screen).toMatch(/Main checkout chat.*main checkout/);
  expect(screen).toMatch(/\d+(\.\d)?[BKMG] /);
  expect(screen).toContain("[worktree-merged]");

  await wt.press(KEY.escape);
  await wt.waitForText("Current sprint");
  // Every git call the app made was inside the fixture — the fence never had to refuse one.
  expect((await mock.callLog()).filter((l) => l.startsWith("git-refused"))).toEqual([]);
});

test("s cycles updated → created → size and r reverses", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await wt.waitForText("sort: updated ↓");
  // Newest first: the merged session was touched most recently.
  expect((await wt.screen()).split("\n").find((l) => l.startsWith("▸"))).toContain("Merged feature");
  await wt.press("s");
  await wt.waitForText("sort: created ↓");
  await wt.press("s");
  await wt.waitForText("sort: size ↓");
  await wt.press("r");
  await wt.waitForText("sort: size ↑");
  await wt.press("s");
  const oldestFirst = await wt.waitForText("sort: updated ↑");
  // Oldest first now, and the cursor stayed on the row it was on, wherever that went.
  expect(oldestFirst.indexOf("orphan")).toBeLessThan(oldestFirst.indexOf("Merged feature"));
  expect(oldestFirst.split("\n").find((l) => l.startsWith("▸"))).toContain("Merged feature");
});

test("a clean, squash-merged worktree starts ticked and its worktree and branch are removed", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Merged feature");
  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("Clean up — Merged feature");
  expect(dialog).toContain("[x] worktree");
  expect(dialog).toContain("[x] branch");
  expect(dialog).toContain("[ ] session transcript");
  expect(dialog).toContain("[ ] tmp/scratch files");
  expect(dialog).not.toContain("would lose");

  await wt.press(KEY.enter);
  const done = await wt.waitForText("Cleanup finished");
  expect(done).toContain(`✓ removed worktree ${fx.wt("merged")}`);
  expect(done).toContain("✓ deleted branch worktree-merged");
  expect(existsSync(fx.wt("merged"))).toBe(false);
  expect(branchExists(fx, "worktree-merged")).toBe(false);

  // The session is kept, and the list refreshes to say its checkout is gone.
  await wt.press("x");
  await wt.waitForText(/Merged feature.*no checkout or branch/);
});

test("a dirty, unpushed worktree warns, starts unticked, and goes only after y", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Half-done work");
  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("would lose");
  expect(dialog).toContain("1 dirty file (uncommitted or untracked)");
  expect(dialog).toContain("1 unpushed commit");
  expect(dialog).toContain("branch not merged into origin/master");
  expect(dialog).toContain("[ ] worktree");
  expect(dialog).toContain("[ ] branch");

  await wt.press(" ");
  await wt.press("j");
  await wt.press(" ");
  await wt.press(KEY.enter);
  await wt.waitForText("Really delete?");
  await wt.press("n");
  await wt.waitForText("not deleted");
  expect(existsSync(fx.wt("dirty"))).toBe(true);

  await wt.press(KEY.enter);
  await wt.waitForText("Really delete?");
  await wt.press("y");
  const done = await wt.waitForText("Cleanup finished");
  expect(done).toContain("(forced)");
  expect(done).toContain("✓ deleted branch worktree-dirty");
  expect(existsSync(fx.wt("dirty"))).toBe(false);
  expect(branchExists(fx, "worktree-dirty")).toBe(false);
});

test("a running session's worktree and branch are refused, with a notice to pause or kill it first", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Busy right now");
  // Space: enter on a running row switches to it instead (see the attach spec below).
  await wt.press(" ");
  const dialog = await wt.waitForText("This session is running");
  expect(dialog).toContain("Pause or kill it first");
  await wt.press(" ");
  await wt.waitForText("can't select worktree: session is running — pause or kill it first");
  await wt.press(KEY.enter);
  await wt.waitForText("nothing selected");
  expect(existsSync(fx.wt("running"))).toBe(true);
  expect(branchExists(fx, "worktree-running")).toBe(true);
});

test("the main checkout and its branch are never offered", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Main checkout chat");
  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("Clean up — Main checkout chat");
  expect(dialog).toMatch(/\[ \] worktree\s+— not an agendo worktree/);
  expect(dialog).toMatch(/\[ \] branch\s+— checked out in the main checkout/);
});

test("the transcript and the tmp/scratch files are deleted when ticked", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Half-done work");
  await wt.press(KEY.enter);
  await wt.waitForText("Clean up — Half-done work");
  await wt.press("j");
  await wt.press("j");
  await wt.press(" ");
  await wt.press("j");
  await wt.press(" ");
  await wt.waitForText("[x] tmp/scratch files");
  await wt.press(KEY.enter);
  const done = await wt.waitForText("Cleanup finished");
  expect(done).toContain("✓ deleted session transcript");
  expect(done).toContain("✓ deleted tmp/scratch files");
  const slug = fx.wt("dirty").replace(/[^a-zA-Z0-9]/g, "-");
  expect(existsSync(join(mock.home, ".claude", "projects", slug, `${IDS.dirty}.jsonl`))).toBe(false);
  expect(existsSync(join(fx.tmpRoot, `claude-${process.getuid?.() ?? 0}`, slug, IDS.dirty))).toBe(false);
  // Its worktree was left alone.
  expect(existsSync(fx.wt("dirty"))).toBe(true);
});

test("ignored files and a session written moments ago are warned about, start unticked and need y", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  await writeFile(join(fx.repo, ".git", "info", "exclude"), ".env\n");
  await writeFile(join(fx.wt("merged"), ".env"), "SECRET=1\n");
  const slug = fx.wt("merged").replace(/[^a-zA-Z0-9]/g, "-");
  const now = Date.now() / 1000;
  await utimes(join(mock.home, ".claude", "projects", slug, `${IDS.merged}.jsonl`), now, now);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Merged feature");
  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("Clean up — Merged feature");
  expect(dialog).toContain("1 ignored");
  expect(dialog).toContain("1 ignored file git would not keep (.env)");
  expect(dialog).toContain("an agent may still be using it outside agendo");
  expect(dialog).toMatch(/\[ \] worktree/);
  expect(dialog).toMatch(/\[ \] branch/);
  await wt.press(" ");
  await wt.press(KEY.enter);
  const confirm = await wt.waitForText("Really delete?");
  expect(confirm).toContain("1 ignored file git would not keep (.env)");
  expect(confirm).toContain("an agent may still be using it outside agendo");
  await wt.press("y");
  expect(await wt.waitForText("Cleanup finished")).toContain("✓ removed worktree");
  expect(existsSync(fx.wt("merged"))).toBe(false);
});

test("the real-git passthrough fails closed: nothing outside the fixture dir reaches real git", async ({ mock }) => {
  const fx = await buildFixture(mock);
  const shim = join(REPO_ROOT, "e2e", "fakebin", "git");
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(shim, args, { encoding: "utf-8", env: { ...mock.env, ...extra }, cwd: mock.tmpDir });
  // Inside: real git answers.
  const ok = run(["-C", fx.repo, "rev-parse", "--abbrev-ref", "HEAD"]);
  expect(ok.status).toBe(0);
  expect(ok.stdout.trim()).toBe("master");
  // Outside, by every route that could point git at another repository: the
  // agendo checkout itself stands in for "a real repo of the user's".
  expect(run(["-C", fx.repo, "--no-pager", "log", "-n1", "--format=%s", "origin/master"]).status).toBe(0);
  const fence = dirname(fx.repo);
  const outside = join(mock.tmpDir, "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(fence, "link"));
  // A directory inside a real repo, made the fence on its own: git would find the enclosing repo.
  const sub = join(fx.repo, "sub");
  await mkdir(sub, { recursive: true });
  const refusals = [
    run(["-C", REPO_ROOT, "branch", "--list"]),
    run(["-C", fx.repo, "-C", REPO_ROOT, "status"]),
    run(["-C", fx.repo, `--git-dir=${join(REPO_ROOT, ".git")}`, "status"]),
    run(["-C", fx.repo, "--work-tree", REPO_ROOT, "status"]),
    run(["-C", fx.repo, "status"], { GIT_DIR: join(REPO_ROOT, ".git") }),
    run(["-C", fx.repo, "worktree", "remove", join(REPO_ROOT, "e2e")]),
    run(["status"], { FAKE_GIT_REAL_ROOT: "" }),
    // A relative -C after another global option.
    run(["-C", fx.repo, "--no-pager", "-C", "../..", "status"]),
    // A relative path argument.
    run(["-C", fx.repo, "worktree", "add", "../../escaped"]),
    // A path in an --opt=value spelling.
    run(["-C", fx.repo, "log", `--output=${join(outside, "log.txt")}`]),
    // A symlink followed by `..`: the kernel resolves the link first.
    run(["-C", `${fence}/link/..`, "status"]), // a string: join() would fold the `..` away first
    // Repository discovery climbing out of the fence.
    run(["-C", sub, "branch", "--list"], { FAKE_GIT_REAL_ROOT: sub }),
    // Config that could run a command.
    run(["-C", fx.repo, "-c", "alias.x=!true", "x"]),
    run(["-C", fx.repo, "status"], { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "true" }),
    // A short option with its value attached.
    run(["-C", fx.repo, "format-patch", `-o${join(outside, "patches")}`, "HEAD~1"]),
    // A URL.
    run(["-C", fx.repo, "fetch", "https://example.invalid/x.git"]),
    // Config that a later call would run.
    run(["-C", fx.repo, "config", "core.fsmonitor", `touch ${join(outside, "planted")}`]),
  ];
  // A remote outside the fence: refused whatever the call.
  fx.git(fx.repo, "remote", "add", "real", join(outside, "real.git"));
  refusals.push(run(["-C", fx.repo, "push", "real", "master"]));
  fx.git(fx.repo, "remote", "remove", "real");
  // A worktree registered outside the fence: `worktree remove` would match it by suffix.
  fx.git(fx.repo, "worktree", "add", "-q", join(outside, "wt"));
  refusals.push(run(["-C", fx.repo, "worktree", "remove", "wt"]));
  for (const r of refusals) {
    expect(r.status).toBe(128);
    expect(r.stderr).toContain("refusing real-git passthrough");
  }
  expect((await mock.callLog()).filter((l) => l.startsWith("git-refused"))).toHaveLength(refusals.length);
  expect(existsSync(join(mock.tmpDir, "escaped"))).toBe(false);
  expect(existsSync(join(outside, "log.txt"))).toBe(false);
  expect(existsSync(join(outside, "patches"))).toBe(false);
  expect(existsSync(join(outside, "planted"))).toBe(false);
  expect(existsSync(join(outside, "wt"))).toBe(true);
});

// ── the f filter, the / text filter, and p / x / X on a session ──────────────

/**
 * Four more orphan worktrees beside the fixture's, one per kind of risk the
 * filter has to tell apart from "safe": a clean one at master (safe), one whose
 * branch is pushed but not merged, one with an ignored `.env`, and one dirty
 * but with no commits of its own. All dated well past the "written moments ago"
 * guard, which would otherwise hold every one of them back from "safe".
 */
async function addFilterCases(fx: Fx): Promise<void> {
  for (const name of ["spare", "pushed", "ignored", "dirtyonly"]) fx.git(fx.repo, "worktree", "add", "-q", "-b", `worktree-${name}`, fx.wt(name), "master");
  await writeFile(join(fx.wt("pushed"), "shared.txt"), "on the remote, not in master\n");
  fx.git(fx.wt("pushed"), "add", "shared.txt");
  fx.git(fx.wt("pushed"), "commit", "-q", "-m", "shared");
  fx.git(fx.wt("pushed"), "push", "-q", "origin", "worktree-pushed");
  await writeFile(join(fx.repo, ".git", "info", "exclude"), ".env\n");
  await writeFile(join(fx.wt("ignored"), ".env"), "SECRET=1\n");
  await writeFile(join(fx.wt("dirtyonly"), "notes.txt"), "untracked\n");
  const old = Date.now() / 1000 - 3600;
  for (const name of ["spare", "pushed", "ignored", "dirtyonly"]) await utimes(fx.wt(name), old, old);
}

/** Whether the list shows a row titled `title` (matched in the title column, not in a git cell). */
const listed = (screen: string, title: string) => new RegExp(`(idle|running|paused|no session)\\s+${title}\\b`).test(screen);

test("f filters to what is safe to remove, then to what has something to lose, with counts; / filters by text", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  await addFilterCases(fx);
  const wt = await openCleanup(launch, fx);
  const all = await wt.waitForText("Cleanup — 9 sessions & worktrees");
  expect(all).toContain("filter: all");
  expect(all).toContain("f filter: all");

  await wt.press("f");
  const safe = await wt.waitForText("Cleanup — 2 of 9 sessions & worktrees  ·  filter: safe to remove");
  for (const t of ["Merged feature", "spare"]) expect(listed(safe, t)).toBe(true);
  for (const t of ["Half-done work", "orphan", "pushed", "ignored", "dirtyonly", "Busy right now", "Main checkout chat"]) expect(listed(safe, t)).toBe(false);

  await wt.press("f");
  const risk = await wt.waitForText("Cleanup — 5 of 9 sessions & worktrees  ·  filter: has something to lose");
  expect(risk).toMatch(/Half-done work.*1 dirty · 1 unpushed · unmerged/);
  expect(risk).toMatch(/orphan.*1 unpushed · unmerged/);
  expect(risk).toMatch(/pushed.*clean · unmerged/);
  expect(risk).toMatch(/ignored.*1 ignored · merged/);
  expect(risk).toMatch(/dirtyonly.*1 dirty · merged/);
  // Running and the main checkout have nothing on offer to lose; neither is listed.
  for (const t of ["Merged feature", "spare", "Busy right now", "Main checkout chat"]) expect(listed(risk, t)).toBe(false);
  // A cursor whose row the next filter hides lands on a row that is shown.
  await focus(wt, "Half-done work");
  await wt.press("f");
  await wt.waitForText("Cleanup — 9 sessions & worktrees  ·  filter: all");
  await wt.press("f");
  const back = await wt.waitForText("filter: safe to remove");
  expect(back.split("\n").find((l) => l.startsWith("▸"))).toMatch(/Merged feature|spare/);
  await wt.press("f");
  await wt.press("f");
  await wt.waitForText("Cleanup — 9 sessions & worktrees  ·  filter: all");

  await wt.press("/");
  await wt.waitForText("type to filter by title, branch or path");
  // Letters that are keys elsewhere in the view (s sorts, p pauses, x kills) are just text here.
  await wt.press("p");
  await wt.press("u");
  await wt.press("s");
  await wt.press("h");
  const typed = await wt.waitForText("Cleanup — 1 of 9 sessions & worktrees  ·  filter: all  ·  /push");
  expect(listed(typed, "pushed")).toBe(true);
  expect(typed).toContain("sort: updated ↓");
  await wt.press(KEY.enter);
  await wt.waitForText("f filter: all");
  await wt.press(KEY.escape);
  await wt.waitForText("Cleanup — 9 sessions & worktrees");
});

test("the filter is kept for the rest of the run: leaving the view and pressing C again keeps it", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await wt.press("f");
  await wt.waitForText("filter: safe to remove");
  await wt.press(KEY.escape);
  await wt.waitForText("Current sprint");
  await wt.press("C");
  const again = await wt.waitForText("filter: safe to remove");
  expect(again).toMatch(/Cleanup — \d+ of 5 sessions & worktrees/);
});

test("x on a running row asks, kills it the way close does, and the row can then be cleaned up", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  await runningInHost(mock, fx);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Busy right now");
  await wt.waitForText(/● running\s+Busy right now/);
  await wt.press("x");
  await wt.waitForText("Kill Busy right now? y/n", 20000);
  await wt.press("n");
  await wt.waitForText("Kill cancelled");
  expect(await wt.screen()).toContain("Cleanup —");

  await wt.press("x");
  await wt.waitForText("Kill Busy right now? y/n", 20000);
  await wt.press("y");
  await wt.waitForText("killed Busy right now", 20000);
  expect((await mock.tmuxLog()).filter((a) => a[0].startsWith("kill-"))).toEqual([["kill-window", "-t", "=agendo:4"]]);
  // Still in the cleanup view, the row no longer running — so its checkout is on offer now.
  await wt.waitForText(/○ idle\s+Busy right now/, 20000);
  await wt.press(KEY.enter);
  const dialog = await wt.waitForText("Clean up — Busy right now");
  expect(dialog).not.toContain("This session is running");
  expect(dialog).toContain("[x] worktree");
  expect(existsSync(fx.wt("running"))).toBe(true);
});

test("p and x on a row with no session say why and do nothing", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "orphan");
  await wt.press("x");
  await wt.waitForText("x kills a running session — this row is not a session.");
  await wt.press("p");
  await wt.waitForText("p pauses a running session — this row is not a session.");
  expect((await mock.tmuxLog()).filter((a) => a[0].startsWith("kill-"))).toEqual([]);
});

/** The running session as tab 4 of an `agendo` host session, its pane idle — the shape x and enter act on. */
async function runningInHost(mock: MockEnv, fx: Fx, extra: Record<string, unknown> = {}): Promise<string> {
  const running = sessionName("claude", IDS.running);
  await mock.setTmuxState({
    sessions: ["agendo"],
    windows: [
      { session: "agendo", index: 0, name: "launcher" },
      { session: "agendo", index: 4, name: running },
    ],
    panes: [
      { session: "agendo", window: "launcher", cwd: mock.tmpDir, placeholder: false },
      { session: "agendo", window: running, cwd: fx.wt("running"), placeholder: false },
    ],
    captures: { [running]: tmuxState.captures[RUNNING_TARGET] },
    ...extra,
  });
  return running;
}

test("enter on a running row switches to its window, as on the session rows, starting nothing", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const running = await runningInHost(mock, fx, { currentSession: "agendo" });
  mock.env.TMUX = "/tmp/fake-tmux,1,0";
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Busy right now");
  await wt.press(KEY.enter);
  await wt.waitForText("switched to Busy right now", 20000);
  const log = await mock.tmuxLog();
  expect(log.filter((a) => a[0] === "switch-client")).toEqual([["switch-client", "-t", windowTarget("agendo", running)]]);
  expect(log.filter((a) => ["new-session", "new-window", "split-window", "respawn-pane"].includes(a[0]))).toEqual([]);
  // Still the cleanup view, with no dialog opened.
  expect(await wt.screen()).toContain("Cleanup —");
  expect(await wt.screen()).not.toContain("Clean up — Busy right now");
});

/** The `git status` calls the git probe made in `dir` — one per measurement of that row. */
const probesOf = (log: string[], dir: string) => log.filter((l) => l.startsWith("git ") && l.includes("--ignored") && l.includes(JSON.stringify(dir)));

test("D deletes every safe row after one confirmation, skips one that stopped being safe, and touches nothing else", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  await addFilterCases(fx);
  const wt = await openCleanup(launch, fx);
  await wt.press("D");
  const confirm = await wt.waitForText("Delete everything safe to remove — 2 rows?");
  expect(confirm).toContain("• Merged feature");
  expect(confirm).toContain("• spare");
  expect(confirm).not.toContain("• Half-done work");
  await wt.press("n");
  await wt.waitForText("nothing deleted");
  expect(existsSync(fx.wt("merged"))).toBe(true);

  // Between the measurement and the run, the spare worktree picks up work: it is re-checked and skipped.
  await wt.press("D");
  await wt.waitForText("Delete everything safe to remove — 2 rows?");
  await writeFile(join(fx.wt("spare"), "late.txt"), "written after it was measured\n");
  await wt.press("y");
  const done = await wt.waitForText("Cleanup finished: 1 removed, 0 failed, 1 skipped", 30000);
  expect(done).toMatch(/✓ Merged feature — removed worktree .*; deleted branch worktree-merged/);
  expect(done).toContain("– spare — skipped — no longer safe to remove");
  expect(existsSync(fx.wt("merged"))).toBe(false);
  expect(branchExists(fx, "worktree-merged")).toBe(false);
  for (const name of ["spare", "dirty", "orphan", "running", "pushed", "ignored", "dirtyonly"]) expect(existsSync(fx.wt(name))).toBe(true);
  for (const name of ["spare", "dirty", "orphan", "running", "pushed", "ignored", "dirtyonly"]) expect(branchExists(fx, `worktree-${name}`)).toBe(true);
  // The session itself is kept: its transcript is still there.
  const slug = fx.wt("merged").replace(/[^a-zA-Z0-9]/g, "-");
  expect(existsSync(join(mock.home, ".claude", "projects", slug, `${IDS.merged}.jsonl`))).toBe(true);
  await wt.press("x");
  await wt.waitForText(/Merged feature.*no checkout or branch/);
});

test("after a delete only the deleted row is measured again; R re-measures everything", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Merged feature");
  await wt.press(KEY.enter);
  await wt.waitForText("Clean up — Merged feature");
  await wt.press(KEY.enter);
  await wt.waitForText("Cleanup finished");
  const before = (await mock.callLog()).length;
  await wt.press("x");
  await wt.waitForText(/Merged feature.*no checkout or branch/);
  await expect.poll(async () => (await wt.screen()).includes("…"), { timeout: 45000 }).toBe(false);
  const after = (await mock.callLog()).slice(before);
  // The rows the delete could not have changed keep their measurements: no probe ran in them.
  for (const name of ["dirty", "orphan", "running"]) expect(probesOf(after, fx.wt(name))).toEqual([]);
  expect(probesOf(after, fx.repo)).toEqual([]);

  const mark = (await mock.callLog()).length;
  await wt.press("R");
  await expect.poll(async () => probesOf((await mock.callLog()).slice(mark), fx.wt("dirty")).length, { timeout: 45000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await wt.screen()).includes("…"), { timeout: 45000 }).toBe(false);
  for (const name of ["orphan", "running"]) expect(probesOf((await mock.callLog()).slice(mark), fx.wt(name)).length).toBeGreaterThan(0);
});

test("x asks again right after the model reloads: a pause, then x on the paused tab, gets its y/n", async ({ launch, mock }) => {
  const fx = await buildFixture(mock);
  await runningInHost(mock, fx);
  const wt = await openCleanup(launch, fx);
  await focus(wt, "Busy right now");
  await wt.press("p");
  await wt.waitForText("paused Busy right now", 20000);
  // The reload re-renders App and the view together; the very next key must still be the one that asked.
  await wt.waitForText(/◐ paused\s+Busy right now/, 20000);
  await wt.press("x");
  await wt.waitForText("Close Busy right now's paused tab for good? y/n", 20000);
  await wt.press("n");
  await wt.waitForText("Kill cancelled");
});
