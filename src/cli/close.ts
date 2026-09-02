import { normalizeCwd } from "../context.ts";
import { SELF_CMD } from "../launch.ts";
import { refreshLiveTmux } from "../model.ts";
import { forgetRestoreTab, idBearingName } from "../restore.ts";
import { SessionIndex } from "../sessions.ts";
import type { AgentSession } from "../types.ts";
import {
  exactTarget, isPaneTarget, isPlaceholderWindow, killManagedTarget, killPane, liveManagedPaths,
  liveTargetForShortId, managedKind, paneBackgroundAgents, paneReadiness, readPaneState,
  sessionName, shortId, stripAnsi, windowLocations,
  type LiveTarget, type PaneSnapshot, type Readiness,
} from "../tmux.ts";

/**
 * Why closing this pane would destroy work in flight, phrased for the refusal
 * message — or null when closing it is safe.
 *
 * TWO independent reasons, because readiness answers only half the question.
 * Since #44 it describes the MAIN agent alone, so a session whose subagent is
 * still writing reads "ready" here; closing it is exactly the destructive misread
 * this command exists to prevent. The count is read off the SAME capture as the
 * readiness, so the two can never describe different frames.
 *
 * Deliberately NOT routed through `sessionFinished`, which pairs the same two
 * facts for `wait` and the stall verdict: those treat "queued" and "dialog" as
 * done, and this command must refuse both. Same inputs, different question.
 */
export function unsafeCloseReason(readiness: Readiness, agents: number): string | null {
  if (UNSAFE_CLOSE_STATES.has(readiness)) return `session looks "${readiness}"`;
  if (agents > 0) return `session is idle but ${agents} background agent${agents === 1 ? " is" : "s are"} still running`;
  return null;
}

/**
 * Refuse the close, with the pane's own last lines as evidence, when the session
 * still has work in flight. Exits; returns only when closing is safe.
 *
 * Its own function rather than a branch in `runClose`: the count is a second,
 * independent reason to refuse (#44), and folding it inline pushed `runClose`
 * past its complexity budget. Everything it needs is already read — no extra
 * tmux call — and lifting it out let that budget DROP rather than rise.
 */
function refuseIfWorkInFlight(pane: PaneSnapshot | null, readiness: Readiness | null, force: boolean): void {
  if (!pane || !readiness || force) return;
  const refusal = unsafeCloseReason(readiness, paneBackgroundAgents(pane.raw));
  if (!refusal) return;
  console.error(`Not closing: ${refusal} — work is in flight. Pass --force to close it anyway.`);
  console.error(`\n  current screen (tail):`);
  for (const l of stripAnsi(pane.raw).split("\n").filter((x) => x.trim()).slice(-12)) console.error(`    ${l}`);
  process.exit(2);
}

/**
 * Readiness states where closing a session would destroy work in flight, so
 * `close` refuses them without `--force` (mirroring how `send` refuses to type
 * into a non-ready pane): a turn being generated ("busy"), a conversation being
 * rewritten ("compacting"), text typed but not yet submitted ("queued"), or an
 * open question waiting on an answer ("dialog").
 *
 * The states NOT listed are deliberately closeable: "ready" (idle, the finished
 * session this command exists for), "limited" (stuck at its usage cap — a prime
 * close candidate) and "unknown". "unknown" is what a pane whose agent already
 * exited looks like — a bare shell prompt with no input box — which is the most
 * obvious thing of all to want closed; refusing it would push callers straight
 * back to hand-rolled `tmux kill-window`, the failure this command replaces.
 *
 * Close-specific, so it stays here rather than in wait.ts beside that command's
 * own BUSY_STATES: the two overlap today but answer different questions ("is it
 * still working?" vs "would ending it lose something?"), and `close` refuses two
 * settled-but-unsaved states that `wait` considers done. Declared before the
 * subcommand dispatch so the hoisted `runClose` never reads it in the temporal
 * dead zone.
 */
