// How the launcher reports and recovers from failures.
//
// The bug these cover, seen verbatim on a live launcher pane:
//
//     Error: Failed to parse JSON
//     Press r to retry, q to quit.
//
// Two separate defects in two lines. The message is the runtime's bare
// `Response.json()` failure with no hint of WHAT failed to parse, and the screen
// dead-ends until a human presses `r` — so an unattended launcher just sits
// there. So: every decode site names its source (src/errors.ts), and a load that
// fails transiently retries itself with bounded backoff (src/ui/App.tsx).
//
// Everything here runs against the fully mocked harness — fixture $HOME, mock
// ADO server, fake az/tmux/git — so nothing touches the real machine.
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect } from "./harness/test.ts";

// Endpoints faulted below. WIQL is the POST that resolves the identity's open
// work items: exactly one request per model load, and its failure propagates out
// of loadModel (unlike the enrichment calls, which swallow their own errors).
const WIQL = /_apis\/wit\/wiql$/i;
const WORKITEMS = /_apis\/wit\/workitems$/i;

// The token the fake `az` mints (e2e/fakebin/az). It must never reach the screen.
const TOKEN = "fake-ado-token";

// An expired Azure DevOps auth doesn't 401 — it answers 2xx with a sign-in page,
// which is precisely how you end up parsing HTML as JSON. The token is embedded
// on purpose: it proves the scrubber runs on the echoed body, not just that we
// happen never to log the Authorization header.
//
// And it is positioned to STRADDLE the 200-char body-snippet cut: padded so the
// token starts at char 194, six characters before the truncation point. Scrub
// after truncate and the snippet holds only `fake-a`, which no longer matches
// the secret and gets printed verbatim — a real bearer token is 1–2kB, so that
// prefix would be ~200 characters of live credential on screen. Scrub before
// truncate (what the code does) and nothing survives.
const TOKEN_AT = 194;
const PAGE_HEAD = `<!DOCTYPE html><html><head><title>Sign in to your account</title></head><body>auth=`;
const LOGIN_PAGE =
  PAGE_HEAD + "x".repeat(TOKEN_AT - PAGE_HEAD.length) + TOKEN + "</body></html>";

// Wide terminal: the contextual message is a long single line, and a narrow
// screen would wrap it mid-URL and defeat substring assertions.
const WIDE = { cols: 220, rows: 30 };

// Short retry loop so the bounded-backoff tests don't spend real seconds
// waiting. Both knobs are the ones production reads (see src/errors.ts). The
// base stays well above the harness's ~80ms screen poll: the "retrying…" screen
// has to be on-grid long enough to be observed, or the assertion on it would
// race the next attempt.
function fastRetries(env: Record<string, string>, attempts = 3): void {
  env.AGENDO_RETRY_ATTEMPTS = String(attempts);
  env.AGENDO_RETRY_BASE_MS = "500";
}

const countRequests = (requests: string[], suffix: string) =>
  requests.filter((r) => r.endsWith(suffix)).length;

// The dead-end error screen's hint, in full. The "retrying…" screen deliberately
// words its hint differently ("Press r to try again now"), so matching on this
// can't accidentally succeed mid-retry — which is exactly the trap that made an
// earlier version of the last test assert against attempt 1's screen.
const DEAD_END = "Press r to retry, q to quit.";

// ── Part 1: say what failed to parse ─────────────────────────────────────────

test("a non-JSON HTTP response names the request, its status and the body — never the token", async ({
  launch,
  mock,
}) => {
  fastRetries(mock.env);
  mock.setAdoRaw(WIQL, { status: 203, contentType: "text/html", body: LOGIN_PAGE });

  const wt = await launch(WIDE);
  const screen = await wt.waitForText(DEAD_END, 20000);

  // What failed to parse, from where, and what came back instead.
  expect(screen).toContain("Failed to parse JSON from POST");
  expect(screen).toContain("_apis/wit/wiql");
  expect(screen).toContain("203");
  expect(screen).toContain("<!DOCTYPE html>");
  // The bare runtime message, with nothing else on the line, is the bug.
  expect(screen).not.toMatch(/Error: Failed to parse JSON\s*$/m);

  // The token must not appear anywhere the launcher has ever written — not just
  // on the visible grid, but in the whole PTY stream. Asserted on a PREFIX too:
  // the token straddles the snippet cut, so a scrub-after-truncate bug leaks a
  // fragment rather than the whole string and a full-token check would pass.
  for (const secret of [TOKEN, TOKEN.slice(0, 6)]) {
    expect(screen).not.toContain(secret);
    expect(wt.output()).not.toContain(secret);
  }
  expect(screen).not.toContain("Authorization");
  expect(screen).not.toContain("Bearer");
});

