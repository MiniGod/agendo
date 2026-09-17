// `agendo list` / `ls` — the managed sessions running right now, as a table or
// as JSON.
//
// `branchSync` is injected for the same reason it is in ./status.ts: this
// module must not appear on any import path that the rescan timer can reach.

import { basename } from "path";
import {
  capturePaneState, liveManagedPaths, managedKind,
  paneBackgroundAgents, paneReadiness, paneResumeDialogActive, paneShells, sessionName,
  shortId, type ManagedTarget, type SessionKind,
} from "../../runtime/tmux/index.ts";
import { SessionIndex } from "../../sessions/index.ts";
import { idleSeconds, isStalled, resolveStalledAfterMs } from "../../sessions/idle.ts";
import { resolveWindowSession } from "../../runtime/restore/index.ts";
import { scopeFilter, scopeNote, type SessionScope } from "../../app/scope.ts";
import { loadModel, refreshLiveTmux, type LoadedModel } from "../../app/model/index.ts";
import { orchestratorRoles, type OrchestratorRole } from "../../orchestration/index.ts";
import { printJson } from "../output.ts";
import type { AgentSession, BranchSyncReader } from "../../shared/types.ts";
import { workflowStatus } from "../../orchestration/workflows.ts";
import { flushWarnings } from "../warnings.ts";
import { padCell, readyCell, readyWidth, rowCompactionPercent, rowResetAt, timeAgo } from "./cells.ts";
import { currentModelOptions } from "../links.ts";
import { STALLED_MARK } from "../glyphs.ts";
import { listRow, type ListRow, type ListRowContext } from "./rows.ts";
import {
  KIND_COL, printOrchestratorSummary, roleLabel, withRememberedOrchestrators,
  type OrchestratorSummaryRow,
} from "./orchestrators.ts";

export interface ListOptions {
  /** Injected reader for a checkout's local-vs-tracked state (see the header). */
  readBranchSync: BranchSyncReader;
  /** Emit JSON instead of a human table. */
  json: boolean;
  /** Also include idle (not-running) sessions. */
  all: boolean;
  /** Only sessions linked to this PR id (implies the enriched, model-backed path). */
  pr?: number;
  /** Only sessions linked to this work-item / issue id (enriched path). */
  item?: number;
  /** Scope to sessions by cwd (`[dir]`/`--path`) and/or repo (`--repo`); null = all. */
  scope: SessionScope | null;
  /** `--stalled-after` override, in ms; falls back to config (see src/sessions/idle.ts). */
  stalledAfterMs?: number;
}

/** One session as reported by the enriched (`--json` / `--all` / query) list. */
/**
 * The model behind the enriched listing. Associations come from its reverse
 * index. A query MUST have it (the whole point); the other enriched modes
 * degrade gracefully if the backend is unreachable — we still list sessions,
 * just without PR/work-item links.
 */
async function loadListModel(isQuery: boolean): Promise<LoadedModel | null> {
  try {
    return await loadModel(currentModelOptions());
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (isQuery) {
      console.error(`list: could not resolve associations from the backend: ${msg}`);
      process.exit(1);
    }
    console.error(`list: continuing without PR/work-item associations (${msg})`);
    return null;
  }
}

/**
 * The sessions a `--pr` / `--issue` query names, resolved against the model's
 * FORWARD associations (the same lists the TUI shows), NOT `sessionLinks` —
 * that reverse index keeps only one PR + one work item per session, so a
 * session on a PR linked to two items (or a branch matching two PRs) would be
 * missed. Deduped by source:id across lists.
 */
export function querySessions(m: LoadedModel, pr: number | undefined, item: number | undefined): AgentSession[] {
  const matched = new Map<string, AgentSession>();
  const take = (sessions: AgentSession[]) => {
    for (const s of sessions) matched.set(`${s.source}:${s.id}`, s);
  };
  for (const p of [...m.linkedPrs, ...m.orphanPrs, ...m.reviewPrs]) if (p.id === pr) take(p.sessions);
  for (const it of [...m.current, ...m.other, ...m.prLinked]) if (it.id === item) take(it.sessions);
  return [...matched.values()];
}

/** Which sessions the enriched listing covers: the query's, all on disk, or the live ones. */
function selectSessions(opts: ListOptions, index: SessionIndex, live: Set<string>, model: LoadedModel | null): AgentSession[] {
  // `model` is guaranteed for a query: a failed load already exited.
  if (model && (opts.pr !== undefined || opts.item !== undefined)) return querySessions(model, opts.pr, opts.item);
  if (opts.all) return [...index.all];
  return index.all.filter((s) => live.has(sessionName(s)));
}

