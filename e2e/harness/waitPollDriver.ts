// Child driver for the "`agendo wait` adds no transcript parsing" assertion in
// sessions-cache.spec.ts.
//
// The point: `wait` must ride the SessionIndex's existing cached build, not add a
// second scanner. Counting parses on an untouched corpus would prove nothing — the
// mtime/size cache returns 0 misses whether or not the poll loop rebuilds the
// index. So this driver MUTATES a transcript while the wait is looping. A rebuild
// would see the changed mtime+size, miss the cache and re-parse (parses > 0); a
// loop that only reads tmux can't notice the file at all (parses stays 0).
//
// Run as a subprocess against the e2e mock env (fixture $HOME + fakebin PATH +
// FAKE_TMUX_STATE), because os.homedir() is read at process start. `runWait`
// returns its exit code instead of calling process.exit, so the whole poll path
// runs in-process here and the parse counter is readable after it returns.
// The report goes to a file (WAIT_DRIVER_REPORT) so `wait`'s own stdout can't
// corrupt it.
import { writeFileSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { SessionIndex, __claudeParseCount, __resetClaudeParseCount } from "../../src/sessions.ts";
import { runWait } from "../../src/wait.ts";
import { BUSY_PANE, LOGIN_SESSION_ID, RUNNING_TARGET, tmuxState } from "./fixtures.ts";

const STATE = process.env.FAKE_TMUX_STATE as string;
const TMUX_LOG = process.env.FAKE_TMUX_LOG as string;
const REPORT = process.env.WAIT_DRIVER_REPORT as string;
const transcript = join(homedir(), ".claude", "projects", "appweb-login", `${LOGIN_SESSION_ID}.jsonl`);

const setState = (s: unknown) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const busyState = { ...tmuxState, captures: { [RUNNING_TARGET]: BUSY_PANE } };

// Start busy so the wait has to poll for a while.
setState(busyState);

// 1) Cold build to warm the transcript cache, exactly as a real `wait` invocation
//    would on its single up-front SessionIndex.build().
const cold = await SessionIndex.build();
const coldParses = __claudeParseCount();

// 2) Mutate a transcript once the poll loop is demonstrably RUNNING, then let the
//    pane settle. Sequencing off the fake tmux's call log (a `capture-pane` entry
//    can only come from inside poll()) rather than a wall-clock timer: on a slow
//    machine a timed mutation could land during runWait's own up-front build and
//    be attributed to the loop, making the test flaky.
let mutated = false;
const pollStarted = () => {
  try {
    return readFileSync(TMUX_LOG, "utf-8").includes('"capture-pane"');
  } catch {
    return false;
  }
};
const watcher = setInterval(() => {
  if (!pollStarted()) return;
  if (!mutated) {
    appendFileSync(
      transcript,
      JSON.stringify({ type: "ai-title", aiTitle: "Retitled mid-wait", timestamp: "2026-07-08T11:00:00Z" }) + "\n",
    );
    mutated = true;
    return;
  }
  // A tick later (so the loop polls at least once against the invalidated cache
  // entry), let the pane go ready so the wait can settle and return.
  setState(tmuxState);
  clearInterval(watcher);
}, 20);

__resetClaudeParseCount();
const code = await runWait({
  ids: [LOGIN_SESSION_ID],
  all: false,
  any: false,
  json: false,
  scope: null,
  timeoutMs: 15_000,
  intervalMs: 150,
});
const waitParses = __claudeParseCount();
clearInterval(watcher);

// 3) Sanity: the mutation really did land, so a rebuild WOULD have re-parsed it.
//    Without this the zero above could just mean "nothing changed".
const mutationLanded = readFileSync(transcript, "utf-8").includes("Retitled mid-wait");
// …and a build now really does re-parse it — proving the counter isn't just stuck.
__resetClaudeParseCount();
await SessionIndex.build();
const reparsesAfter = __claudeParseCount();

writeFileSync(
  REPORT,
  JSON.stringify({
    code,
    coldSessions: cold.all.length,
    coldParses,
    waitParses,
    mutated: mutationLanded,
    reparsesAfter,
  }),
);