const UNSAFE_CLOSE_STATES = new Set<Readiness>(["busy", "compacting", "queued", "dialog"]);

/**
 * How to address the target for BOTH the pane read and the kill, so neither
 * falls back to tmux's current-session lookup.
 *
 * Two shapes, and telling them apart is the whole job. A session hosted in a
 * PANE of somebody else's window (the global orchestrator, beside the menu) owns
 * no window and no session, so `windowLocations` reports nothing for it and
 * `killManagedTarget` can place it nowhere — this command would refuse to close
 * the one thing it can plainly see running, and `--force` would fail too. Its
 * pane id is the handle, and it is unambiguous by construction, so the
 * duplicate-window guard below has nothing to guard. `kill-pane` is also the
 * only correct kill: the window belongs to the menu, not to this session.
 *
 * Otherwise the name resolves to window locations. tmux allows duplicate window
 * names and this launcher produces them — a global and a path-scoped launcher
 * can each hold a tab for the same session — so more than one means we cannot
 * tell which window the caller meant. Reading the wrong one is harmless; killing
 * it is not. No location at all means the target is a tmux session of its own
 * (an agent launched outside tmux).
 */
function closeAddress(name: string, live: LiveTarget | null | undefined): {
  readTarget: string;
  locations: string[];
  location: string | null;
  kill: () => { how: "window" | "session" | "moved" | "none" | "pane"; gone: boolean };
} {
  if (live && isPaneTarget(live.target)) {
    const pane = live.target;
    return { readTarget: pane, locations: [], location: null, kill: () => ({ how: "pane", gone: killPane(pane, name) }) };
  }
  const locations = windowLocations(name);
  const location = locations[0] ?? null;
  return {
    readTarget: exactTarget(location ?? name),
    locations,
    location,
    kill: () => killManagedTarget(name, location),
  };
}

/**
 * End a running session: kill the tmux target it lives in — a window in a host
 * session, or the whole session when the agent was launched outside tmux — and
 * nothing else.
 *
 * WHAT IT DOES NOT TOUCH — this is a guarantee of the command, not a hope. The
 * only writes are the tmux kill itself and, when the window was a launcher tab,
 * dropping that one tab from the launcher's restore snapshot. Nothing under a
 * worktree is read, moved or removed: the worktree, its branch and every commit
 * in it survive, and the session's transcript stays on disk so `agendo resume
 * <id>` restarts it.
 *
 * The guards, in order, because a mistargeted kill in this environment can take
 * out someone's live agent — including the launcher itself:
 *  1. RESOLUTION. The id resolves exactly as it does for `status`/`send`/`resume`
 *     (full id, short id, or a `cl-…-<id>` tmux name), then the session's live
 *     window comes from `refreshLiveTmux` — the same reconciliation the menu and
 *     `wait` use — so a session running under a `cl-wi-…`/`cl-pr-…` window is
 *     found rather than missed. A session too new to have a transcript falls back
 *     to its id-bearing window (as `runStatus` does), since `agendo launch`
 *     prints an id well before the agent writes its log — otherwise the flow this
 *     command exists for (launch → it goes wrong → close) couldn't close it.
 *     An id that resolves to neither kills nothing.
 *  2. MANAGED-ONLY. The target must be a managed `cl-…` name (`managedKind`).
 *     That already holds by construction — `liveWindows` is built only from
 *     managed windows — so the check is defense in depth: if that ever stops
 *     holding, a typo must abort rather than kill the user's own shell or the
 *     launcher window.
 *  3. UNAMBIGUOUS ATTRIBUTION. A `cl-wi-…`/`cl-pr-…` window embeds an ITEM id,
 *     not a session id, so it is attributed to the most-recently-used session in
 *     its working directory. That heuristic is fine for reading a pane; for a
 *     kill it is not, because when two sessions share a directory the newest wins
 *     the attribution while the OTHER may be the agent actually running there.
 *     So an id-less window with rival sessions in its dir needs `--force`.
 *  4. WORK IN FLIGHT. A pane mid-turn (or compacting, or holding queued text /
 *     an open question) is refused unless `force` — killing an agent mid-write
 *     is how work gets lost. See UNSAFE_CLOSE_STATES. Since #44 that is only
 *     half the test: a session whose SUBAGENT is still running reads "ready",
 *     so the count is refused on separately (see `unsafeCloseReason`).
 *     A pane that could not be
 *     READ is refused too: readiness classifies a blank screen as "unknown",
 *     which this guard lets through, so a failed read would pass for an idle
 *     session (see `readPaneState`).
 *
 * Both the readiness READ and the kill address a window through its
 * `session:index` location rather than by name (see `killManagedTarget`): a bare
 * window name resolves only inside the caller's current session, so from outside
 * tmux the read would come back empty — classifying "unknown", which guard 4
 * treats as closeable — while the kill quietly hit nothing. Two further checks
 * bound what a location can mean: more than one live window may carry the same
 * name (two launchers, one session), which is refused rather than guessed; and
 * the name at the location is re-read immediately before the kill, since tmux
 * renumbers windows when one closes. Finally, because every tmux write here is
 * fire-and-forget, the target is confirmed gone before success is reported.
 *
 * A dormant restore placeholder (an idle bash tab that was never opened) is
 * closeable too, and skips the readiness read: there's no agent in it to lose.
 */
