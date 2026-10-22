// The pinned orchestrator block at the top of the Sessions view.
//
// Every repo in scope shows who coordinates it — running, starting, paused,
// idle, or nobody — and which key starts or opens it. It sits ABOVE the scrolling rows
// rather than among them: an orchestrator is the one session a user comes back
// to over and over, and a row would sink under the first screenful of a long
// list exactly when there is most to coordinate.
//
// Pure: statuses in, lines of styled segments out. `useViewport` reserves
// exactly `lines.length` rows for it, so what renders and what is reserved can
// never disagree.
import { flatTitle, type OrchestratorCandidate, type OrchestratorState, type RepoOrchestratorStatus } from "../../orchestration/repoOrchestrator.ts";

/** One run of text with its style. */
export interface PinSeg {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}
export type PinLine = PinSeg[];

export interface OrchestratorPins {
  /** The scope is ONE repo, so `G` means the same thing as `O` (see scopeRepo.ts). */
  repoScope: boolean;
  lines: PinLine[];
  /**
   * What `K` kills: the repo scope's open extras (`openExtras`), never its
   * primary. Empty over several repos — `K` is offered on the one-repo ⚠ line only.
   */
  killable: OrchestratorCandidate[];
  /** The repo `killable` belongs to, so `K` can re-read who its primary is before killing; null over several. */
  killRoot: string | null;
  /** The repo has no recorded orchestrator, so `killable` are look-alikes, not extras (see `extras`). */
  killLookAlikes: boolean;
  /**
   * Why `K` must not run now, or null. Set while the repo's orchestrator is
   * STARTING: it has no session yet, so nothing can tell its window from a
   * look-alike's in the same checkout (see `primaryNow` in staleKill.ts).
   */
  killBlocked: string | null;
}

/** How many repos with an orchestrator get a line of their own in a multi-repo scope. */
export const MAX_PINNED_REPOS = 3;

/**
 * A repo's orchestrator as the block shows it. `starting` is one launched a
 * moment ago: its window is live, but its agent has written no transcript yet,
 * so the rule has no session to rank — `O` still switches to it (see
 * `pendingOrchestrator`), and the block must not say "start one" meanwhile.
 */
type PinState = OrchestratorState | "starting" | "none";

const GLYPH: Record<PinState, string> = { running: "●", starting: "◌", paused: "⏸", idle: "○", none: "–" };
const COLOR: Record<PinState, string> = { running: "green", starting: "green", paused: "yellow", idle: "gray", none: "gray" };
const RANK: Record<PinState, number> = { running: 0, starting: 1, paused: 2, idle: 3, none: 4 };

/** What pressing the key does to a repo in this state. */
const VERB: Record<PinState, string> = {
  running: "switch to it", starting: "switch to it", paused: "resume it", idle: "resume it", none: "start one",
};

/** One repo, reduced to what the block prints: its state, and what to call its orchestrator. */
interface PinView {
  status: RepoOrchestratorStatus;
  state: PinState;
  /** The orchestrator's title, or its window's name while it is starting; null for none. */
  label: string | null;
  lastUsed: number;
}

/** A session's title as one short line. */
function titleOf(c: OrchestratorCandidate): string {
  return flatTitle(c.session.title);
}

function viewOf(s: RepoOrchestratorStatus, pending: ReadonlyMap<string, string>): PinView {
  if (s.primary) return { status: s, state: s.primary.state, label: titleOf(s.primary), lastUsed: s.primary.session.lastUsed.getTime() };
  const window = pending.get(s.root);
  return { status: s, state: window ? "starting" : "none", label: window ?? null, lastUsed: 0 };
}

function badge(state: PinState): PinSeg {
  return { text: `${GLYPH[state]} ${state}`, color: COLOR[state] };
}

function keyHint(text: string): PinSeg {
  return { text: `  ·  ${text}`, dim: true };
}

/** `agendo-orchestrator (⏸ paused), orch-old (● running)` — what the ⚠ line names. */
export function staleList(stale: readonly OrchestratorCandidate[]): string {
  return stale.map((c) => `${titleOf(c)} (${GLYPH[c.state]} ${c.state})`).join(", ");
}

