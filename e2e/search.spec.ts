// `/` search ranking and session-identity search, driven through the real TUI.
//
// The PR matcher is a subsequence fuzzy match, so a PR-id query also hits a PR
// whose id shares a prefix and whose title supplies the remaining digit. Search
// results are date-sorted, so before ranking the newer near-miss sat ABOVE the
// PR the user actually named. Session ids and tmux window names are matched
// exactly (or by a long prefix), and find the row the session belongs to.
import { test, expect } from "./harness/test.ts";
import { CODEX_SESSION_ID, RUNNING_TARGET } from "./harness/fixtures.ts";
import type { WebTerminal } from "./harness/wterm.ts";

/** The result lines under the "Search results" header, header excluded. */
function resultLines(screen: string): string[] {
  const lines = screen.split("\n");
  const at = lines.findIndex((l) => l.includes("Search results"));
  return lines.slice(at + 1).filter((l) => l.trim() !== "");
}

async function search(wt: WebTerminal, query: string): Promise<string[]> {
  await wt.press("/");
  await wt.press(query, 300);
  await wt.waitForText(`"${query}"`);
  return resultLines(await wt.waitForStable());
}

async function openView(wt: WebTerminal, key: string, marker: string): Promise<void> {
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  await wt.press(key);
  await wt.waitForText(marker);
}

test("an exact PR id ranks above a newer PR that only fuzzily matches it", async ({ launch, mock }) => {
  // The PR view sorts by creation date, and !7001 was created after !7002. With
  // a trailing "2" in its title, "7002" is a subsequence of "!7001 … 2", so the
  // newer !7001 matches too — and used to sort above the PR actually named.
  mock.setAdoPr(7001, { title: "Refactor the parser 2" });
  const wt = await launch();
  await openView(wt, "2", "Awaiting your review");

  for (const query of ["7002", "!7002"]) {
    const rows = await search(wt, query);
    expect(rows[0]).toContain("Speed up startup"); // !7002, the exact hit
    expect(rows.slice(1).some((l) => l.includes("Refactor the parser 2"))).toBe(true); // kept, below it
    await wt.press("\x1b"); // esc clears the search
    await wt.waitForText("Awaiting your review");
  }
});

test("a session's tmux window name finds its PR on the PR page", async ({ launch }) => {
  const wt = await launch();
  await openView(wt, "2", "Awaiting your review");

  // The running login session (window cl-claude-loginsession) sits on PR 5001's branch.
  const rows = await search(wt, RUNNING_TARGET);
  expect(rows[0]).toContain("Add login screen");
  expect(rows.join("\n")).not.toContain("Refactor the parser");
});

test("a session's full uuid, its short id and a prefix find it on the sessions page", async ({ launch }) => {
  const wt = await launch();
  await openView(wt, "3", "Running now");

  // The uuid; its first 12 alphanumerics (agendo's short id, "019cde00-1111");
  // and an 8-character prefix, which only the prefix rule matches.
  for (const query of [CODEX_SESSION_ID, CODEX_SESSION_ID.slice(0, 13), CODEX_SESSION_ID.slice(0, 8)]) {
    const rows = await search(wt, query);
    expect(rows[0]).toContain("[codex]");
    expect(rows.join("\n")).not.toContain("Implement login form");
    await wt.press("\x1b");
    await wt.waitForText("Running now");
  }
});