export async function runClose(token: string | undefined, force: boolean, verb = "close"): Promise<void> {
  if (!token) usageExit(verb);
  const found = await findSession(token);
  const { liveWindows, livePlaceholders } = refreshLiveTmux(found.index.all);
  const { live, canon } = liveHandle(found.s, found.sid, liveWindows);
  if (!canon) refuseNoSession(token);
  const { placeholder, target } = closeTargetOf(live, canon, livePlaceholders);
  if (!target) return reportNotRunning(found);
  refuseUnmanaged(target);
  refuseSharedDir(target, found, force);
  const addr = closeAddress(target, live);
  refuseManyWindows(addr.locations, target, found.label, force);
  // One pane read serves both the verdict and, if we refuse, the screen tail that
  // explains it — the same shape `send` uses when it declines.
  const pane = placeholder ? null : readPaneState(addr.readTarget);
  refuseUnread(pane, placeholder, force, target, addr.readTarget);
  const readiness = pane ? paneReadiness(pane.raw, pane.cursor) : null;
  refuseIfWorkInFlight(pane, readiness, force);
  killOrReport(addr, target);
  tidyHost(addr.location, canon, placeholder);
  reportClosed(target, found, placeholder, readiness);
}

type CloseAddress = ReturnType<typeof closeAddress>;

/** What the close token resolved to, and the label the messages call it by. */
interface FoundSession {
  s: AgentSession | undefined;
  /** The short id the token names, whether or not a session answers to it. */
  sid: string;
  label: string;
  index: SessionIndex;
}

export function usageExit(verb: string): never {
  console.error(`usage: ${SELF_CMD} ${verb} <id> [--force]`);
  process.exit(1);
}

export function refuseNoSession(token: string): never {
  console.error(`No session found for "${token}" — refusing to close anything.`);
  process.exit(1);
}

/** Guard 1, first half: the id resolves exactly as it does for `status`/`send`/`resume`. */
async function findSession(token: string): Promise<FoundSession> {
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const index = await SessionIndex.build();
  const s = index.all.find((x) => x.id === token || shortId(x.id) === sid);
  return { s, sid, label: s ? shortId(s.id) : sid, index };
}