/**
 * The stale candidates that still have a window — running, or parked as a paused
 * tab. An idle one is a transcript on disk: it coordinates nothing, and `x` has
 * no window to end, so a warning about it could never be acted on or cleared.
 * The primary is filtered out by id as well as by construction, so nothing that
 * reads this can ever reach the session `O`/`G` opens.
 */
export function openExtras(s: RepoOrchestratorStatus): OrchestratorCandidate[] {
  return s.stale.filter((c) => c.state !== "idle" && c.session.id !== s.primary?.session.id);
}

/** Why `K` refuses while the repo's orchestrator is starting (`OrchestratorPins.killBlocked`). */
export const STARTING_BLOCK = "An orchestrator is starting in this repo — press K again once it is up, so it can't be mistaken for one of these.";

/**
 * `2 extra orchestrators` — or, in a repo with no recorded orchestrator,
 * `2 orchestrator look-alikes`, since beside "none" nothing is extra. The one
 * noun the ⚠ line, `K`'s y/n and its notice share.
 */
export function extras(n: number, lookAlikes = false): string {
  return `${n} ${lookAlikes ? "orchestrator look-alike" : "extra orchestrator"}${n === 1 ? "" : "s"}`;
}

/**
 * What the ⚠ line says after the `K` hint: what `O`/`G` opens instead, then the
 * names. `label` is the primary's title — or a starting one's window — and null
 * when the repo has none, in which case the extras are all look-alikes nothing
 * ever recorded.
 */
export function extrasExplained(extrasOpen: readonly OrchestratorCandidate[], label: string | null, lookAlikes: boolean): string {
  const one = extrasOpen.length === 1;
  const these = one ? "not this one" : "not these";
  const opens = label === null ? `so O/G starts a new one, ${these}` : `O/G opens "${label}", ${these}`;
  const never = one ? "never recorded as an orchestrator" : "never recorded as orchestrators";
  const lead = lookAlikes ? `${never}${label === null ? ", " : "; "}` : "";
  return `${lead}${opens}: ${staleList(extrasOpen)}`;
}

/**
 * The block for a scope that IS one repo: one line, plus one more for any open
 * extras — `⚠ 2 extra orchestrators open  ·  K kill them  ·  O/G opens "…", not
 * these: …`. The count and the key come first, short enough for an 80-column
 * terminal, so a narrow one cuts the explanation and the names (the line
 * truncates at its end) and keeps the key.
 */
function repoScopeLines(v: PinView): PinLine[] {
  const head: PinLine = [{ text: "▌ Orchestrator", bold: true, color: "magenta" }, { text: `  ${v.status.name}  ` }, badge(v.state)];
  if (v.label) head.push({ text: `  ${v.label}` });
  head.push(keyHint(`O/G ${VERB[v.state]}`));
  const open = openExtras(v.status);
  if (open.length === 0) return [head];
  return [head, [
    { text: `  ⚠ ${extras(open.length, !v.status.primary)} open`, color: "yellow" },
    // No K while one is starting: `K` refuses then (`STARTING_BLOCK`), so it is not offered.
    ...(v.state === "starting" ? [] : [keyHint(`K kill ${open.length === 1 ? "it" : "them"}`)]),
    { text: `  ·  ${extrasExplained(open, v.label, !v.status.primary)}`, dim: true },
  ]];
}

/** `● 1 running · ⏸ 1 paused · – 3 none`, skipping the states nobody is in. */
function stateCounts(views: readonly PinView[]): string {
  const counts = new Map<PinState, number>();
  for (const v of views) counts.set(v.state, (counts.get(v.state) ?? 0) + 1);
  return (Object.keys(RANK) as PinState[])
    .filter((st) => counts.has(st))
    .map((st) => `${GLYPH[st]} ${counts.get(st)} ${st}`)
    .join(" · ");
}

