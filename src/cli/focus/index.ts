// `agendo focus` — bring the session for a PR, a work item or an id to the front
// of the terminal the human is using — and `agendo url`, the agendo:// scheme
// handler that is its browser-facing door.
//
// Runs OUTSIDE tmux when a browser starts it, so it never assumes a current
// client. A link moves a client already showing the tmux session the target's
// window is (or will be) in, else the attached client with the latest input.
// The latest-input client is usually the one the human is busy in; a client
// already on the target's session is the one meant to show it. `focus` typed
// by hand moves the client with the latest input: the terminal it was typed in.
// It only ever focuses, or resumes and then focuses, a session that already
// exists. It never launches a new one, sends to one or closes one — a URL that
// any web page can trigger must not be able to do more than change what is on
// screen.
import {
  LAUNCHER_SESSION, exactTarget, focusClientOn, hasSession, listClients, liveTargetForShortId, pickClient, pickClientFor, selectWindow,
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
import { describeLinkTarget, describeTarget, parseFocusUrl, type FocusTarget } from "./url.ts";
import { launcherForCwd, parseFocusArgs, pickSession, type FocusCandidate } from "./choose.ts";
import { linkedMatches, narrowToLinkRepo, resolveLinked } from "./linked.ts";
import { failLoudly, notify, onNotify } from "./notify.ts";
import { raiseTerminal } from "./raise.ts";
import { focusTerminalTemplate, openTerminal } from "./terminal.ts";
import { URL_FOCUS_GAP_MS, claimRefusalNote, claimUrlFocus, claimUrlResume } from "./throttle.ts";

/** A link leaves alone a client typed into this recently: the human is busy in it, not clicking a button. */
export const TYPING_GRACE_S = 3;

const NO_CLIENT = "no tmux client is attached — open a terminal and run `tmux attach` first";

/** Where a focus came from: a link may resume only so often (see throttle.ts). */
export interface FocusOrigin {
  fromUrl: boolean;
}

/** The model the PR / work-item lookup runs against, or a loud failure — with load warnings flushed first, since they may be why. */
async function loadFocusModel(label: string): Promise<Awaited<ReturnType<typeof loadModel>>> {
  try {
    const model = await loadModel(currentModelOptions());
    flushWarnings("focus");
    return model;
  } catch (e) {
    flushWarnings("focus");
    failLoudly(`could not look up ${label}: ${(e as Error)?.message ?? String(e)}`);
  }
}

/** The sessions a PR / work item links to — refused when the number names more than one of them (see linked.ts). */
async function linkedSessions(target: Exclude<FocusTarget, { kind: "session" }>, label: string): Promise<AgentSession[]> {
  const model = await loadFocusModel(label);
  const matches = linkedMatches(model, target);
  const r = resolveLinked(target.repo ? narrowToLinkRepo(model, matches, target.repo) : matches);
  if ("sessions" in r) return r.sessions;
  return failLoudly(`${label} is ambiguous — it matches ${r.ambiguous.join(" and ")}; name the repo (\`focus --repo <repo>\`) or the session (\`focus <session-id>\`)`);
}

/** Every session the target could mean. */
async function candidates(target: FocusTarget, label: string, index: SessionIndex): Promise<AgentSession[]> {
  if (target.kind !== "session") return linkedSessions(target, label);
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
  if (!origin.fromUrl) return;
  const claim = claimUrlResume();
  if ("error" in claim) failLoudly(floorBroken(claim.error));
  if ("waitMs" in claim) failLoudly(`not resuming another session from a link so soon — try again in ${Math.ceil(claim.waitMs / 1000)}s`);
}

/** Why links are refused when their floor cannot be recorded. */
function floorBroken(error: string): string {
  return `agendo:// links are refused: agendo cannot record their use in its state dir (${error})`;
}

/** Is `session` one of agendo's own launcher sessions — the shared one, or a path-scoped one carrying `@cl_root`? */
function isLauncherSession(session: string): boolean {
  return session === LAUNCHER_SESSION || sessionRoot(session) !== null;
}

/**
 * Which tmux session a resume opens the agent in: the one its paused tab sat
 * in; else the path-scoped launcher for its directory that a client is
 * showing; else the launcher session the most recently active client is
 * showing; else the shared launcher, if it is up. Never a session of the
 * user's own — `main`, `work` — which an agent window (and its restore tab)
 * would only clutter. Undefined means none of those: the agent gets a detached
 * session of its own, as `agendo resume` gives it.
 */
function resumeHost(c: FocusCandidate, clients: TmuxClient[]): string | undefined {
  if (c.host) return c.host;
  const own = repoLauncher(c.s.cwd, clients);
  if (own) return own;
  const client = pickClient(clients);
  if (client && isLauncherSession(client.session)) return client.session;
  return hasSession(LAUNCHER_SESSION) ? LAUNCHER_SESSION : undefined;
}

/** The path-scoped launcher holding `cwd` among the sessions clients are showing (see `launcherForCwd`). */
function repoLauncher(cwd: string, clients: TmuxClient[]): string | undefined {
  const shown = [...new Set(clients.map((c) => c.session))];
  return launcherForCwd(cwd, shown.map((session) => ({ session, root: sessionRoot(session) })));
}

/** The session's window, and — when focus had to resume it — what to tell the human if the rest then fails. */
interface Brought {
  target: string;
  resumed: string | null;
}

/** Record a session focus just resumed as `tmuxName` for restore, and say so; returns what to tell the human if the rest then fails. */
function recordResumed(c: FocusCandidate, tmuxName: string, host: string | undefined): string {
  recordLaunchedSession(
    { id: c.s.id, cwd: c.s.cwd, title: c.s.title, source: c.s.source, configDir: c.s.configDir },
    tmuxName,
    host ?? LAUNCHER_SESSION,
  );
  console.error(`focus: resumed session ${shortId(c.s.id)} (was ${c.state})`);
  return `session ${shortId(c.s.id)} WAS resumed and is running in tmux window ${tmuxName}`;
}

/** Resume the chosen session in `host` (see `resumeHost`) and return its window. */
async function resumeChosen(c: FocusCandidate, all: AgentSession[], host: string | undefined): Promise<Brought> {
  const r = await resumeSession(c.s, all, host === undefined ? { detached: true } : { host });
  if ("peer" in r) {
    failLoudly(`session ${shortId(c.s.id)} is running outside agendo (pid ${r.peer.pid}); there is no window to focus`, 2);
  }
  // A cold resume knows exactly what it created; anything else was found running.
  const target = r.plan.target ?? runningTarget(c.s, all) ?? exactTarget(r.plan.tmuxName);
  const resumed = r.plan.alreadyRunning ? null : recordResumed(c, r.plan.tmuxName, host);
  return { target, resumed };
}

/** Where the chosen session will be on screen, worked out before anything is resumed. */
interface Landing {
  /** A running session's window, freshly read; null when it has to be resumed. */
  running: string | null;
  /** The tmux session that window is in — or a resume will open it in; undefined for a detached session of its own. */
  session: string | undefined;
}

/** Where `c` is, or where a resume will put it (see `resumeHost`). */
function landing(c: FocusCandidate, all: AgentSession[], clients: TmuxClient[]): Landing {
  const running = c.state === "running" ? runningTarget(c.s, all) : null;
  if (running) return { running, session: windowIdentity(running)?.session };
  return { running: null, session: resumeHost(c, clients) };
}

/**
 * Make sure the chosen session has a window — resuming it if needed — and return
 * that window's target. Everything past a running session's own window goes
 * through the link's resume floor — including a "running" session whose window
 * has vanished since the scan, which `resumeSession` would cold-start.
 */
async function bringUp(c: FocusCandidate, all: AgentSession[], land: Landing, origin: FocusOrigin): Promise<Brought> {
  if (land.running) return { target: land.running, resumed: null };
  throttleUrlResume(origin);
  return resumeChosen(c, all, land.session);
}

/** Fail, saying so when the session was resumed on the way: it is running, and the human should know where. */
type Fail = (text: string) => never;

/** No client to move: open the configured terminal on the session, showing the session's window, or fail. */
function withoutClient(where: WindowIdentity, target: string, template: string | null, fail: Fail): never {
  selectWindow(where, paneOf(target));
  if (template && openTerminal(template, where.session)) {
    console.log(`focus: no tmux client attached; opened a terminal on ${where.session}`);
    process.exit(0);
  }
  fail(template ? `could not start the focusTerminal command (${template})` : NO_CLIENT);
}

/** The pane to focus inside the window, for a session parked in a pane rather than owning a window. */
function paneOf(target: string): string | undefined {
  return target.startsWith("%") ? target : undefined;
}

/** The client a focus moves, and whether to raise its terminal too. */
interface Mover {
  client: TmuxClient;
  raise: boolean;
}

/**
 * For a link, the client to move, chosen again now the window exists: a resume
 * takes seconds, may have landed somewhere other than foreseen, and the human
 * may have started typing in the client, or detached it, meanwhile. The typing
 * guard is applied once more, to the client chosen now.
 *
 * Its terminal is NOT raised while another terminal is being typed in: raising
 * takes keyboard focus, and a page firing links on a timer would otherwise
 * steer keystrokes meant for that terminal into the agent's prompt. The switch
 * itself still happens. `focus` typed by hand moves the client it was given.
 */
function finalClient(client: TmuxClient, where: WindowIdentity, up: Brought, fail: Fail, origin: FocusOrigin): Mover {
  if (!origin.fromUrl) return { client, raise: true };
  const clients = listClients();
  const now = pickClientFor(clients, where.session);
  if (!now) return refuseLink(`${client.name} detached`, null, up, fail);
  const why = typingIn(now);
  if (why) return refuseLink(why, now, up, fail);
  return { client: now, raise: !clients.some((c) => c.name !== now.name && typingIn(c)) };
}

/**
 * Refuse a link past its first check. Said like the first check (`ignoreLink`)
 * — unless the agent was resumed on the way, which the human must hear about,
 * and where.
 */
function refuseLink(why: string, typist: TmuxClient | null, up: Brought, fail: Fail): never {
  if (up.resumed) fail(`not switching: ${why}`);
  ignoreLink(why, typist);
}

/**
 * Drop a link and exit 1. A refusal for typing is NOTIFIED, naming the tmux
 * session typed in but nothing from the link: the human clicked a button and
 * saw nothing happen, and should know why. A link fired on a timer cannot turn
 * that into a burst — the focus floor lets one link through per
 * URL_FOCUS_GAP_MS.
 */
function ignoreLink(why: string, typist: TmuxClient | null): never {
  console.error(`url: ignored — ${why}`);
  // Through the refusal-note floor too: links refused by the focus floor while
  // this one was still working may already have said something. (The onNotify
  // hook then claims it again and finds it taken — harmless.)
  if (typist && "go" in claimRefusalNote()) notify(`ignored — you were typing in ${typist.session}`);
  process.exit(1);
}

/** Move the client chosen for the window onto it and raise that client's terminal (see `finalClient`). */
function switchTo(chosen: TmuxClient, where: WindowIdentity, up: Brought, s: AgentSession, fail: Fail, origin: FocusOrigin): never {
  const { client, raise } = finalClient(chosen, where, up, fail, origin);
  const target = up.target;
  if (!focusClientOn(client.name, where, paneOf(target))) {
    fail(`tmux could not switch ${client.name} to session ${shortId(s.id)}`);
  }
  if (raise) raiseTerminal(client.pid);
  console.log(`focused session ${shortId(s.id)} (window ${where.windowId} in ${where.session}) on ${client.name}`);
  process.exit(0);
}

/**
 * Refuse a link when the client it would move was typed into within
 * `TYPING_GRACE_S`. A human who clicked a browser button is not typing in that
 * terminal at that moment; a page firing links on a timer would otherwise land
 * their keystrokes in an agent's prompt mid-sentence. Only the client chosen
 * is checked: typing in another terminal is no reason to leave this one alone.
 */
function leaveTypistAlone(client: TmuxClient): void {
  const why = typingIn(client);
  if (why) ignoreLink(why, client);
}

/** Why `client` counts as being typed in, or null when it does not. */
function typingIn(client: TmuxClient, nowS = Date.now() / 1000): string | null {
  if (nowS - client.activity >= TYPING_GRACE_S) return null;
  return `${client.name} was typed into ${Math.max(0, Math.round(nowS - client.activity))}s ago`;
}

/**
 * The client to move, or — with none attached — the configured terminal to
 * open. Checked BEFORE any resume: with nothing to show it on and no terminal
 * to open, waking an agent would only leave it running unseen.
 */
function clientOrTerminal(
  clients: TmuxClient[], session: string | undefined, origin: FocusOrigin,
): { client: TmuxClient; template: null } | { client: null; template: string } {
  // A link moves the terminal meant to show the target; `focus` typed by hand,
  // the terminal it was typed in — the one with the latest input.
  const client = origin.fromUrl ? pickClientFor(clients, session) : pickClient(clients);
  if (client) {
    if (origin.fromUrl) leaveTypistAlone(client);
    return { client, template: null };
  }
  const template = focusTerminalTemplate();
  return template ? { client: null, template } : failLoudly(NO_CLIENT);
}

/**
 * The session to focus, its candidates' states read live; fails when there is
 * none. A link's failures name its target by `describeLinkTarget` only.
 */
async function chooseSession(target: FocusTarget, origin: FocusOrigin): Promise<{ chosen: FocusCandidate; all: AgentSession[] }> {
  const label = origin.fromUrl ? describeLinkTarget(target) : describeTarget(target);
  const index = await SessionIndex.build();
  const found = withStates(await candidates(target, label, index), index.all);
  const chosen = pickSession(found);
  if (!chosen) failLoudly(`No agendo session for ${label}`);
  reportChoice(chosen, found, target);
  return { chosen, all: index.all };
}

/** Focus what `target` names; see the header. Always exits. */
export async function runFocus(target: FocusTarget, origin: FocusOrigin = { fromUrl: false }): Promise<never> {
  if (!tmuxAvailable()) failLoudly("tmux was not found on PATH");
  const { chosen, all } = await chooseSession(target, origin);
  const clients = listClients();
  const land = landing(chosen, all, clients);
  const { client, template } = clientOrTerminal(clients, land.session, origin);
  const up = await bringUp(chosen, all, land, origin);
  const fail: Fail = (text) => failLoudly(up.resumed ? `${text} — ${up.resumed}` : text);
  const where = windowIdentity(up.target) ?? fail(`could not find the tmux window of session ${shortId(chosen.s.id)}`);
  if (!client) withoutClient(where, up.target, template, fail);
  switchTo(client, where, up, chosen.s, fail, origin);
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
  // Claimed before the link is even read: a burst of MALFORMED links must not
  // become a burst of refusal notifications either.
  const claim = claimUrlFocus();
  if ("error" in claim) failLoudly(floorBroken(claim.error));
  if ("waitMs" in claim) {
    // Notified, but at most once per gap: a page firing links in a burst must not fire a burst of notifications.
    console.error(`url: ignored — another agendo:// link was handled less than ${URL_FOCUS_GAP_MS / 1000}s ago`);
    if ("go" in claimRefusalNote()) notify("ignored a link — another one was handled moments ago");
    process.exit(1);
  }
  // Whatever this link goes on to say counts against the refusal-note floor, so
  // links refused behind it add nothing to it. Its failures are not gated — a
  // real failure is always shown — but its own typing refusal goes through the
  // same floor (`ignoreLink`; see throttle.ts).
  onNotify(() => void claimRefusalNote());
  const parsed = argv.length === 1 ? parseFocusUrl(argv[0]) : { ok: false as const, reason: "expected exactly one URL" };
  if (!parsed.ok) {
    console.error(`url: refused ${JSON.stringify((argv[0] ?? "").slice(0, 200))}`);
    failLoudly(`refused an agendo:// link: ${parsed.reason}`);
  }
  console.error(`url: ${describeTarget(parsed.target)}`);
  return runFocus(parsed.target, { fromUrl: true });
}
