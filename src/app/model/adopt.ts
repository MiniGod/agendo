// Window adoption: noticing an agent the user started BY HAND in the launcher's
// own tmux session — `ctrl+b c`, `claude`, and off they go — and taking it over
// as a first-class managed session, so it lists, takes `send`, closes, and comes
// back as a paused tab on restore, exactly like a window agendo opened itself.
//
// The whole difficulty is IDENTITY. A hand-typed `claude` gets no `--session-id`;
// it mints its own and only ever tells the disk, after the fact. What it tells
// the disk is claude's per-process record (src/sessions/records.ts): "pid P is
// session S, started in cwd C, sitting in tmux pane %N". That record, keyed by
// the pane id tmux itself reports, is the one statement on the machine that
// ties a pane to a session without inference. The transcript directory the cwd
// maps to is NOT used as the identity source — several transcripts can exist for
// one cwd, and "the newest" or "the one still being appended to" is a guess
// that gets worse with every second session there. The transcript still has a
// vote: the session the record names must exist in the on-disk index, in that
// same cwd, or nothing happens.
//
// THE COST OF A MISTAKE IS ASYMMETRIC, and every rule below is shaped by that.
// An adopted window is one `agendo close` will kill, and it is the user's own
// window with their own work in it; a window we merely fail to adopt costs
// nothing — the user can try again, and the next scan will. So every check
// here declines rather than guesses: two records for one pane, one session
// claimed by two panes, a cwd that does not line up, a session already running
// somewhere else, a pane whose window is not shaped for adoption — all of these
// leave the pane exactly as it was.
//
// Scoped to the launcher's OWN host session. The user's other tmux sessions are
// not agendo's to rename.
//
// ONE WAY AN ADOPTED WINDOW STAYS DIFFERENT. A launched window IS its agent:
// when claude exits the window closes, or falls back to the paused screen. A
// hand-opened window has the user's shell underneath, so when claude exits the
// window stays — under its `cl-claude-<id>` name and tag, which the live scan
// keeps reading as "running" until the user closes it or `agendo close` does.
// Nothing here un-adopts (that would mean a rename back to a name we did not
// keep); the README says so, and a later change can take it up on its own.
import {
  LAUNCHER_WINDOW, adoptWindow, isPlaceholderPane, killPaneById, sessionName, stampPaneTarget,
  type LivePane, type WindowTags,
} from "../../runtime/tmux/index.ts";
import { readClaudeProcessRecords, type ClaudeProcessRecord } from "../../sessions/records.ts";
import { normalizeCwd } from "../context.ts";
import type { AgentSession } from "../../shared/types.ts";

/**
 * How a pane is taken over, if at all.
 *
 * `window`: the pane IS its window — an unmanaged window with nothing else in
 * it — so the window is renamed to the canonical `cl-claude-<id>` and tagged,
 * and from then on it is indistinguishable from a launched tab: id-bearing,
 * `@cl_acquired = adopted`, captured into the restore snapshot.
 *
 * `pane`: the pane shares its window with something else — the launcher menu
 * (a `claude` split beside it, exactly how the global orchestrator lives), a
 * managed window the user split by hand, or an unmanaged window with a shell
 * still in the other half. The WINDOW belongs to that something else, so it is
 * neither renamed nor tagged; the pane alone is stamped `@cl_pane_target`, the
 * same route the global orchestrator takes, and `close` will `kill-pane` it
 * rather than take the window down. A pane-hosted session is not captured into
 * the restore snapshot, as the orchestrator is not.
 *
 * `null`: never. The menu's own pane, and the menu window when nothing else is
 * in it; a restore placeholder (while it idles no record names it, and once
 * woken it is a single-pane managed window, so the flag only saves proving
 * that); a dead pane; a pane already stamped; and a MANAGED window with a single pane,
 * whose name and tag already say what runs in it. That last one is deliberate:
 * an agent that exited and was replaced by a hand-typed `claude` in the same
 * window would be a re-tag of a window agendo launched, and re-stamping a live
 * launched window is exactly what `openTarget` refuses to do. Left alone here,
 * for a later change to argue for on its own.
 */
export type AdoptionShape = "window" | "pane";

export function adoptionShape(pane: LivePane, host: string, panesInWindow: number, selfPane?: string): AdoptionShape | null {
  if (pane.session !== host || pane.dead || pane.placeholder || pane.paneTarget || pane.paneId === selfPane) return null;
  // The menu window alone holds the menu; only a pane split beside it can be a
  // hand-run claude — and that is the shape the global orchestrator has.
  if (pane.window === LAUNCHER_WINDOW) return panesInWindow > 1 ? "pane" : null;
  if (pane.window.startsWith("cl-")) return panesInWindow > 1 ? "pane" : null;
  return panesInWindow > 1 ? "pane" : "window";
}

