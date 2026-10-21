import { sessionRepo } from "../format/index.ts";
import { ID_BEARING_NAME, sessionName, shortId } from "../../runtime/tmux/index.ts";
import type { LiveInfo } from "./tmuxMeta.ts";
import type { AgentSession, LinkedPR, PRWithSessions, PullRequest, ReviewPRWithSessions, WorkItem } from "../../shared/types.ts";

// Subsequence fuzzy match: every (non-space) character of the query must appear
// in `text`, in order, but not necessarily contiguously. Case-insensitive.
//
// Both sides are normalised to NFC first, because the two sides genuinely
// arrive in different forms: a branch or directory name read off a macOS
// filesystem is NFD (`o` + U+0308), while the same name typed at the prompt or
// returned by the ADO/GitHub APIs is NFC (U+00F6). Comparing those code unit by
// code unit, a user searching for "Þróun" matches nothing. Normalising AFTER
// `toLowerCase` rather than before is deliberate — case folding is itself
// allowed to emit decomposed output, so it has to be the input to the
// normalisation, not the other way round.
function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase().normalize("NFC").replace(/\s+/g, "");
  if (!q) return true;
  const t = text.toLowerCase().normalize("NFC");
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Does a session match the Sessions-view search query? Matches against the
// fields a user would search by: title, repo and branch.
export function sessionMatches(s: AgentSession, query: string): boolean {
  return fuzzyMatch(query, `${s.title} ${sessionRepo(s)} ${s.branch ?? ""}`);
}

// Does a work item match the search query? Matches against id (with and without
// the leading #), title, type, state and board column. The model carries no
// description / acceptance criteria, so those are not searchable.
export function itemMatches(it: WorkItem, query: string): boolean {
  return fuzzyMatch(query, `#${it.id} ${it.title} ${it.type} ${it.state} ${it.boardColumn ?? ""}`);
}

// Does a PR match the search query? Matches against id (with and without the
// leading !), title, branch and repo, plus the linked work item title / review
// reason when present (those vary by which section the PR came from).
export function prMatches(pr: PullRequest, query: string): boolean {
  const p = pr as Partial<LinkedPR> & Partial<ReviewPRWithSessions>;
  const extra = [p.workItemTitle, p.reviewReason].filter(Boolean).join(" ");
  return fuzzyMatch(query, `!${pr.id} ${pr.title} ${pr.branch} ${pr.repositoryName ?? ""} ${extra}`);
}

// ── ranked search: exact ids first ─────────────────────────────────────────────
// The fuzzy match above is a SUBSEQUENCE match over one joined string, so a PR
// id query is matched digit by digit across the id, title, branch and repo:
// `81656` also matches `!81654 … User Story 247306` (`8165` from the id, the `6`
// from the title). Those extra hits stay — they are what fuzzy search is for —
// but a row whose id the query names EXACTLY must come first, and the rows are
// otherwise date-sorted, which put the exact hit wherever its date fell.
//
// Session identity is matched separately and never fuzzily: a uuid is hex, and
// a subsequence match on hex matches nearly anything.
//
// A rank is the strength of a row's best match, lower first; null is no match.
export type Rank = number | null;
export const RANK_EXACT = 0;
export const RANK_ID_PREFIX = 1;
export const RANK_FUZZY = 2;

/**
 * Shortest id prefix (alphanumerics only, so dashes don't count) that may match
 * a session. Shorter queries — a PR number, a word — would hit sessions whose id
 * merely starts with them. Claude and Copilot ids are random (uuid v4), so six
 * characters already single one out; Codex ids are time-ordered (uuid v7), so
 * sessions started hours apart share their first six — a short Codex prefix
 * matches all of them, and its 12-character short id (the whole millisecond
 * timestamp) is what tells them apart.
 */
export const MIN_ID_PREFIX = 6;

/**
 * The query, parsed once per row build rather than once per row: the rankers
 * run on every keystroke, over every PR, work item and session.
 */
export interface ParsedQuery {
  text: string;
  /** Lower-cased and trimmed — the form ids are compared in. An id has no
   *  spaces, so a query with one inside is never taken for an id. */
  id: string;
  /** The digits of a numeric id query (`81656`, `!81656`, `#81656`). */
  digits: string | null;
  /** An id-bearing window name (`cl-<kind>-<short>`): its kind and id part. */
  named: { kind: string; part: string } | null;
  /** The alphanumerics of an id-shaped query, else null (a word with spaces, `!123`). */
  compact: string | null;
}

const compact = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, "");

