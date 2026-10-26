// The config.json rows of the Settings page (`,`), end to end: the team picker
// listing the signed-in user's own teams (`$mine=true`), typing a team by
// hand, a value that fails validation, and the Work items notice for a team
// that isn't the user's. Every save lands in the temp HOME the mock env made —
// whose config.json starts out in the LEGACY ~/.claude-launcher/ dir (see
// materializeHome), so the first save here is also the migration to
// ~/.agendo/config.json.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect, KEY } from "./harness/test.ts";
import type { WebTerminal } from "./harness/wterm.ts";

const CTRL_U = "\x15";
const legacyPath = (home: string) => join(home, ".claude-launcher", "config.json");
const configPath = (home: string) => join(home, ".agendo", "config.json");
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf-8"));

// Team B's current iteration, so a switch to it shows on the list.
const TEAM_B_ITERATIONS = /\/Team%20B\/_apis\/work\/teamsettings\/iterations$/i;
const SPRINT_43 = { body: { value: [{ id: "it-43", name: "Sprint 43", path: "Widgets\\Sprint 43" }] } };

// Settings rows, top to bottom: Backend, Viewing as, Auto-resume, then config.json's.
const ROW = { team: 5, stalledAfterMinutes: 8 } as const;

/** Open Settings from the list and put the cursor on row `index`, labelled `label`. */
async function settingsRow(wt: WebTerminal, index: number, label: string): Promise<string> {
  await wt.press(",");
  await wt.waitForText("Authentication");
  for (let i = 0; i < index; i++) await wt.press("j");
  return wt.waitForText(`❯ ${label}`);
}

/** The team picker, its list loaded. */
async function teamPicker(wt: WebTerminal): Promise<string> {
  await settingsRow(wt, ROW.team, "Team");
  await wt.press(KEY.enter);
  await wt.waitForText("your teams in Widgets");
  return wt.waitForText("Team B");
}

