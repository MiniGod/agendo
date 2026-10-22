// `openSession` with a STALE live target (src/launch/open.ts): the window the
// menu's last scan attributed a session to has since closed, and the exact
// target the scan handed over no longer resolves. The agent is still live —
// reopened in another host session, or resumed under its canonical name — and
// must be found there rather than cold-started a second time on its transcript.
//
// The e2e suite cannot reach this deterministically: the CLI scans and opens in
// one breath, and the menu re-scans every two seconds, so whether its model is
// stale when enter lands is a race. Here the scan's answer is simply passed in.
// tmux is the e2e harness's stateful fake (it never starts a server), linked
// alone into a directory placed ahead of the preload's guard bin.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { openSession } from "../src/launch/open.ts";
import { windowTarget } from "../src/runtime/tmux/index.ts";
import { removeDir } from "../scripts/hermetic.ts";
import type { AgentSession } from "../src/shared/types.ts";

const session = { id: "login-session", source: "claude", cwd: "/run/login", title: "Login" } as AgentSession;
const NAME = "cl-claude-loginsession";
const LEGACY = "cl-wi-101";

/** The fake server's state: `windows` as `[host, index, name]`. */
const tmuxState = (...windows: [string, number, string][]) => ({
  sessions: [...new Set(windows.map(([host]) => host))],
  windows: windows.map(([session, index, name]) => ({ session, index, name })),
  panes: windows.map(([session, , window], i) => ({ session, window, cwd: "/run/login", id: `%${i + 3}`, placeholder: false })),
  captures: {},
});

let dir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agendo-openlive-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(join(import.meta.dir, "..", "e2e", "fakebin", "tmux"), join(bin, "tmux"));
  saved = { PATH: process.env.PATH, TMUX: process.env.TMUX, FAKE_TMUX_STATE: process.env.FAKE_TMUX_STATE, FAKE_TMUX_LOG: process.env.FAKE_TMUX_LOG };
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  process.env.FAKE_TMUX_STATE = join(dir, "state.json");
  process.env.FAKE_TMUX_LOG = join(dir, "log.txt");
  writeFileSync(process.env.FAKE_TMUX_LOG, "");
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  removeDir(dir);
});

const verbs = () =>
  readFileSync(join(dir, "log.txt"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as string[])[0]);

const setState = (state: unknown) => writeFileSync(join(dir, "state.json"), JSON.stringify(state));

test("a stale target whose session is live under its canonical name elsewhere lands there", () => {
  setState(tmuxState(["agendo-b", 5, NAME]));
  const plan = openSession(session, { name: NAME, target: windowTarget("agendo-a", NAME) });
  expect(plan).toMatchObject({ alreadyRunning: true, mode: "handover", handover: ["tmux", "attach-session", "-t", windowTarget("agendo-b", NAME)] });
  expect(verbs()).not.toContain("new-session");
});

test("a stale LEGACY window whose session was since resumed under its canonical name lands on that, not a new legacy window", () => {
  // Nothing answers to `cl-wi-101` any more, so a lookup by that name alone
  // would create it — and start a second agent beside the canonical one.
  setState(tmuxState(["agendo", 2, NAME]));
  const plan = openSession(session, { name: LEGACY, target: windowTarget("claude-launcher", LEGACY) });
  expect(plan).toMatchObject({ alreadyRunning: true, handover: ["tmux", "attach-session", "-t", windowTarget("agendo", NAME)] });
  expect(verbs()).not.toContain("new-session");
});

test("outside tmux, a stale legacy window reopened under the same name is found by name and attached to", () => {
  // No id in the name, so only the lookup by name can find where it went.
  setState(tmuxState(["agendo-c", 3, LEGACY]));
  const plan = openSession(session, { name: LEGACY, target: windowTarget("claude-launcher", LEGACY) });
  expect(plan).toMatchObject({ alreadyRunning: true, mode: "handover", handover: ["tmux", "attach-session", "-t", "agendo-c:3"] });
  expect(verbs()).not.toContain("new-session");
});

test("inside tmux, the same fallback switches the client instead", () => {
  setState(tmuxState(["agendo-c", 3, LEGACY]));
  process.env.TMUX = "/tmp/fake-tmux,1,0";
  const plan = openSession(session, { name: LEGACY, target: windowTarget("claude-launcher", LEGACY) });
  expect(plan).toMatchObject({ alreadyRunning: true, mode: "inline", handover: ["tmux", "switch-client", "-t", "agendo-c:3"] });
  expect(verbs()).not.toContain("new-window");
});
