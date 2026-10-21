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
  LAUNCHER_SESSION, exactTarget, focusClientOn, hasSession, listClients, liveTargetForShortId, pickClient, selectWindow,
  sessionName, sessionRoot, shortId, tmuxAvailable, windowIdentity, type TmuxClient, type WindowIdentity,
} from "../../runtime/tmux/index.ts";
import { refreshLiveTmux, loadModel } from "../../app/model/index.ts";
import { recordLaunchedSession } from "../../runtime/restore/index.ts";
import { SessionIndex } from "../../sessions/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import { currentModelOptions } from "../links.ts";
import { flushWarnings } from "../warnings.ts";
import { sessionState } from "../list/rows.ts";
import { findSession, resumeSession } from "../commands/resume.ts";
import { describeTarget, parseFocusUrl, type FocusTarget } from "./url.ts";
import { parseFocusArgs, pickSession, type FocusCandidate } from "./choose.ts";
import { linkedMatches, resolveLinked } from "./linked.ts";
import { failLoudly } from "./notify.ts";
import { raiseTerminal } from "./raise.ts";
import { focusTerminalTemplate, openTerminal } from "./terminal.ts";
import { claimUrlResume } from "./throttle.ts";

const NO_CLIENT = "no tmux client is attached — open a terminal and run `tmux attach` first";

/** Where a focus came from: a link may resume only so often (see throttle.ts). */
export interface FocusOrigin {
  fromUrl: boolean;
}

/** The model the PR / work-item lookup runs against, or a loud failure — with load warnings flushed first, since they may be why. */
async function loadFocusModel(target: FocusTarget): Promise<Awaited<ReturnType<typeof loadModel>>> {
  try {
    const model = await loadModel(currentModelOptions());
    flushWarnings("focus");
    return model;
  } catch (e) {
    flushWarnings("focus");
    failLoudly(`could not look up ${describeTarget(target)}: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** The sessions a PR / work item links to — refused when the number names more than one of them (see linked.ts). */
async function linkedSessions(target: Exclude<FocusTarget, { kind: "session" }>): Promise<AgentSession[]> {
  const r = resolveLinked(linkedMatches(await loadFocusModel(target), target));
  if ("sessions" in r) return r.sessions;
  return failLoudly(`${describeTarget(target)} is ambiguous — it matches ${r.ambiguous.join(" and ")}; use \`focus <session-id>\``);
}

/** Every session the target could mean. */
async function candidates(target: FocusTarget, index: SessionIndex): Promise<AgentSession[]> {
  if (target.kind !== "session") return linkedSessions(target);
  const s = findSession(index.all, target.token);
  return s ? [s] : [];
}

/** The candidates with their live state, as `list` would report it, and where a paused one's tab sits. */
function withStates(sessions: AgentSession[], all: AgentSession[]): FocusCandidate[] {
  const { live, livePlaceholders, placeholderWindows } = refreshLiveTmux(all);
  return sessions.map((s) => {
    const canon = sessionName(s);
    return { s, state: sessionState(live.has(canon), canon, livePlaceholders), host: placeholderWindows.get(canon)?.session };
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

/** A link may not resume twice in quick succession (see throttle.ts). */
function throttleUrlResume(origin: FocusOrigin): void {
  const wait = origin.fromUrl ? claimUrlResume() : 0;
  if (wait > 0) failLoudly(`not resuming another session from a link so soon — try again in ${Math.ceil(wait / 1000)}s`);
}

/** Is `session` one of agendo's own launcher sessions — the shared one, or a path-scoped one carrying `@cl_root`? */
function isLauncherSession(session: string): boolean {
  return session === LAUNCHER_SESSION || sessionRoot(session) !== null;
}

/**
 * Which tmux session a resume opens the agent in: the one its paused tab sat
 * in; else the launcher session the client is showing; else the shared
 * launcher, if it is up. Never a session of the user's own — `main`, `work` —
 * which an agent window (and its restore tab) would only clutter. Undefined
 * means none of those: the agent gets a detached session of its own, as
 * `agendo resume` gives it.
 */
function resumeHost(c: FocusCandidate, client: TmuxClient | null): string | undefined {
  if (c.host) return c.host;
  if (client && isLauncherSession(client.session)) return client.session;
  return hasSession(LAUNCHER_SESSION) ? LAUNCHER_SESSION : undefined;
}

/** Resume the chosen session in `host` (see `resumeHost`) and return its window's target. */
async function resumeChosen(c: FocusCandidate, all: AgentSession[], host: string | undefined): Promise<string> {
  const r = await resumeSession(c.s, all, host);
  if ("peer" in r) {
    failLoudly(`session ${shortId(c.s.id)} is running outside agendo (pid ${r.peer.pid}); there is no window to focus`, 2);
  }
  if (!r.plan.alreadyRunning) {
    recordLaunchedSession(
      { id: c.s.id, cwd: c.s.cwd, title: c.s.title, source: c.s.source, configDir: c.s.configDir },
      r.plan.tmuxName,
      host ?? LAUNCHER_SESSION,
    );
    console.error(`focus: resumed session ${shortId(c.s.id)} (was ${c.state})`);
  }
  return runningTarget(c.s, all) ?? exactTarget(r.plan.tmuxName);
}

/**
 * Make sure the chosen session has a window — resuming it if needed — and return
 * that window's target. Only a real resume is throttled: a running session whose
 * window the fresh scan missed goes through `resumeSession` too, but that only
 * navigates, and must not spend a link's resume.
 */
async function bringUp(c: FocusCandidate, all: AgentSession[], client: TmuxClient | null, origin: FocusOrigin): Promise<string> {
  const running = c.state === "running" ? runningTarget(c.s, all) : null;
  if (running) return running;
  if (c.state !== "running") throttleUrlResume(origin);
  return resumeChosen(c, all, resumeHost(c, client));
}

/** No client to move: open the configured terminal on the session, showing the session's window, or fail. */
function withoutClient(where: WindowIdentity, target: string, template: string | null): never {
  selectWindow(where, paneOf(target));
  if (template && openTerminal(template, where.session)) {
    console.log(`focus: no tmux client attached; opened a terminal on ${where.session}`);
    process.exit(0);
  }
  failLoudly(NO_CLIENT);
}

/** The pane to focus inside the window, for a session parked in a pane rather than owning a window. */
function paneOf(target: string): string | undefined {
  return target.startsWith("%") ? target : undefined;
}

/** Move `client` onto the window and raise its terminal. */
function switchTo(client: TmuxClient, where: WindowIdentity, target: string, s: AgentSession): never {
  if (!focusClientOn(client.name, where, paneOf(target))) {
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
export async function runFocus(target: FocusTarget, origin: FocusOrigin = { fromUrl: false }): Promise<never> {
  if (!tmuxAvailable()) failLoudly("tmux was not found on PATH");
  const { chosen, all } = await chooseSession(target);
  // Checked BEFORE any resume: with nothing to show it on and no terminal to
  // open, waking an agent would only leave it running unseen.
  const client = pickClient(listClients());
  const template = client ? null : focusTerminalTemplate();
  if (!client && !template) failLoudly(NO_CLIENT);
  const t = await bringUp(chosen, all, client, origin);
  const where = windowIdentity(t) ?? failLoudly(`could not find the tmux window of session ${shortId(chosen.s.id)}`);
  if (!client) withoutClient(where, t, template);
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
  return runFocus(parsed.target, { fromUrl: true });
}