export function parseQuery(text: string): ParsedQuery {
  const id = text.trim().toLowerCase();
  // ID_BEARING_NAME is the one definition of an id-bearing name (shared with
  // attribution); the kind is the segment between `cl-` and the id.
  const part = ID_BEARING_NAME.exec(id)?.[1];
  return {
    text,
    id,
    digits: /^[!#]?(\d+)$/.exec(id)?.[1] ?? null,
    named: part ? { kind: id.slice(3, id.length - part.length - 1), part } : null,
    compact: /^[a-z0-9-]+$/.test(id) ? compact(id) : null,
  };
}

function best(...ranks: Rank[]): Rank {
  const hits = ranks.filter((r): r is number => r !== null);
  return hits.length ? Math.min(...hits) : null;
}

/** How `id` matches the alphanumeric part of a query: whole, a long enough prefix, or not at all. */
function idPartRank(id: string, part: string): Rank {
  if (part === id) return RANK_EXACT;
  return part.length >= MIN_ID_PREFIX && id.startsWith(part) ? RANK_ID_PREFIX : null;
}

/** Whether an id-bearing name of this kind can name a session of `source`. Codex
 *  background / new windows are always minted id-LESS (see `kindName`'s tag). */
function kindFits(kind: string, source: AgentSession["source"]): boolean {
  if (kind === "bg" || kind === "new") return source !== "codex";
  return kind === source;
}

/**
 * How a query matches a session's IDENTITY: its full id (the agent's own uuid),
 * agendo's 12-character short id, or a tmux window name. `names` are the
 * session's canonical `cl-<source>-<short>` and the name of the live window it
 * actually runs in (which may be id-less: `cl-pr-…`, `cl-wi-…`, `cl-bg-codex-…`);
 * any id-bearing name (`cl-bg-<short>`, `cl-new-<short>`) is matched by its id
 * part, so a window that has since closed still finds its session. A prefix of
 * the id, bare or inside an id-bearing name, matches below an exact hit.
 */
export function sessionIdRank(s: AgentSession, q: ParsedQuery, names: string[]): Rank {
  if (!q.id) return null;
  if (names.some((n) => n.toLowerCase() === q.id)) return RANK_EXACT;
  const short = compact(shortId(s.id));
  if (q.named) return kindFits(q.named.kind, s.source) ? idPartRank(short, q.named.part) : null;
  if (q.compact === null) return null;
  return best(idPartRank(compact(s.id), q.compact), idPartRank(short, q.compact));
}

/** What the rankers need beyond the row: the parsed query, the path scope, and
 *  each session's window names. */
export interface SearchContext {
  query: ParsedQuery;
  inScope: (cwd: string) => boolean;
  /** Canonical name first, then the live window's name when it has one. A
   *  session attributed from two windows is reachable by the one reconcileLive
   *  kept (`liveWindows` holds one window per session). */
  namesOf: (s: AgentSession) => string[];
}

export function searchContext(live: LiveInfo, inScope: (cwd: string) => boolean, query: string): SearchContext {
  const namesOf = (s: AgentSession) => {
    const canon = sessionName(s);
    const window = live.windows.get(canon)?.name;
    return window && window !== canon ? [canon, window] : [canon];
  };
  return { query: parseQuery(query), inScope, namesOf };
}

/** The best identity match among the in-scope sessions a row carries (the ones it shows). */
function sessionsRank(sessions: AgentSession[], ctx: SearchContext): Rank {
  return best(...sessions.filter((s) => ctx.inScope(s.cwd)).map((s) => sessionIdRank(s, ctx.query, ctx.namesOf(s))));
}

export function sessionRank(s: AgentSession, ctx: SearchContext): Rank {
  return best(sessionIdRank(s, ctx.query, ctx.namesOf(s)), sessionMatches(s, ctx.query.text) ? RANK_FUZZY : null);
}

export function itemRank(it: WorkItem, ctx: SearchContext): Rank {
  const exact = ctx.query.digits === String(it.id) ? RANK_EXACT : null;
  return best(exact, sessionsRank(it.sessions, ctx), itemMatches(it, ctx.query.text) ? RANK_FUZZY : null);
}

export function prRank(pr: PRWithSessions, ctx: SearchContext): Rank {
  const exact = ctx.query.digits === String(pr.id) ? RANK_EXACT : null;
  return best(exact, sessionsRank(pr.sessions, ctx), prMatches(pr, ctx.query.text) ? RANK_FUZZY : null);
}

/** The first occurrence of each key, in order. */
export function uniqueBy<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => !seen.has(key(t)) && !!seen.add(key(t)));
}

/** The rows that match, strongest rank first; rows of equal rank keep their incoming order (sort is stable). */
export function rankMatches<T>(list: T[], rank: (t: T) => Rank): T[] {
  return list
    .map((t) => ({ t, r: rank(t) }))
    .filter((x): x is { t: T; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.t);
}
