// `agendo focus` — bring the session for a PR, a work item or an id to the front
// of the terminal the human is using — and `agendo url`, the agendo:// scheme
// handler that is its browser-facing door.
//
// Runs OUTSIDE tmux when a browser starts it, so it never assumes a current
// client: it picks the attached client with the latest input and moves THAT one.
// It only ever focuses, or resumes and then focuses, a session that already
// exists. It never launches a new one, sends to one or closes one — a URL that
// any web page can trigger must not be able to do more than change what is on
// screen.
import {
  exactTarget, focusClientOn, listClients, liveTargetForShortId, pickClient, sessionName, shortId, tmuxAvailable, windowIdentity,
  type TmuxClient, type WindowIdentity,
} from "../../runtime/tmux/index.ts";
import { refreshLiveTmux, loadModel } from "../../app/model/index.ts";
import { recordLaunchedSession } from "../../runtime/restore/index.ts";
import { SessionIndex } from "../../sessions/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import { currentModelOptions } from "../links.ts";
import { flushWarnings } from "../warnings.ts";
import { querySessions } from "../list/index.ts";
import { sessionState } from "../list/rows.ts";
import { findSession, resumeSession } from "../commands/resume.ts";
import { describeTarget, parseFocusUrl, type FocusTarget } from "./url.ts";
import { parseFocusArgs, pickSession, type FocusCandidate } from "./choose.ts";
import { failLoudly } from "./notify.ts";
import { raiseTerminal } from "./raise.ts";
import { focusTerminalTemplate, openTerminal } from "./terminal.ts";

const NO_CLIENT = "no tmux client is attached — open a terminal and run `tmux attach` first";

/** The sessions a PR / work item links to, through the same query `list --pr/--work-item` runs. */
async function linkedSessions(target: Exclude<FocusTarget, { kind: "session" }>): Promise<AgentSession[]> {
  try {
    const model = await loadModel(currentModelOptions());
    return target.kind === "pr" ? querySessions(model, target.id, undefined) : querySessions(model, undefined, target.id);
  } catch (e) {
    failLoudly(`could not look up ${describeTarget(target)}: ${(e as Error)?.message ?? String(e)}`);
  } finally {
    flushWarnings("focus");
  }
}

/** Every session the target could mean. */
async function candidates(target: FocusTarget, index: SessionIndex): Promise<AgentSession[]> {
  if (target.kind !== "session") return linkedSessions(target);
  const s = findSession(index.all, target.token);
  return s ? [s] : [];
}

/** The candidates with their live state, as `list` would report it. */
function withStates(sessions: AgentSession[], all: AgentSession[]): FocusCandidate[] {
  const { live, livePlaceholders } = refreshLiveTmux(all);
  return sessions.map((s) => {
    const canon = sessionName(s);
    return { s, state: sessionState(live.has(canon), canon, livePlaceholders) };
  });
}

/** Say which session won when there was a choice to make. */
function reportChoice(chosen: FocusCandidate, all: FocusCandidate[], target: FocusTarget): void {
  if (all.length < 2) return;
  console.error(
    `focus: ${all.length} sessions are linked to ${describeTarget(target)}; ` +
      `focusing ${shortId(chosen.s.id)} (${chosen.state}, last active ${chosen.s.lastUsed.toISOString()})`,
  );
}

/** The tmux target of a running session's window, freshly read. */
function runningTarget(s: AgentSession, all: AgentSession[]): string | null {
  return refreshLiveTmux(all).liveWindows.get(sessionName(s))?.target ?? liveTargetForShortId(shortId(s.id))?.target ?? null;
}

/** Make sure the chosen session has a window — resuming it if needed — and return that window's target. */
async function bringUp(c: FocusCandidate, all: AgentSession[]): Promise<string> {
  if (c.state === "running") {
    const t = runningTarget(c.s, all);
    if (t) return t;
  }
  const r = await resumeSession(c.s, all);
  if ("peer" in r) {
    failLoudly(`session ${shortId(c.s.id)} is running outside agendo (pid ${r.peer.pid}); there is no window to focus`, 2);
  }
  recordLaunchedSession(
    { id: c.s.id, cwd: c.s.cwd, title: c.s.title, source: c.s.source, configDir: c.s.configDir },
    r.plan.tmuxName,
  );
  console.error(`focus: resumed session ${shortId(c.s.id)} (was ${c.state})`);
  return runningTarget(c.s, all) ?? exactTarget(r.plan.tmuxName);
}

/** No client to move: open the configured terminal on the session, or fail. */
function withoutClient(where: WindowIdentity, template: string | null): never {
  if (template && openTerminal(template, where.session)) {
    console.log(`focus: no tmux client attached; opened a terminal on ${where.session}`);
    process.exit(0);
  }
  failLoudly(NO_CLIENT);
}

/** Move `client` onto the window and raise its terminal. */
function switchTo(client: TmuxClient, where: WindowIdentity, target: string, s: AgentSession): never {
  if (!focusClientOn(client.name, where.windowId, target.startsWith("%") ? target : undefined)) {
    failLoudly(`tmux could not switch ${client.name} to session ${shortId(s.id)}`);
  }
  raiseTerminal(client.pid);
  console.log(`focused session ${shortId(s.id)} (window ${where.windowId} in ${where.session}) on ${client.name}`);
  process.exit(0);
}

/** The session to focus, its candidates' states read live; fails when there is none. */
async function chooseSession(target: FocusTarget): Promise<{ chosen: FocusCandidate; all: AgentSession[] }> {
  const index = await SessionIndex.build();
  const found = withStates(await candidates(target, index), index.all);
  const chosen = pickSession(found);
  if (!chosen) failLoudly(`No agendo session for ${describeTarget(target)}`);
  reportChoice(chosen, found, target);
  return { chosen, all: index.all };
}

/** Focus what `target` names; see the header. Always exits. */
export async function runFocus(target: FocusTarget): Promise<never> {
  if (!tmuxAvailable()) failLoudly("tmux was not found on PATH");
  const { chosen, all } = await chooseSession(target);
  // Checked BEFORE any resume: with nothing to show it on and no terminal to
  // open, waking an agent would only leave it running unseen.
  const client = pickClient(listClients());
  const template = client ? null : focusTerminalTemplate();
  if (!client && !template) failLoudly(NO_CLIENT);
  const t = await bringUp(chosen, all);
  const where = windowIdentity(t) ?? failLoudly(`could not find the tmux window of session ${shortId(chosen.s.id)}`);
  if (!client) withoutClient(where, template);
  switchTo(client, where, t, chosen.s);
}

/** `agendo focus <args>`. */
export async function focusCommand(argv: string[]): Promise<never> {
  const a = parseFocusArgs(argv);
  if (!a.ok) failLoudly(a.error);
  return runFocus(a.target);
}

/**
 * `agendo url <url>` — what the agendo:// desktop entry runs. Exactly one
 * argument, parsed by the allowlist in url.ts; anything it refuses is reported
 * WITHOUT echoing the URL into the notification, since the URL is the
 * attacker-controlled part.
 */
export async function urlCommand(argv: string[]): Promise<never> {
  const parsed = argv.length === 1 ? parseFocusUrl(argv[0]) : { ok: false as const, reason: "expected exactly one URL" };
  if (!parsed.ok) {
    console.error(`url: refused ${JSON.stringify((argv[0] ?? "").slice(0, 200))}`);
    failLoudly(`refused an agendo:// link: ${parsed.reason}`);
  }
  return runFocus(parsed.target);
}