/** One take-over the scan has decided on, and the session it rests on. */
export interface AdoptionPlan {
  shape: AdoptionShape;
  paneId: string;
  /** The canonical managed name (`cl-claude-<shortId>`). */
  name: string;
  session: AgentSession;
  /**
   * The pane of a PAUSED restore tab for this session in the host — an idle
   * placeholder window named `name`, left by a restart — which has to be
   * retired before the take-over, or the host ends up with two windows under
   * one canonical name and `close` and `send` reach the idle one. The resume
   * path kills and rebuilds its placeholder for the same reason
   * (`refreshPlaceholder`); adoption kills it and lets the hand-opened pane be
   * the session's one home. Found in THIS host's own listing, never by name
   * across the server: a paused tab for the same session in another launcher's
   * host is that launcher's to keep, and does not block adoption here. Held as
   * a pane id so the kill cannot land on anything else — in particular not on
   * the hand-opened window once it carries the same name.
   */
  placeholderPane?: string;
}

export interface AdoptionInputs {
  /** The launcher's own host session; nothing outside it is touched. */
  host: string;
  panes: LivePane[];
  records: ClaudeProcessRecord[];
  sessions: AgentSession[];
  /** Canonical names already running — a session live elsewhere is never adopted twice. */
  live: ReadonlySet<string>;
  /** The pane this agendo runs in (`$TMUX_PANE`), which is never a candidate. */
  selfPane?: string;
}

/**
 * Pane count per window, keyed by `session\twindowIndex` — the INDEX, because
 * the name is not a window's identity: tmux's automatic-rename calls every
 * hand-opened window after its foreground command, so two `ctrl+b c` + `claude`
 * windows are both named `claude`, and a count by name would read each as a
 * split window and demote both to pane adoption.
 */