// Same third-state glyph the plain list's `pausedRow` uses, so `--all` in text
// form doesn't collapse a paused session back down to the same `○` an idle one
// gets — `r.state` already carries the distinction, `tableLine` just has to read it.
const STATE_GLYPH: Record<ListRow["state"], string> = { running: "●", paused: "⏸", idle: "○" };

/** One line of the enriched table. */
function tableLine(r: ListRow, ready: string): string {
  const wfRunning = r.workflows.filter((w) => w.status === "running").length;
  return [
    STATE_GLYPH[r.state],
    ready,
    roleLabel(r.role, r.kind).padEnd(KIND_COL),
    r.shortId.padEnd(12),
    timeAgo(new Date(r.lastUsed)).padEnd(8),
    padCell(r.dir, 20),
    (r.pr ? `!${r.pr.id}` : "-").padEnd(6),
    (r.workItem ? `#${r.workItem.id}` : "-").padEnd(6),
    r.title.slice(0, 44) +
      (r.stalled ? `  ${STALLED_MARK}` : "") +
      (r.shells > 0 ? `  ⛁${r.shells}` : "") +
      (wfRunning > 0 ? `  ◆${wfRunning}` : ""),
  ].join("  ").trimEnd();
}

/** The enriched table, or the line that says why there is none. */
function printListTable(rows: ListRow[], isQuery: boolean, itemLabel: string, scope: SessionScope | null): void {
  if (rows.length === 0) {
    // Name the scope when there is one: an empty listing under a `--repo` typo
    // otherwise reads as "nothing is running" rather than "nothing matched".
    const where = scopeNote(scope);
    console.log(
      isQuery
        ? `No sessions linked to that item${where} (query covers open PRs / work items in the current identity's scope).`
        : `No sessions${where}.`,
    );
    return;
  }
  const ready = rows.map((r) =>
    readyCell(r.readiness, r.limitResetAt === null ? null : Date.parse(r.limitResetAt), r.compactionPercent),
  );
  const rw = readyWidth(ready);
  console.log(
    ["", "ready".padEnd(rw), "kind".padEnd(KIND_COL), "id".padEnd(12), "age".padEnd(8), "dir".padEnd(20), "pr".padEnd(6), itemLabel.padEnd(6), "title"].join("  "),
  );
  for (const [i, r] of rows.entries()) console.log(tableLine(r, ready[i].padEnd(rw)));
  // Same summary the plain list prints, from the same rows the table just used —
  // so `--all` reports a repo as unmanaged on exactly the sessions it showed.
  printOrchestratorSummary(
    rows.map((r) => ({ shortId: r.shortId, cwd: r.cwd, role: r.role, running: r.running })),
  );
}

/**
 * List sessions. The default (no flags) is unchanged: the live `cl-…` tmux
 * targets, one per line, resolved back to their session and reported with
 * readiness/kind/id/dir/title — fast and needing no backend auth. The `--json`,
 * `--all`/`--include-idle`, and `--pr`/`--issue`/`--work-item` query flags opt
 * into the enriched path, which loads the model so each row carries its branch
 * and linked PR / work item (via `sessionLinks`) and can include idle sessions.
 * An optional scope narrows every mode — plain, enriched and `--json` alike — to
 * the sessions under a path and/or in a repo.
 */
export async function runList(opts: ListOptions): Promise<void> {
  const index = await SessionIndex.build();
  const thresholdMs = resolveStalledAfterMs(opts.stalledAfterMs);
  const inScope = scopeFilter(opts.scope);
  const enriched = opts.json || opts.all || opts.pr !== undefined || opts.item !== undefined;
  // The threshold is resolved ONCE, above the mode split, and passed down: every
  // row in every mode is judged against the same number, and the scope filter
  // only decides which rows are printed — never what any of them says.
  //
  // Resolving it read config.json, so drain any complaint about that file before
  // the plain path returns — it never reaches the flush below, and a silently
  // ignored `stalledAfterMinutes` would show up only as a marker that doesn't
  // match what the user configured.
  if (!enriched) {
    flushWarnings("list");
    return runPlainList(index, inScope, thresholdMs);
  }

  const isQuery = opts.pr !== undefined || opts.item !== undefined;
  const model = await loadListModel(isQuery);
  flushWarnings("list");

  const { live, liveKinds, liveWindows, livePlaceholders } = refreshLiveTmux(index.all);
  const ctx: ListRowContext = {
    live, liveKinds, liveWindows, livePlaceholders,
    roles: orchestratorRoles(),
    linkOf: (s) => model?.sessionLinks.get(`${s.source}:${s.id}`),
    thresholdMs,
    readBranchSync: opts.json ? opts.readBranchSync : null,
  };
  // Scoping (`[dir]`/`--path`, `--repo`): keep only the sessions it selects.
  const sessions = selectSessions(opts, index, live, model).filter(inScope);
  sessions.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());
  const rows = sessions.map((s) => listRow(s, ctx));

  if (opts.json) return printJson(rows);
  printListTable(rows, isQuery, model?.provider === "github" ? "issue" : "wi", opts.scope);
}