/** Best state first, then the most recently used orchestrator, then by name. */
function byState(a: PinView, b: PinView): number {
  return RANK[a.state] - RANK[b.state] || b.lastUsed - a.lastUsed || a.status.name.localeCompare(b.status.name);
}

/**
 * `⚠ 2 extra open`, or `⚠ 1 look-alike open` in a repo with nothing recorded:
 * its open extras, for the lines too narrow to name them.
 */
function extrasCount(v: PinView): string | null {
  const n = openExtras(v.status).length;
  if (n === 0) return null;
  return v.status.primary ? `⚠ ${n} extra open` : `⚠ ${n} look-alike${n === 1 ? "" : "s"} open`;
}

function staleMark(v: PinView): string {
  const mark = extrasCount(v);
  return mark ? ` (${mark})` : "";
}

/** One line for a repo that has an orchestrator. */
function repoLine(v: PinView): PinLine {
  const line: PinLine = [{ text: `  ${GLYPH[v.state]} `, color: COLOR[v.state] }, { text: v.status.name, bold: true }, { text: `  ${v.label}`, dim: true }];
  const mark = extrasCount(v);
  if (mark) line.push({ text: `  ${mark}`, color: "yellow" });
  return line;
}

/**
 * The block for a scope over several repos: a count header, a line each for the
 * busiest few, then one line naming every other repo with its state — so each
 * repo in scope is on screen, the overflow just more tersely.
 */
function multiRepoLines(views: readonly PinView[]): PinLine[] {
  const ranked = [...views].sort(byState);
  const withOne = ranked.filter((v) => v.state !== "none");
  const none = ranked.filter((v) => v.state === "none");
  const head: PinLine = [{ text: "▌ Orchestrators", bold: true, color: "magenta" }, { text: `  ${stateCounts(views)}`, dim: true }, keyHint("O start/open")];
  const shown = withOne.slice(0, MAX_PINNED_REPOS);
  const more = withOne.slice(MAX_PINNED_REPOS);
  const tail: string[] = [];
  if (more.length > 0) tail.push(`+${more.length} more: ${more.map((v) => `${v.status.name} ${GLYPH[v.state]}${staleMark(v)}`).join(", ")}`);
  if (none.length > 0) tail.push(`none in: ${none.map((v) => `${v.status.name}${staleMark(v)}`).join(", ")}`);
  const lines = [head, ...shown.map(repoLine)];
  if (tail.length > 0) lines.push([{ text: `  ${tail.join(" · ")}`, dim: true }]);
  return lines;
}

/**
 * The pinned block for the repos in scope, or null when there are none to show.
 * `repoScope` is whether the launcher was pointed at one repo (one status) or at
 * a folder holding several; the two read differently because `G` does.
 * `pending` names, by status root, the window of an orchestrator too new to
 * have a session (see `PinState`).
 */
export function orchestratorPins(
  statuses: readonly RepoOrchestratorStatus[],
  repoScope: boolean,
  pending: ReadonlyMap<string, string> = new Map(),
): OrchestratorPins | null {
  if (statuses.length === 0) return null;
  const views = statuses.map((s) => viewOf(s, pending));
  if (!repoScope) return { repoScope, lines: multiRepoLines(views), killable: [], killRoot: null, killLookAlikes: false, killBlocked: null };
  return {
    repoScope,
    lines: repoScopeLines(views[0]),
    killable: openExtras(statuses[0]),
    killRoot: statuses[0].root,
    killLookAlikes: !statuses[0].primary,
    killBlocked: views[0].state === "starting" ? STARTING_BLOCK : null,
  };
}

/**
 * The block cut to its first `max` lines, for a terminal too short to show it
 * whole (see `pageLayout`); the same object when nothing is cut. `repoScope`
 * stays, so the hint line still says what `G` does.
 */
export function shownPins(pins: OrchestratorPins | null, max: number): OrchestratorPins | null {
  return pins && pins.lines.length > max ? { ...pins, lines: pins.lines.slice(0, max) } : pins;
}

/** The plain text of a line, for tests and for anything that measures it. */
export function pinText(line: PinLine): string {
  return line.map((s) => s.text).join("");
}