/**
 * Guard 1, second half. For a known session: whatever window it's live in,
 * under its canonical name. For one too new to be indexed: the live id-bearing
 * target named after this very short id — which is only ever that session's
 * own, so it's as safe a target as the canonical name.
 *
 * The resolved target is KEPT, not rebuilt from the name. A pane-hosted session
 * has no window of that name, so re-deriving `{name, target: name}` would send
 * `closeAddress` down the window branch and leave the one thing we can plainly
 * see running uncloseable — refused on the read, and "can no longer place it in
 * any session" even under --force. `send` and `unblock` reach it by this same
 * handle; close has no reason to be the odd one out.
 */
export function liveHandle(
  s: AgentSession | undefined,
  sid: string,
  liveWindows: ReadonlyMap<string, LiveTarget>,
): { live: LiveTarget | null | undefined; canon: string | null } {
  const live = s ? liveWindows.get(sessionName(s)) : liveTargetForShortId(sid);
  const canon = s ? sessionName(s) : (live?.name ?? null);
  return { live, canon };
}

/**
 * The tmux name to close, if anything is there to close. A placeholder squats
 * the canonical name with no agent behind it; close it by that name (it's a
 * real tmux window) when no live window vouches for the session.
 */
export function closeTargetOf(
  live: LiveTarget | null | undefined,
  canon: string,
  livePlaceholders: ReadonlySet<string>,
): { placeholder: boolean; target: string | undefined } {
  const placeholder = !live && livePlaceholders.has(canon);
  const target = live?.name ?? (placeholder ? canon : undefined);
  return { placeholder, target };
}

/**
 * Already closed / never started. The desired end state holds, so this is a
 * success — `close` is idempotent for the scripts and agents driving it. The
 * caller may have expected a live session here, though; an indexed one can
 * still be brought back (an unindexed id has nothing to resume).
 */
export function reportNotRunning(found: Pick<FoundSession, "s" | "label">): void {
  console.log(`○ session ${found.label} is not running — nothing to close.`);
  if (found.s) console.log(`  resume:  ${SELF_CMD} resume ${found.label}   (its worktree, branch and commits are intact)`);
}

/** Guard 2. */
export function refuseUnmanaged(target: string): void {
  if (managedKind(target)) return;
  console.error(`Refusing to close "${target}": not a managed agendo window.`);
  process.exit(1);
}

/**
 * Guard 3: an id-less window is attributed by working directory, so it only
 * names one session unambiguously when it's the only session in that dir.
 */
function refuseSharedDir(target: string, found: Pick<FoundSession, "index" | "label">, force: boolean): void {
  if (idBearingName(target) || force) return;
  const cwd = liveManagedPaths().find((p) => p.name === target)?.cwd;
  const rivals = cwd ? found.index.all.filter((x) => normalizeCwd(x.cwd) === normalizeCwd(cwd)) : [];
  if (rivals.length <= 1) return;
  console.error(
    `Not closing: window ${target} carries no session id, and ${rivals.length} sessions share ` +
      `its directory (${cwd}) — the one running in it may not be ${found.label}. Candidates: ` +
      `${rivals.map((x) => shortId(x.id)).join(", ")}. Pass --force to close that window anyway.`,
  );
  process.exit(2);
}

/** More than one live window carries the name: refused rather than guessed (see `closeAddress`). */
export function refuseManyWindows(locations: readonly string[], target: string, label: string, force: boolean): void {
  if (locations.length <= 1 || force) return;
  console.error(
    `Not closing: ${locations.length} live windows are named ${target} (${locations.join(", ")}) — ` +
      `agendo can't tell which one is ${label}. Close the one you mean from its launcher, or pass --force.`,
  );
  process.exit(2);
}

/**
 * A read that FAILED is not evidence of an idle session. `paneReadiness` turns
 * an empty screen into "unknown", which guard 4 lets through — so a tmux read
 * that never landed (busy server, pane gone between the listing and here) would
 * silently disarm the only check standing between `close` and a mid-turn agent.
 * `wait` distrusts a single missed read for the same reason (EXIT_CONFIRM_TICKS);
 * this command is the destructive one, so it refuses outright.
 */