/**
 * The default, unchanged `list`: the managed sessions running right now, one per
 * line. We walk the live `cl-…` tmux targets and resolve each back to its
 * session — id-bearing names (`cl-bg-`/`cl-new-`/`cl-claude-`/`cl-copilot-`/
 * `cl-codex-`) by embedded short id, work-item / PR / agent-assigns-its-own-id
 * names by working directory (as in model.ts)
 * — then report readiness, kind, id, location and title. Running-only and
 * model-free by design. `inScope` is the `--path`/`--repo` filter (match-all when
 * no selector was given); `thresholdMs` (already resolved by the caller) decides
 * the ⚠stalled marker. The two are independent: scoping picks which sessions are
 * listed, and each listed session is judged exactly as it would be unscoped.
 *
 * Coordinators are called out twice: `orch`/`global` in the kind column, and a
 * per-repo summary underneath saying which repos have an orchestrator and which
 * have none. That second one is the question a global orchestrator asks, and it
 * cannot be read off a table sorted by session.
 */
/** A running session `list` will show: resolved from its live window, in scope, first sighting. */
interface ListedSession {
  s: AgentSession;
  kind: SessionKind;
  target: string;
}

/**
 * The live `cl-…` windows resolved back to their sessions, once each. Same
 * attribution the TUI uses (a window's own `@cl_session_id` tag → that exact
 * session; id-bearing name → exact session; id-less cl-wi-/cl-pr- → MRU session
 * in the pane's cwd, matched on a normalized path), shared so the CLI list can't
 * drift from the menu's running state. Restored-but-unopened
 * placeholder windows are skipped here — they're idle bash waiting for a
 * keypress, not running agents, so counting them as RUNNING would mislead
 * (`pausedSessions` below lists them as their own state instead) — and so are
 * sessions the requested path / repo filter doesn't select. `managed` is read
 * once by the caller and shared with `pausedSessions`, rather than each
 * re-querying tmux.
 */
function listedSessions(managed: ManagedTarget[], index: SessionIndex, inScope: (s: AgentSession) => boolean): ListedSession[] {
  const seen = new Set<string>();
  const out: ListedSession[] = [];
  for (const { name, target, cwd, placeholder, tags } of managed) {
    const kind = managedKind(name);
    if (!kind || placeholder) continue;
    const s = resolveWindowSession(index.all, name, cwd, tags);
    if (!s || !inScope(s)) continue;
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ s, kind, target });
  }
  return out;
}

/**
 * Sessions parked as a paused restore-tab placeholder: an unopened tab, or one
 * that fell back to it when its agent exited. A placeholder's window name IS
 * the session's canonical name (see `sessionName`), so this is a name match
 * rather than the cwd-based resolution `listedSessions` needs for id-less
 * windows — but a name a REAL managed window ALSO answers to is running, not
 * paused (the two-pass logic `reconcileLive` uses), so those are dropped.
 */
