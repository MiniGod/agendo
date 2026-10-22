// The shortcut `agendo focus` and `agendo url` try first: answer from the
// sessions that have a live tmux window, without the full session index or the
// whole backend model.
//
// The full lookup parses every Claude transcript on the machine (seconds, with a
// few hundred of them) and then loads the model: identity, every work item, every
// PR, CI status. A button in a browser cannot wait for that, and the common case
// does not need it — the session a link names is usually running, and a running
// session has a window. So this reads the live windows (one `list-panes`), parses
// only the transcripts those windows name, and asks the backend for the ONE
// entity the link numbers, in parallel.
//
// It answers only when that is the answer the full lookup would give: a session
// linked to the entity that is RUNNING. `pickSession` prefers a running session
// outright, so the full lookup's other candidates (paused, idle) could never win
// against it. Whenever this cannot be sure it returns null and the caller takes
// the full path, which is also the only path that ever resumes anything:
//
//   • a live window that names no session — neither a `@cl_session_id` tag nor
//     an id in its name (`cl-wi-…`, `cl-pr-…`, a fresh Codex window). The full
//     index credits such a window to the most recently used session with its
//     cwd, wherever that session's transcript is filed; only the full index can
//     say which, and the answer decides what is running.
//   • a backend with no shortcut (GitHub), or an entity it will not vouch the
//     model lists (see `Provider.fetchFocusTarget`).
//   • a repo given by id that is not this entity's (see `liveLinked`).
//   • nothing linked is running.
import { ID_BEARING_NAME, livePanes, liveTargets, managedFromPanes, shortId, type LivePane, type ManagedTarget } from "../../runtime/tmux/index.ts";
import { orphanPrsOf, withSessions } from "../../app/model/join.ts";
import { getProvider, type Provider } from "../../providers/index.ts";
import { SessionIndex, type TranscriptFilter } from "../../sessions/index.ts";
import type { AgentSession, FocusEntity, Identity } from "../../shared/types.ts";
import { currentModelOptions } from "../links.ts";
import { tokenNames } from "../commands/resume.ts";
import { refreshLiveTmux } from "../../app/model/index.ts";
import { sessionsForToken } from "./windowName.ts";
import { isRepoGuid, linkedMatches, narrowToRepo, resolveLinked, type LinkedModel } from "./linked.ts";
import type { FocusTarget } from "./url.ts";

type ItemTarget = Exclude<FocusTarget, { kind: "session" }>;

/**
 * What the shortcut found: the sessions the target could mean, the narrowed
 * index they came from, and the pane listing their live state is to be read
 * from (see `recheck`).
 */
export interface LiveLookup {
  sessions: AgentSession[];
  index: SessionIndex;
  panes: LivePane[];
}

/** The session a live window names by tag or by name, as a short id; undefined for an id-less window. */
function namedShortId(t: ManagedTarget): string | undefined {
  if (t.tags?.sessionId) return shortId(t.tags.sessionId);
  return ID_BEARING_NAME.exec(t.name)?.[1];
}

/**
 * The short ids of the sessions the live windows name. A placeholder is not
 * running, so it adds nothing, and an id-less one does not decline. Null when a
 * live window names no session (see the header). `names` are every name tmux
 * lists: one whose pane reports no cwd is missing from `managed` yet still
 * counts as running, so an id such a name carries is admitted too. A name a
 * managed window carries is that window's to answer for — a placeholder's must
 * not admit its transcript, as dozens of parked tabs would cost a parse each.
 */
export function liveIds(managed: ManagedTarget[], names: string[]): Set<string> | null {
  const ids = new Set<string>();
  const windowNames = new Set(managed.map((t) => t.name));
  for (const name of names) {
    const id = windowNames.has(name) ? undefined : ID_BEARING_NAME.exec(name)?.[1];
    if (id) ids.add(id);
  }
  for (const t of managed) {
    if (t.placeholder) continue;
    const id = namedShortId(t);
    if (!id) return null;
    ids.add(id);
  }
  return ids;
}

/** The Claude transcripts of the sessions `ids` names, and of any `also` admits by id. */
export function narrowTo(ids: Set<string>, also: (sessionId: string) => boolean = () => false): TranscriptFilter {
  return (_dir, sessionId) => ids.has(shortId(sessionId)) || also(sessionId);
}

/**
 * Does an index narrowed to `before` still cover what the live windows name
 * `now`? Not when they name a session it skipped — one started since would be
 * running, yet missing from it — nor when a window names none.
 */