test("a corrupt state.json is reported by path and the launcher still starts", async ({
  launch,
  mock,
}) => {
  // A stale cache file must not brick the tool: state.json holds UI preferences
  // only, so a malformed one falls back to defaults and says so.
  const statePath = join(mock.home, ".agendo", "state.json");
  await mkdir(join(mock.home, ".agendo"), { recursive: true });
  await writeFile(statePath, '{"provider": "ado", "identityName": ');

  const wt = await launch(WIDE);
  // It loaded — the live list UI, no error screen — because the corrupt file was
  // ignored. (Asserted backend-agnostically: state.json is also where the backend
  // choice is pinned, so falling back to defaults may pick the other one.)
  const loaded = await wt.waitForText("r refresh", 20000);
  expect(loaded).not.toContain("Press r to retry");
  expect(loaded).not.toContain("Failed to parse JSON");

  // …and it said which file it ignored, by absolute path.
  const screen = await wt.waitForText(statePath, 10000);
  expect(screen).toContain("isn't valid JSON");

  // The diagnostic is DRAINED, not accumulated: `r` clears the notice and
  // reloads, and the warning does not come back — otherwise a file the user has
  // since fixed would keep being reported for the life of the process.
  await wt.press("r");
  await wt.waitForText("r refresh", 20000);
  await wt.waitForStable();
  expect(await wt.screen()).not.toContain(statePath);
});

// ── Part 2: retry automatically ──────────────────────────────────────────────

test("a transient failure recovers on the next attempt with no keypress", async ({ launch, mock }) => {
  fastRetries(mock.env);
  // One 503, then the real fixture. `times: 1` is what makes the retry the only
  // thing that can produce a loaded screen.
  mock.setAdoRaw(WIQL, { status: 503, body: "upstream unavailable", times: 1 });

  const wt = await launch(WIDE);
  // The retry screen is not a frozen "Loading…": it says what failed and when
  // the next attempt lands.
  const waiting = await wt.waitForText("retrying in", 20000);
  expect(waiting).toContain("attempt 2 of 3");
  expect(waiting).toContain("503");

  // No keystroke is ever sent — the launcher recovers on its own.
  const loaded = await wt.waitForText("Current sprint", 20000);
  expect(loaded).not.toContain("Press r to retry");
  expect(loaded).toMatch(/Everything else assigned/);

  // Exactly one retry: the failed attempt plus the one that worked.
  expect(countRequests(mock.ado.requests, "/_apis/wit/wiql")).toBe(2);
});

test("a permanent failure is not retried at all, and r/q still work", async ({ launch, mock }) => {
  fastRetries(mock.env);
  // A 404 answers identically on every attempt — retrying it is the bug PR #18
  // ran into, where the retry screen could never recover.
  mock.setAdoRaw(WORKITEMS, { status: 404, body: JSON.stringify({ message: "not found" }) });

  const wt = await launch(WIDE);
  const screen = await wt.waitForText(DEAD_END, 20000);
  expect(screen).toContain("404");
  await wt.waitForStable();

  // One request, no automatic retries — a permanent failure stops immediately.
  expect(countRequests(mock.ado.requests, "/_apis/wit/workitems")).toBe(1);

  // The ADO explanation reaches the user, not just the status code — an error
  // body is where "the team does not exist" actually lives.
  expect(screen).toContain("not found");

  // Manual retry still works: `r` re-runs the load (and hits the same 404).
  await wt.press("r");
  await wt.waitForStable();
  expect(countRequests(mock.ado.requests, "/_apis/wit/workitems")).toBe(2);
  expect(await wt.screen()).toContain(DEAD_END);

  // …and so does `q`: the dead-end screen is quittable, not a trap.
  await wt.press("q");
  await expect.poll(() => wt.exitCode, { timeout: 10000 }).not.toBeNull();
});

test("a persistently transient failure gives up at the cap and shows the error", async ({
  launch,
  mock,
}) => {
  fastRetries(mock.env, 3);
  // 503 forever: retryable, so the loop runs — and must still stop. The delay
  // makes each attempt slow enough to observe while it is in flight.
  mock.setAdoRaw(WIQL, { status: 503, body: "upstream unavailable", delayMs: 700 });

  const wt = await launch(WIDE);

  // Between the backoff ending and the next attempt failing, the screen must say
  // the attempt is RUNNING — not sit on a countdown frozen at "retrying in 0s",
  // which is the frozen screen this whole feature replaces.
  const running = await wt.waitForText("retrying now", 30000);
  expect(running).toMatch(/attempt \d of 3/);

  const screen = await wt.waitForText(DEAD_END, 30000);
  // The final screen carries the contextual error, not a bare failure.
  expect(screen).toContain("503");
  expect(screen).toContain("_apis/wit/wiql");

  // Exactly the configured number of attempts — bounded, not a retry storm.
  await wt.waitForStable();
  expect(countRequests(mock.ado.requests, "/_apis/wit/wiql")).toBe(3);

  // And `r` still forces another go from the dead-end screen.
  await wt.press("r");
  await wt.waitForText("retrying in", 20000);
});