function pausedSessions(managed: ManagedTarget[], index: SessionIndex, inScope: (s: AgentSession) => boolean): AgentSession[] {
  const paused = new Set(managed.filter((m) => m.placeholder).map((m) => m.name));
  for (const m of managed) if (!m.placeholder) paused.delete(m.name);
  const seen = new Set<string>();
  const out: AgentSession[] = [];
  for (const s of index.all) {
    if (!inScope(s) || !paused.has(sessionName(s))) continue;
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/** The trailing marker cell: ⚠ when stalled, ⛁N background shells, ◆N running workflows. */
function markerCell(stalled: boolean, shells: number, wfRunning: number): string {
  return [stalled ? STALLED_MARK : "", shells > 0 ? `⛁${shells}` : "", wfRunning > 0 ? `◆${wfRunning}` : ""]
    .filter(Boolean)
    .join(" ");
}

/** One line's cells for a running session, judged from its pane right now. */
function plainRow({ s, kind, target }: ListedSession, role: OrchestratorRole | null, thresholdMs: number): string[] {
  const { raw, cursor } = capturePaneState(target);
  const shells = paneShells(raw);
  const readiness = paneReadiness(raw, cursor);
  // Running-workflow marker (◆N): the session is live here by construction.
  const wfRunning = (s.workflows ?? []).filter((w) => workflowStatus(w, true) === "running").length;
  // …and so is the liveness the stall qualifier requires. A pane on claude's
  // own resume dialog is excluded there: it reads `ready` but hasn't run yet.
  // A `limited` one is excluded too, by the shared settled test — the readiness
  // cell beside this already says when its cap lifts, so the two never both
  // describe the same pause.
  const stalled = isStalled(
    { running: true, readiness, resumeDialog: paneResumeDialogActive(raw), backgroundAgents: paneBackgroundAgents(raw), idleSeconds: idleSeconds(s.lastUsed) },
    thresholdMs,
  );
  return [
    "●",
    readyCell(readiness, rowResetAt(readiness, raw), rowCompactionPercent(readiness, raw)),
    roleLabel(role, kind).padEnd(KIND_COL),
    shortId(s.id).padEnd(12), // bounds at 12 but does not pad; a shorter id left the rest of the row ragged
    timeAgo(s.lastUsed).padEnd(8),
    padCell(basename(s.cwd) || s.cwd, 24),
    s.title.replace(/\s+/g, " ").slice(0, 44),
    markerCell(stalled, shells, wfRunning),
  ];
}

/**
 * One line's cells for a PAUSED session: no pane to read (a placeholder holds
 * no agent), so no readiness, shells or stall marker — just what a restored
 * tab can say about itself: title, dir, id, and how long since it last did
 * anything. `⏸` in the lead column (the placeholder screen's own glyph) marks
 * it as a third state, never folded into the `●` running rows above it.
 */
function pausedRow(s: AgentSession, role: OrchestratorRole | null): string[] {
  return [
    "⏸",
    "paused",
    roleLabel(role, "resumed").padEnd(KIND_COL),
    shortId(s.id).padEnd(12),
    timeAgo(s.lastUsed).padEnd(8),
    padCell(basename(s.cwd) || s.cwd, 24),
    s.title.replace(/\s+/g, " ").slice(0, 44),
    "",
  ];
}

function runPlainList(
  index: SessionIndex,
  inScope: (s: AgentSession) => boolean,
  thresholdMs: number,
): void {
  // One read of the marker file for the whole listing, not one per row.
  const roles = orchestratorRoles();
  // One read of the managed panes, shared by both buckets below — a paused
  // session and a running one are two disjoint views of the same tmux scan.
  const managed = liveManagedPaths();
  // Cells, not finished lines: the readiness column's width isn't known until
  // every row is in (a `limited <time>` cell is wider than the state words,
  // and "paused" has to line up with both).
  const rows: string[][] = [];
  const summary: OrchestratorSummaryRow[] = [];
  for (const listed of listedSessions(managed, index, inScope)) {
    const role = roles.get(listed.s.id) ?? null;
    summary.push({ shortId: shortId(listed.s.id), cwd: listed.s.cwd, role, running: true });
    rows.push(plainRow(listed, role, thresholdMs));
  }
  for (const s of pausedSessions(managed, index, inScope)) {
    const role = roles.get(s.id) ?? null;
    // Honest ●/○ vocabulary downstream: a paused orchestrator is reported
    // `running: false`, same as a closed one — `printOrchestratorSummary`
    // never learns a third glyph exists.
    summary.push({ shortId: shortId(s.id), cwd: s.cwd, role, running: false });
    rows.push(pausedRow(s, role));
  }
  if (rows.length === 0) {
    console.log("No running sessions.");
    return;
  }
  const rw = readyWidth(rows.map((r) => r[1]));
  for (const [dot, ready, ...rest] of rows) console.log([dot, ready.padEnd(rw), ...rest].join("  ").trimEnd());
  printOrchestratorSummary(
    withRememberedOrchestrators(summary, index.all.filter(inScope), roles, shortId),
  );
}

/**
 * The exiting form of `scopeFlagValue`, for the subcommands parsed here (`wait`
 * uses the returning form directly — it turns its whole argv tail into an exit
 * code rather than exiting mid-parse). One guard, so a missing `--repo` can't be
 * an error on one subcommand and a silent "no filter" on another.
 */