export function refuseUnread(pane: PaneSnapshot | null, placeholder: boolean, force: boolean, target: string, readTarget: string): void {
  if (placeholder || pane || force) return;
  console.error(
    `Not closing: tmux could not read ${target}'s pane (${readTarget}), so agendo can't tell whether ` +
      `work is in flight. Re-run to try again, or pass --force to close it unread.`,
  );
  process.exit(2);
}

/**
 * Why the kill did not happen, or null when it did. `how === "none"` means tmux
 * listed the target a moment ago but can now place it in neither a window nor a
 * session — so nothing was killed, whatever the (vacuously true) `gone` check
 * says. Report the failure rather than the reassuring lie; the caller can look
 * and re-run.
 */
export function killFailure(how: ReturnType<CloseAddress["kill"]>["how"], gone: boolean, target: string, location: string | null): string | null {
  if (gone && how !== "none") return null;
  if (how === "moved") {
    return `Not closing ${target}: the window at ${location} is no longer it (tmux renumbered while we looked). Nothing was killed — re-run to pick it up at its new index.`;
  }
  return `Could not close ${target}: tmux ${how === "none" ? "can no longer place it in any session" : "still reports it live"}. Nothing else was changed.`;
}

function killOrReport(addr: CloseAddress, target: string): void {
  const { how, gone } = addr.kill();
  const failure = killFailure(how, gone, target, addr.location);
  if (!failure) return;
  console.error(failure);
  process.exit(1);
}

/**
 * Tidy the host session the window we just killed lived in — a standalone
 * agent session (launched outside tmux) was never a tab in one, and gets
 * nothing here.
 *
 * A dormant placeholder can carry the canonical name alongside the real window
 * we just killed — reconcileLive drops it from `livePlaceholders` in exactly
 * that case (a real window vouched for the name), so ask tmux directly rather
 * than trust the reconciled set. Without this the closed session is still
 * sitting in the tab strip as an unopened tab.
 *
 * Scoped to that one host session, and flag-checked inside it: the same
 * canonical name can be tabbed in a SECOND launcher (which is why
 * `isPlaceholderWindow` reads the flag per host), and that launcher's strip is
 * none of this command's business — we don't edit its restore snapshot either,
 * so killing its tab would only make it reappear there on its next start. The
 * tab is dropped from the restore snapshot of that one host for the same reason.
 */
function tidyHost(location: string | null, canon: string, placeholder: boolean): void {
  const host = location?.split(":")[0];
  if (!host) return;
  if (!placeholder && isPlaceholderWindow(host, canon)) killLeftoverPlaceholder(host, canon);
  forgetRestoreTab(canon, host);
}

function killLeftoverPlaceholder(host: string, canon: string): void {
  const leftover = windowLocations(canon).find((l) => l.startsWith(`${host}:`));
  if (leftover) killManagedTarget(canon, leftover);
}

/** What the closed line says the target was, when it was not simply idle. */
export function closedSuffix(placeholder: boolean, readiness: Readiness | null): string {
  if (placeholder) return " (unopened restore tab)";
  return readiness && readiness !== "ready" ? ` (was "${readiness}")` : "";
}

/**
 * Only an indexed session can be resumed by id — one whose transcript hasn't
 * landed yet has nothing for `resume` to find (that's why it took the
 * window-name path to get here in the first place).
 */
export function reportClosed(target: string, found: Pick<FoundSession, "s" | "label">, placeholder: boolean, readiness: Readiness | null): void {
  console.log(`▸ closed ${target}${closedSuffix(placeholder, readiness)}`);
  console.log(`  kept:    worktree, branch and commits are untouched${found.s ? ` in ${found.s.cwd}` : ""}`);
  if (found.s) console.log(`  resume:  ${SELF_CMD} resume ${found.label}`);
}
