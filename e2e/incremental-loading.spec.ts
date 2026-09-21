// The launcher must never make the cheap local session view wait behind tracker
// requests. These specs hold individual ADO responses back while driving the
// real Ink UI, proving each completed slice is painted independently.
import { test, expect } from "./harness/test.ts";

const WIQL = /_apis\/wit\/wiql$/i;
const PR_LIST = /_apis\/git\/pullrequests$/i;
const ADA_WORK_ITEMS = JSON.stringify({
  workItems: [{ id: 101 }, { id: 102 }, { id: 103 }],
});

test("cold boot exposes Sessions before the tracker, then adds its links in place", async ({ launch, mock }) => {
  mock.setAdoRaw(WIQL, { body: ADA_WORK_ITEMS, delayMs: 3000, times: 1 });

  const wt = await launch();
  let screen = await wt.waitForText("1 Work items ⟳", 10000);
  expect(screen).toContain("2 PRs ⟳");

  await wt.press("3");
  screen = await wt.waitForText("Implement login form", 10000);
  expect(screen).not.toContain("!5001 → WI 101");

  // No keypress or full-screen replacement: the same session row gains its
  // backend association when the delayed item/PR work completes.
  await wt.waitForText("!5001 → WI 101", 15000);
  await expect.poll(async () => await wt.screen(), { timeout: 10000 }).not.toContain("2 PRs ⟳");
  screen = await wt.screen();
  expect(screen).not.toContain("1 Work items ⟳");
});

test("Work items becomes ready while independent PR requests are still loading", async ({ launch, mock }) => {
  // Creator + reviewer lists share this path. Empty is a valid answer; holding
  // both calls proves the item stage does not wait for either one.
  mock.setAdoRaw(PR_LIST, {
    body: JSON.stringify({ value: [] }),
    delayMs: 3000,
    times: 2,
  });

  const wt = await launch();
  const screen = await wt.waitForText("Current sprint", 10000);
  expect(screen).not.toContain("1 Work items ⟳");
  expect(screen).toContain("2 PRs ⟳");

  await wt.press("2");
  await wt.waitForText("PRs on your work items", 15000);
  expect(await wt.screen()).not.toContain("2 PRs ⟳");
});

test("refresh keeps old rows while local tmux state and network slices update", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Add login screen", 20000);

  // The tracker refresh is deliberately slow. The local rescan should still
  // publish the now-idle tmux state immediately, while the old work-item rows
  // remain usable under a small background-refresh indicator.
  mock.setAdoRaw(WIQL, { body: ADA_WORK_ITEMS, delayMs: 3000, times: 1 });
  const tmux = await mock.getTmuxState();
  await mock.setTmuxState({ ...tmux, sessions: [], windows: [], panes: [], captures: {} });
  await wt.press("r");

  let screen = await wt.waitForText("Refreshing work items in the background", 10000);
  expect(screen).toContain("Add login screen");

  await wt.press("3");
  await expect.poll(async () => await wt.screen(), { timeout: 10000 }).not.toContain("Running now");
  screen = await wt.screen();
  expect(screen).toContain("1 Work items ⟳");
  expect(screen).toContain("appweb");

  await wt.press("1");
  await expect.poll(async () => await wt.screen(), { timeout: 15000 }).not.toContain("1 Work items ⟳");
  expect(await wt.screen()).toContain("Add login screen");
});