function paneCounts(panes: LivePane[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of panes) {
    const key = windowKey(p);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function windowKey(p: LivePane): string {
  return `${p.session}\t${p.windowIndex}`;
}

/**
 * Whether any pane in the host session is even shaped for adoption — the gate
 * that keeps the records read off the path a host of nothing but the menu and
 * launched windows takes. A host that also holds a plain shell tab answers true
 * (a shell is exactly what a hand-opened window looks like before `claude` is
 * typed into it), and pays one directory read per scan for it.
 */
export function hasAdoptionCandidate(host: string, panes: LivePane[], selfPane?: string): boolean {
  const counts = paneCounts(panes);
  return panes.some((p) => adoptionShape(p, host, counts.get(windowKey(p)) ?? 1, selfPane) !== null);
}

/**
 * The one record naming this pane, or undefined when none or SEVERAL do. Two
 * live claudes claiming one pane (a nested `claude` started from inside another's
 * shell tool) is an ambiguity, not a tie to break. The record's own session name
 * must match the host too: pane ids are unique per tmux SERVER, not per machine,
 * and a record written under another socket could carry the same `%N`.
 */
function recordForPane(pane: LivePane, host: string, records: ClaudeProcessRecord[]): ClaudeProcessRecord | undefined {
  const hits = records.filter((r) => r.tmux?.pane === pane.paneId && r.tmux.session === host);
  if (hits.length !== 1) return undefined;
  const rec = hits[0];
  return normalizeCwd(rec.cwd) === normalizeCwd(pane.cwd) ? rec : undefined;
}

/**
 * The on-disk session a record names, provided it exists — as a CLAUDE session,
 * under the exact id, in the directory the pane is in. A record whose session
 * has not reached the disk yet (no prompt sent) is left for a later scan; there
 * is nothing to attribute, list or resume until it has.
 */
function sessionForRecord(rec: ClaudeProcessRecord, cwd: string, sessions: AgentSession[]): AgentSession | undefined {
  const s = sessions.find((x) => x.source === "claude" && x.id === rec.sessionId);
  return s && normalizeCwd(s.cwd) === normalizeCwd(cwd) ? s : undefined;
}

/**
 * Decide which panes of the host session to take over, and how. Pure: the
 * listing, the records and the index come in, a list of plans goes out, and
 * `adoptForeignPanes` applies them. Every rule in the file header is applied
 * here, in one pass over the panes.
 *
 * A session is planned at most once per pass. Two panes whose records BOTH
 * pass `recordForPane` and name the same session — which claude should never
 * write, but which a copied record could — are both skipped rather than either
 * being trusted. A record that fails that filter (another host, a cwd that
 * does not line up) is not a claim at all and does not block the one that
 * passes: the mismatched record is the bogus one.
 */
export function planAdoptions(inp: AdoptionInputs): AdoptionPlan[] {
  const counts = paneCounts(inp.panes);
  const claimed = new Map<string, number>();
  for (const p of inp.panes) {
    const rec = recordForPane(p, inp.host, inp.records);
    if (rec) claimed.set(rec.sessionId, (claimed.get(rec.sessionId) ?? 0) + 1);
  }
  const plans: AdoptionPlan[] = [];
  for (const p of inp.panes) {
    const shape = adoptionShape(p, inp.host, counts.get(windowKey(p)) ?? 1, inp.selfPane);
    if (!shape) continue;
    const rec = recordForPane(p, inp.host, inp.records);
    if (!rec || claimed.get(rec.sessionId) !== 1) continue;
    const session = sessionForRecord(rec, p.cwd, inp.sessions);
    if (!session) continue;
    const name = sessionName(session);
    const take = takeover(inp, name, counts);
    if (!take) continue;
    plans.push({ shape, paneId: p.paneId, name, session, ...take });
  }
  return plans;
}

/**
 * Whether `name` is free to be taken over at all, and if so what has to go
 * first. `undefined` when the session is already running somewhere — nothing is
 * adopted twice. Otherwise the host's paused restore tab for that name, if
 * there is one, as the pane to retire; but when the user has SPLIT that tab's
 * window, killing the one flagged pane would leave the window alive under the
 * canonical name beside the adopted one — the very state the retirement exists
 * to prevent — so the adoption is declined instead, and the next scan tries
 * again once the split is gone. Every destructive target stays a single pane.
 */
function takeover(
  inp: AdoptionInputs,
  name: string,
  counts: Map<string, number>,
): Pick<AdoptionPlan, "placeholderPane"> | undefined {
  if (inp.live.has(name)) return undefined;
  const paused = inp.panes.find((q) => q.placeholder && q.session === inp.host && q.window === name);
  if (!paused) return {};
  return counts.get(windowKey(paused)) === 1 ? { placeholderPane: paused.paneId } : undefined;
}

/** The tag an adopted window is stamped with — `adopted`, never `launched`. */
export function adoptedTags(session: AgentSession): WindowTags {
  return { sessionId: session.id, source: session.source, branch: session.branch, acquired: "adopted" };
}

/**
 * Kill the paused placeholder for the plan's session, if the plan found one
 * and it still IS one. Both the check and the kill address the placeholder's
 * PANE id — never its name, which is the one the hand-opened window is about to
 * receive, and which a bare tmux target would match by PREFIX: a kill by name
 * could take a different window, a live agent's included. The flag is re-read
 * on that very pane at kill time: between the listing and here the user could
 * have woken the tab into a real agent, and then the session is running there,
 * not in the pane we were about to adopt — so the take-over is declined rather
 * than the agent killed.
 */
function retirePlaceholder(plan: AdoptionPlan): boolean {
  if (!plan.placeholderPane) return true;
  if (!isPlaceholderPane(plan.placeholderPane)) return false;
  killPaneById(plan.placeholderPane);
  return true;
}

/**
 * Apply one plan to the tmux server and report whether it took — fully: a
 * window counts only once it is both tagged AND renamed, since until the rename
 * lands the `cl-*`-keyed listing cannot see it and the next scan will plan it
 * again (see `adoptWindow`). A paused tab for the same session goes first (see
 * `AdoptionPlan.placeholderPane`). Then a window is tagged and renamed; a pane
 * is stamped with its managed name. The pane id is the target for both — tmux
 * resolves `%N` to its window for the window commands, and it is the one handle
 * that cannot bind to a neighbour. That resolution happens at write time, so a
 * pane the user `join-pane`s into another window between the listing and here
 * would carry the writes to that window; the gap is one directory read wide
 * and needs a deliberate action inside it, and is accepted as the same
 * time-of-check gap the placeholder kill already documents.
 */
function applyAdoption(plan: AdoptionPlan): boolean {
  if (!retirePlaceholder(plan)) return false;
  if (plan.shape === "pane") return stampPaneTarget(plan.paneId, plan.name);
  return adoptWindow(plan.paneId, plan.name, adoptedTags(plan.session)).renamed;
}

/**
 * The adoption pass the live scan runs: look at every pane of the host session,
 * adopt what can be identified with confidence, and say whether anything was
 * actually taken over — so the caller knows to re-read the server, since the
 * listing it holds predates the renames.
 *
 * No tmux round trip of its own: the pane listing is the one the scan already
 * ran. The registry is read only when some pane is shaped for adoption at all
 * (`hasAdoptionCandidate`) — never for a host of nothing but the menu and
 * launched windows, once per scan for a host that also keeps a shell tab open.
 */
export async function adoptForeignPanes(
  host: string,
  panes: LivePane[],
  sessions: AgentSession[],
  live: ReadonlySet<string>,
): Promise<boolean> {
  const selfPane = process.env.TMUX_PANE;
  if (!hasAdoptionCandidate(host, panes, selfPane)) return false;
  const records = await readClaudeProcessRecords();
  const plans = planAdoptions({ host, panes, records, sessions, live, selfPane });
  return plans.map(applyAdoption).some(Boolean);
}
