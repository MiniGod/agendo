// `agendo list` / `ls` — the managed sessions running right now, as a table or
// as JSON.
//
// `branchSync` is injected for the same reason it is in ./status.ts: this
// module must not appear on any import path that the rescan timer can reach.

import { basename } from "path";
import {
  capturePaneState, liveManagedPaths, managedKind,
  paneBackgroundAgents, paneReadiness, paneResumeDialogActive, paneShells, sessionName,
  shortId,
} from "../tmux.ts";
import { SessionIndex } from "../sessions.ts";
import { idleSeconds, isStalled, resolveStalledAfterMs } from "../idle.ts";
import { resolveWindowSession } from "../restore.ts";
import { scopeFilter, scopeNote, type SessionScope } from "../scope.ts";
import { loadModel, refreshLiveTmux, type LoadedModel } from "../model.ts";
import { orchestratorRoles } from "../orchestrator.ts";
import { printJson } from "../output.ts";
import type { AgentSession, BranchSyncReader } from "../types.ts";
import { workflowStatus } from "../workflows.ts";
import { flushWarnings } from "./warnings.ts";
import { padCell, readyCell, readyWidth, rowCompactionPercent, rowResetAt, timeAgo } from "./cells.ts";
import { currentModelOptions } from "./links.ts";
import { STALLED_MARK } from "./glyphs.ts";
import { listRow, type ListRow, type ListRowContext } from "./listRow.ts";
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
  /** `--stalled-after` override, in ms; falls back to config (see src/idle.ts). */
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

/** One line of the enriched table. */
function tableLine(r: ListRow, ready: string): string {
  const wfRunning = r.workflows.filter((w) => w.status === "running").length;
  return [
    r.running ? "●" : "○",
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

  const { live, liveKinds, liveWindows } = refreshLiveTmux(index.all);
  const ctx: ListRowContext = {
    live, liveKinds, liveWindows,
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
function runPlainList(
  index: SessionIndex,
  inScope: (s: AgentSession) => boolean,
  thresholdMs: number,
): void {
  const seen = new Set<string>();
  // One read of the marker file for the whole listing, not one per row.
  const roles = orchestratorRoles();
  // Cells, not finished lines: the readiness column's width isn't known until
  // every row is in (a `limited <time>` cell is wider than the state words).
  const rows: string[][] = [];
  const summary: OrchestratorSummaryRow[] = [];
  for (const { name, target, cwd, placeholder } of liveManagedPaths()) {
    const kind = managedKind(name);
    if (!kind) continue;
    // Skip restored-but-unopened placeholder windows — they're idle bash waiting
    // for a keypress, not running agents, so listing them would mislead.
    if (placeholder) continue;
    // Same attribution the TUI uses (id-bearing → exact session; id-less
    // cl-wi-/cl-pr- → MRU session in the pane's cwd, matched on a normalized
    // path). Shared so the CLI list can't drift from the menu's running state.
    const s = resolveWindowSession(index.all, name, cwd);
    if (!s) continue;
    // Scoping: skip sessions the requested path / repo filter doesn't select.
    if (!inScope(s)) continue;
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const role = roles.get(s.id) ?? null;
    summary.push({ shortId: shortId(s.id), cwd: s.cwd, role, running: true });
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
    rows.push([
      "●",
      readyCell(readiness, rowResetAt(readiness, raw), rowCompactionPercent(readiness, raw)),
      roleLabel(role, kind).padEnd(KIND_COL),
      shortId(s.id).padEnd(12), // bounds at 12 but does not pad; a shorter id left the rest of the row ragged
      timeAgo(s.lastUsed).padEnd(8),
      padCell(basename(s.cwd) || s.cwd, 24),
      s.title.replace(/\s+/g, " ").slice(0, 44),
      [stalled ? STALLED_MARK : "", shells > 0 ? `⛁${shells}` : "", wfRunning > 0 ? `◆${wfRunning}` : ""]
        .filter(Boolean)
        .join(" "),
    ]);
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
