// How the ADO REST layer's failure handling shows up in the launcher. Same
// fully-mocked harness as launcher.spec.ts, with the mock server forced to
// answer specific endpoints (mock.setAdoResponse) so we can reproduce backend
// states the fixtures can't express.
//
// The case that matters: a team that has never configured any sprints gets a
// 404 from `teamsettings/iterations?$timeframe=current` instead of an empty
// `value` array. That used to propagate out of loadModel and strand the
// launcher on its "Press r to retry, q to quit" screen — which never recovers,
// since the retry re-issues the same request and gets the same 404. Diagnosis
// and original fix: HelgiHelgasonCMD (PR #18).
import { test, expect } from "./harness/test.ts";

const ITERATIONS = /_apis\/work\/teamsettings\/iterations$/i;

// The launcher's error screen, in the two lines it renders.
const ERROR_SCREEN = ["Error:", "Press r to retry"];

test("a 404 from the current-iteration endpoint means 'no current sprint', not an error", async ({
  launch,
  mock,
}) => {
  mock.setAdoResponse(ITERATIONS, { status: 404, body: { message: "no iterations configured" } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  const screen = await wt.screen();

  // The load completed: no error screen, and all three assigned work items are
  // there — under "Everything else assigned" (normally 1: the two Sprint 42
  // items sit in the sprint section) since with no current iteration nothing
  // can be in it.
  for (const line of ERROR_SCREEN) expect(screen).not.toContain(line);
  expect(screen).toContain("(nothing assigned in the current sprint)");
  expect(screen).toMatch(/Everything else assigned \(3\)/);
  expect(screen).not.toContain("Sprint 42"); // no iteration name beside the header

  // ...and they're real, fully-mapped items: opening the section shows them.
  // With the sprint section empty, that toggle is the first selectable row, so
  // the cursor already sits on it — `l` expands it. (Asserting the items are
  // hidden first keeps the waitForText below from passing on a screen that
  // never needed the keystroke.)
  expect(screen).not.toContain("Add login screen");
  await wt.press("l");
  const opened = await wt.waitForText("Add login screen", 10000);
  expect(opened).toContain("Fix crash on startup");
});

test("an empty iterations list also means 'no current sprint' (unchanged path)", async ({
  launch,
  mock,
}) => {
  // A team WITH sprints, none of them current — what ADO returns when the team
  // is configured. The 404 above has to land on exactly this behaviour.
  mock.setAdoResponse(ITERATIONS, { body: { count: 0, value: [] } });

  const wt = await launch();
  await wt.waitForText("Current sprint", 20000);
  await wt.waitForStable();
  const screen = await wt.screen();

  for (const line of ERROR_SCREEN) expect(screen).not.toContain(line);
  expect(screen).toContain("(nothing assigned in the current sprint)");
  expect(screen).toMatch(/Everything else assigned \(3\)/);
  expect(screen).not.toContain("Sprint 42");
});

test("a 404 from any other ADO endpoint still surfaces as an error", async ({ launch, mock }) => {
  // The 404 tolerance is opt-in per call site, so a not-found anywhere else —
  // here the work-item batch fetch — must still fail the load loudly rather
  // than being silently swallowed as "no work items".
  mock.setAdoResponse(/_apis\/wit\/workitems$/i, { status: 404 });

  const wt = await launch();
  const screen = await wt.waitForText("Press r to retry", 20000);
  expect(screen).toContain("Error:");
  expect(screen).toContain("404");
  expect(screen).not.toContain("Current sprint");
});