test("picking one of your teams saves it to ~/.agendo, carrying the legacy file's other keys, and the sprint follows", async ({
  launch,
  mock,
}) => {
  const legacy = JSON.stringify({ org: "acme", project: "Widgets", team: "Team A", hmiTag: "keep-me" }, null, 2);
  await writeFile(legacyPath(mock.home), legacy);
  mock.setAdoResponse(TEAM_B_ITERATIONS, SPRINT_43);

  const wt = await launch();
  await wt.waitForText("Sprint 42", 20000);
  await wt.waitForStable();

  const page = await settingsRow(wt, ROW.team, "Team");
  expect(page).toContain("config.json · read from ~/.claude-launcher/config.json · saving writes all of it to ~/.agendo/config.json");
  expect(page).toMatch(/Organization\s+acme/);
  expect(page).toMatch(/Project\s+Widgets/);
  expect(page).toMatch(/Team\s+Team A/);
  expect(page).toMatch(/Resource\s+499b84ac-1321-427f-aa17-267ca6975798 {2}\(Azure DevOps' fixed app id, not editable\)/);

  await wt.press(KEY.enter);
  const picker = await wt.waitForText("○ Team B");
  expect(picker).toContain("Settings › Team — your teams in Widgets");
  expect(picker).toMatch(/❯ ● Team A/); // the current team, under the cursor
  expect(picker).toContain("✎ type a team name…");

  await wt.press("j");
  await wt.press(KEY.enter);
  const saved = await wt.waitForText("✓ Team saved to ~/.agendo/config.json");
  expect(saved).toContain("config.json · ~/.agendo/config.json");
  expect(saved).toMatch(/Team\s+Team B/);

  expect(await readJson(configPath(mock.home))).toEqual({ org: "acme", project: "Widgets", team: "Team B", hmiTag: "keep-me" });
  expect(await readFile(legacyPath(mock.home), "utf-8")).toBe(legacy);

  // No restart: the model reloaded against Team B's iteration.
  await wt.press(KEY.escape);
  const list = await wt.waitForText("Sprint 43", 20000);
  expect(list).not.toContain("Sprint 42");
  expect(mock.ado.requests.some((r) => TEAM_B_ITERATIONS.test(r))).toBe(true);
});

test("the picker's last row types a team name instead", async ({ launch, mock }) => {
  mock.setAdoResponse(TEAM_B_ITERATIONS, SPRINT_43);
  const wt = await launch();
  await wt.waitForText("Sprint 42", 20000);
  await wt.waitForStable();

  await teamPicker(wt);
  await wt.press("k"); // from the current team at the top, up wraps to "type a team name…"
  await wt.waitForText("❯ ✎ type a team name…");
  await wt.press(KEY.enter);
  const editor = await wt.waitForText("Settings › Team");
  expect(editor).toContain("Team: Team A"); // opened on the current value
  expect(editor).toContain("exactly as Azure DevOps names it");

  await wt.press(CTRL_U);
  await wt.press("Team B");
  await wt.waitForText("Team: Team B");
  await wt.press(KEY.enter);
  await wt.waitForText("✓ Team saved to ~/.agendo/config.json");
  expect((await readJson(configPath(mock.home))).team).toBe("Team B");

  await wt.press(KEY.escape);
  await wt.waitForText("Sprint 43", 20000);
});

test("a value that doesn't validate stays in the editor with the reason, and saves nothing", async ({ launch, mock }) => {
  const wt = await launch();
  await wt.waitForText("Sprint 42", 20000);
  await wt.waitForStable();

  await settingsRow(wt, ROW.stalledAfterMinutes, "Stalled after (minutes)");
  await wt.press(KEY.enter);
  await wt.waitForText("Stalled after (minutes): 240");

  // `q` is a character here, not quit.
  await wt.press(CTRL_U);
  await wt.press("q");
  await wt.press(KEY.enter);
  const refused = await wt.waitForText("✗ enter a positive number of minutes (e.g. 240)");
  expect(refused).toContain("Stalled after (minutes): q");
  expect(existsSync(configPath(mock.home))).toBe(false);

  await wt.press(CTRL_U);
  await wt.press("90");
  await wt.press(KEY.enter);
  const saved = await wt.waitForText("✓ Stalled after (minutes) saved to ~/.agendo/config.json");
  expect(saved).toMatch(/Stalled after \(minutes\)\s+90/);
  expect(await readJson(configPath(mock.home))).toEqual({ org: "acme", project: "Widgets", team: "Team A", stalledAfterMinutes: 90 });
});

test("a configured team that isn't one of yours says so in Work items, until it's fixed from Settings", async ({ launch, mock }) => {
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(configPath(mock.home), JSON.stringify({ org: "acme", project: "Widgets", team: "Team DES" }));

  const wt = await launch();
  const NOTICE = "⚑ team 'Team DES' isn't one of yours (Team A, Team B), set it in , settings";
  await wt.waitForText(NOTICE, 20000);

  const picker = await teamPicker(wt);
  expect(picker).toMatch(/❯ ○ Team A/); // no current team in the list: the cursor starts at the top
  await wt.press(KEY.enter);
  await wt.waitForText("✓ Team saved");
  await wt.press(KEY.escape);
  await wt.waitForText("Sprint 42", 20000);
  await expect.poll(async () => (await wt.screen()).includes("isn't one of yours"), { timeout: 20000 }).toBe(false);
});

test("a team the project doesn't have, with your teams unlistable, reads as not found", async ({ launch, mock }) => {
  mock.setAdoResponse(/\/teams\/[^/]+\/members$/i, { status: 404, body: { message: "team not found" } });
  mock.setAdoResponse(/_apis\/projects\/[^/]+\/teams$/i, { status: 500 });

  const wt = await launch();
  const screen = await wt.waitForText("⚑ team 'Team A' wasn't found in Widgets, set it in , settings", 20000);
  expect(screen).toContain("Sprint 42"); // the load itself completed
  expect(screen).not.toContain("Press r to retry");

  // The picker can't list the teams either; typing a name is still on offer.
  await settingsRow(wt, ROW.team, "Team");
  await wt.press(KEY.enter);
  const picker = await wt.waitForText("✗ couldn't list your teams:");
  expect(picker).toContain("❯ ✎ type a team name…");
});

test("a hand-edited team that isn't text reads as no team, and the picker still opens", async ({ launch, mock }) => {
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(configPath(mock.home), JSON.stringify({ org: "acme", project: "Widgets", team: null }));

  const wt = await launch();
  const screen = await wt.waitForText("⚑ no team is set, so there is no current sprint — set it in , settings", 20000);
  expect(screen).not.toContain("Press r to retry");

  const picker = await teamPicker(wt);
  expect(picker).toMatch(/❯ ○ Team A/);
  await wt.press(KEY.enter);
  await wt.waitForText("✓ Team saved");
  expect((await readJson(configPath(mock.home))).team).toBe("Team A");
});

test("in a terminal too short for every row, the page windows them around the cursor", async ({ launch }) => {
  const wt = await launch({ rows: 18 });
  await wt.waitForText("Sprint 42", 20000);
  await wt.waitForStable();

  await wt.press(",");
  let screen = await wt.waitForText("↓ 6 more");
  expect(screen.split("\n")[0].trim()).toBe("Settings");
  expect(screen).toContain("❯ Backend");
  expect(screen).not.toContain("Focus terminal");

  await wt.press("k"); // up from the top wraps to the last row
  screen = await wt.waitForText("❯ Focus terminal");
  expect(screen.split("\n")[0].trim()).toBe("Settings");
  expect(screen).toContain("↑ 6 more");
  expect(screen).not.toContain("Backend");
  expect(screen).toContain("Authentication");
});