export function stillCovers(before: Set<string>, now: Set<string> | null): boolean {
  return now !== null && [...now].every((id) => before.has(id));
}

interface Snapshot {
  panes: LivePane[];
  ids: Set<string>;
}

/** One read of the live windows and the sessions they name, or null when they cannot be narrowed to. */
function snapshot(): Snapshot | null {
  const panes = livePanes();
  const ids = liveIds(managedFromPanes(panes), [...liveTargets().keys()]);
  return ids && { panes, ids };
}

/**
 * The live windows read again, after the backend round-trips — as the full
 * path reads them after its own — so a window that closed or fell back to a
 * placeholder meanwhile is seen as such. Null, sending the caller to the full
 * path, unless the index narrowed by `before` still covers them.
 */
function recheck(before: Snapshot): LivePane[] | null {
  const now = snapshot();
  return now && stillCovers(before.ids, now.ids) ? now.panes : null;
}

/** The index narrowed to what `snap` names, and to what `also` admits. */
function narrowedIndex(snap: Snapshot, also?: (sessionId: string) => boolean): Promise<SessionIndex> {
  return SessionIndex.build(narrowTo(snap.ids, also));
}

/** The model's PR / work-item lists as they would hold just this entity, its sessions joined on. */
function entityModel(e: FocusEntity, index: SessionIndex, scopeToRepo: boolean): LinkedModel {
  const empty = { linkedPrs: [], orphanPrs: [], reviewPrs: [], current: [], other: [], prLinked: [] };
  if ("pr" in e) return { ...empty, orphanPrs: orphanPrsOf(index, [e.pr], new Set()) };
  return { ...empty, current: [withSessions(index, scopeToRepo, e.item)] };
}

/**
 * The entity, looked up for the identity the model would load for (the
 * persisted one, else the signed-in user) — asked for alongside it, not after.
 */
async function fetchEntity(provider: Provider, persisted: Identity | null, target: ItemTarget): Promise<FocusEntity | null> {
  if (!provider.fetchFocusTarget) return null;
  const identity = persisted ? Promise.resolve(persisted) : provider.getMe();
  // Handled where it is awaited; this only keeps a failure that lands before then from counting as unhandled.
  identity.catch(() => {});
  return provider.fetchFocusTarget(target.kind, target.id, identity);
}

/**
 * The sessions linked to a PR / work item, from the narrowed index — or null
 * when that cannot settle it. A repo given by id narrows only when it is THIS
 * entity's repo: the full lookup judges an id against every PR in the model,
 * which a single entity cannot stand in for.
 */
async function liveLinked(target: ItemTarget): Promise<LiveLookup | null> {
  const opts = currentModelOptions();
  const provider = getProvider(opts.provider);
  const snap = provider.fetchFocusTarget ? snapshot() : null;
  if (!snap) return null;
  const [entity, index] = await Promise.all([
    fetchEntity(provider, opts.identity, target).catch(() => null),
    narrowedIndex(snap),
  ]);
  const panes = entity && recheck(snap);
  if (!entity || !panes) return null;
  const matches = linkedMatches(entityModel(entity, index, opts.provider === "github"), target);
  const repo = target.repo;
  if (repo && isRepoGuid(repo) && !matches.some((m) => m.repoId?.toLowerCase() === repo.toLowerCase())) return null;
  const r = resolveLinked(repo ? narrowToRepo(matches, repo) : matches);
  return "sessions" in r ? { sessions: r.sessions, index, panes } : null;
}

/**
 * The sessions a session token names (see `sessionsForToken`), from the
 * narrowed index, which also admits what an id names. A window name is
 * attributed from the same fresh listing the caller judges running by. Every
 * live window here names its session, so that attribution is by tag or name
 * alone, as on the full path. Null when nothing is found.
 */
async function liveNamed(token: string): Promise<LiveLookup | null> {
  const snap = snapshot();
  if (!snap) return null;
  const index = await narrowedIndex(snap, tokenNames(token));
  const panes = recheck(snap);
  if (!panes) return null;
  const sessions = sessionsForToken(index.all, token, () => refreshLiveTmux(index.all, panes).liveWindows);
  return sessions.length ? { sessions, index, panes } : null;
}

/**
 * What `target` could mean, looked up from the live windows only (see the
 * header). The caller still keeps only the RUNNING sessions, and takes the
 * full path when none is.
 */
export function liveLookup(target: FocusTarget): Promise<LiveLookup | null> {
  return target.kind === "session" ? liveNamed(target.token) : liveLinked(target);
}
