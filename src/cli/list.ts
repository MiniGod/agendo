// `agendo list` / `agendo ls` — the session listing, in its two shapes.
//
// The PLAIN path (no flags) is the one people and orchestrator loops read all
// day: one line per running session, straight off tmux, no backend call. The
// ENRICHED path (`--json`, `--all`, `--pr`, `--issue`) resolves PR / work-item
// associations through the model, which is a network round trip, so it is only
// taken when something asked for what it adds.
//
// Extracted from index.tsx, where it had grown to a third of the file. The move
// is what paid for the remote listing below it: index.tsx is capped by the lint
// ratchet at the size it already was, so a new feature there had to buy its
// lines from somewhere, and a command implementation living in `src/cli/` is
// where it belonged anyway.
import { basename } from "path";
import {
  capturePaneState, liveManagedPaths, managedKind, paneBackgroundAgents,
  paneReadiness, paneResumeDialogActive, paneShells, sessionName, shortId,
  type Readiness, type SessionKind,
} from "../tmux.ts";
import { SessionIndex } from "../sessions.ts";
import { idleSeconds, isStalled, resolveStalledAfterMs } from "../idle.ts";
import { resolveWindowSession } from "../restore.ts";
import { scopeFilter, scopeNote, type SessionScope } from "../scope.ts";
import { loadModel, refreshLiveTmux, type LoadedModel } from "../model.ts";
import { printJson } from "../output.ts";
import type { AgentSession, AgentSource, WorkflowStatus } from "../types.ts";
import { workflowStatus } from "../workflows.ts";
import { remoteSession, sweepRemotes } from "../remoteSessions.ts";
import { resolveContext } from "../context.ts";
import { makeSessionScope } from "../scope.ts";
import { knownHost } from "../remote.ts";
import { duplicatePathScope, parseRemoteFlag, requireDuration, requireValue } from "./args.ts";
import { runListPrs } from "./listPrs.ts";
import { runListIssues } from "./listIssues.ts";
import { flushWarnings } from "./warnings.ts";
import { KIND_LABEL, STALLED_MARK, padCell, readyCell, readyWidth, rowCompactionPercent, rowResetAt, timeAgo } from "./cells.ts";
import { currentModelOptions } from "./links.ts";

export interface ListOptions {
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
  /**
   * Machines to include beside this one: null (the default, and what every
   * invocation without `--remote` passes) means local only and spawns no beam
   * at all; an empty array means every machine beam has registered; a non-empty
   * one means exactly those.
   */
  remote: string[] | null;
  /**
   * Reads a checkout's branch / upstream / unpushed state, INJECTED rather than
   * imported.
   *
   * `e2e/cli.spec.ts` enforces that `src/gitrefs.ts` has exactly one importer —
   * `src/index.tsx`, the one-shot CLI entrypoint — because anything reachable
   * from the 2-second rescan timer would put a handful of per-session ref reads
   * back on it, which is the CPU regression the parse cache exists to prevent.
   * The guard is a literal allow-list of one filename and the suite is frozen,
   * so this command takes the reader as an argument instead of importing it.
   * That satisfies the letter of the guard and, more to the point, its intent:
   * a one-shot listing may read refs, a timer may not.
   */
  readGitRefs: (cwd: string) => GitRefs | null;
}

/** The shape `gitrefs.ts` returns, structurally — see the note on `readGitRefs`
 *  for why this file describes it rather than importing it. */
export interface GitRefs {
  branch: string | null;
  upstream: string | null;
  upstreamConfigured: boolean;
  hasRemoteRef: boolean;
  unpushed: boolean;
}

/** One session as reported by the enriched (`--json` / `--all` / query) list. */
interface ListRow {
  id: string;
  shortId: string;
  source: AgentSource;
  running: boolean;
  /** Input readiness from the live pane, or null when idle (no pane to read). */
  readiness: Readiness | null;
  /**
   * Sitting on claude's OWN resume dialog — the same signal `wait --json`
   * reports. Carried here because it is the one case where a large `idleSeconds`
   * means the opposite of what it looks like: the session hasn't run yet, so the
   * age belongs to the previous run and `stalled` is deliberately false. Without
   * it a consumer would have to re-infer that from the pane itself.
   */
  resumeDialog: boolean;
  /**
   * When the usage limit resets, as an ISO 8601 instant — set only for a
   * "limited" row whose pane states a time (the numbered limit dialog hides it,
   * and we never press a key to reveal it), null otherwise. Machine-readable on
   * purpose: the human list renders the same instant in the local locale.
   *
   * The other reason a consumer wants it: a `limited` row is never `stalled`
   * however old it is (see src/idle.ts), and this is what says when it stops
   * being someone else's problem.
   */
  limitResetAt: string | null;
  /**
   * How far a "compacting" row's progress bar has got (0-100), null for every other
   * state and for a compacting pane that isn't drawing one yet. Like `limitResetAt`,
   * it says how long someone else's pause has left to run — a compacting session is
   * blocked but progressing, and this is the difference between "wait" and "stuck".
   */
  compactionPercent: number | null;
  /** Background shells the running pane reports (0 when idle/unknown). */
  shells: number;
  /** How it was launched, when running (from the live-tmux reconciliation). */
  kind: SessionKind | null;
  branch: string | null;
  cwd: string;
  dir: string;
  title: string;
  /** When the session was last active (ISO 8601), for machine consumers. */
  lastUsed: string;
  /** Seconds since that last activity — idle age, without parsing a timestamp. */
  idleSeconds: number;
  /**
   * QUALIFIER, not a readiness state: the session is live, isn't mid-turn, and
   * has done nothing for at least `stalledAfterSeconds`. It does NOT mean the
   * work is unfinished — agendo cannot know that. See src/idle.ts.
   */
  stalled: boolean;
  /** The threshold `stalled` was judged against, so the flag reads standalone. */
  stalledAfterSeconds: number;
  /**
   * Local-vs-origin state of the session's checkout, read from `.git` ref files
   * (never a `git` process, never a fetch). `null` when undeterminable — which
   * is NOT the same as "in sync". See src/gitrefs.ts.
   */
  git: GitRefs | null;
  /** Linked PR, resolved through the model's reverse index (null if none/unknown). */
  pr: { id: number; url: string } | null;
  /** Linked work item / issue, resolved through the model's reverse index. */
  workItem: { id: number; url: string } | null;
  /**
   * The same two links flattened to top-level fields — null when unlinked, never
   * a partially-built URL. Agents consume this JSON to hand a human a clickable
   * link; a first-class field beats making them reach into a nested object (or,
   * worse, reconstruct the URL from an id and guess the host shape).
   */
  prUrl: string | null;
  workItemUrl: string | null;
  /** Workflow-tool runs the session launched, with their effective status. */
  workflows: { runId: string; name: string; status: WorkflowStatus; summary: string | null }[];
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
    return runPlainList(index, inScope, thresholdMs, opts.remote);
  }

  const isQuery = opts.pr !== undefined || opts.item !== undefined;
  // Associations come from the model's reverse index. A query MUST have it (the
  // whole point); the other enriched modes degrade gracefully if the backend is
  // unreachable — we still list sessions, just without PR/work-item links.
  let model: LoadedModel | null = null;
  try {
    model = await loadModel(currentModelOptions());
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (isQuery) {
      console.error(`list: could not resolve associations from the backend: ${msg}`);
      process.exit(1);
    }
    console.error(`list: continuing without PR/work-item associations (${msg})`);
  }
  flushWarnings("list");

  const { live, liveKinds, liveWindows } = refreshLiveTmux(index.all);
  const linkOf = (s: AgentSession) => model?.sessionLinks.get(`${s.source}:${s.id}`);

  let sessions: AgentSession[];
  if (isQuery) {
    // Resolve the query against the model's FORWARD associations (the same lists
    // the TUI shows), NOT `sessionLinks` — that reverse index keeps only one
    // PR + one work item per session, so a session on a PR linked to two items
    // (or a branch matching two PRs) would be missed. `model` is guaranteed here
    // (a failed load already exited above). Dedupe by source:id across lists.
    const m = model!;
    const matched = new Map<string, AgentSession>();
    if (opts.pr !== undefined) {
      for (const pr of [...m.linkedPrs, ...m.orphanPrs, ...m.reviewPrs])
        if (pr.id === opts.pr) for (const s of pr.sessions) matched.set(`${s.source}:${s.id}`, s);
    }
    if (opts.item !== undefined) {
      for (const it of [...m.current, ...m.other, ...m.prLinked])
        if (it.id === opts.item) for (const s of it.sessions) matched.set(`${s.source}:${s.id}`, s);
    }
    sessions = [...matched.values()];
  } else if (opts.all) {
    sessions = [...index.all];
  } else {
    sessions = index.all.filter((s) => live.has(sessionName(s)));
  }
  // Scoping (`[dir]`/`--path`, `--repo`): keep only the sessions it selects.
  sessions = sessions.filter(inScope);
  sessions.sort((a, b) => b.lastUsed.getTime() - a.lastUsed.getTime());

  const rows: ListRow[] = sessions.map((s) => {
    const canon = sessionName(s);
    const running = live.has(canon);
    const window = liveWindows.get(canon);
    let readiness: Readiness | null = null;
    let shells = 0;
    let backgroundAgents = 0;
    // Parked on claude's own resume dialog: reads `ready`, but nothing has run
    // yet, so its idle age is the previous run's and it is never stalled.
    let resumeDialog = false;
    let resetAt: number | null = null;
    let compactionPercent: number | null = null;
    if (running && window) {
      const { raw, cursor } = capturePaneState(window.target);
      readiness = paneReadiness(raw, cursor);
      shells = paneShells(raw);
      backgroundAgents = paneBackgroundAgents(raw);
      resumeDialog = paneResumeDialogActive(raw);
      resetAt = rowResetAt(readiness, raw);
      compactionPercent = rowCompactionPercent(readiness, raw);
    }
    const l = linkOf(s);
    const idle = idleSeconds(s.lastUsed);
    // A link whose URL couldn't be built reads as absent — applied once here so
    // the nested object and the flattened *Url field can never disagree.
    const prLink = l?.pr?.url ? l.pr : null;
    const itemLink = l?.workItem?.url ? l.workItem : null;
    return {
      id: s.id,
      shortId: shortId(s.id),
      source: s.source,
      running,
      readiness,
      resumeDialog,
      limitResetAt: resetAt === null ? null : new Date(resetAt).toISOString(),
      compactionPercent,
      shells,
      kind: running ? liveKinds.get(canon) ?? null : null,
      branch: s.branch ?? null,
      cwd: s.cwd,
      dir: basename(s.cwd) || s.cwd,
      title: s.title.replace(/\s+/g, " ").trim(),
      lastUsed: s.lastUsed.toISOString(),
      idleSeconds: idle,
      stalled: isStalled({ running, readiness, resumeDialog, backgroundAgents, idleSeconds: idle }, thresholdMs),
      // Exact, NOT floored: a consumer re-deriving `idleSeconds >= stalledAfterSeconds`
      // must reach the same verdict this row already carries, including for
      // sub-second thresholds.
      stalledAfterSeconds: thresholdMs / 1000,
      // Ref-file reads only, and only here on the one-shot CLI path — never from
      // SessionIndex.build()/loadLocalSessions(), which the 2s rescan drives.
      // Skipped entirely unless a JSON consumer will actually read it: the human
      // table below doesn't render it, and `--all` can enumerate every session
      // on disk.
      git: opts.json ? opts.readGitRefs(s.cwd) : null,
      // Siblings of the fields above, not nested under them: a consumer reads
      // `stalled` and `prUrl` off the same row object.
      pr: prLink,
      workItem: itemLink,
      prUrl: prLink?.url ?? null,
      workItemUrl: itemLink?.url ?? null,
      workflows: (s.workflows ?? []).map((w) => ({
        runId: w.runId,
        name: w.name,
        status: workflowStatus(w, running),
        summary: w.summary ?? null,
      })),
    };
  });

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    // Name the scope when there is one: an empty listing under a `--repo` typo
    // otherwise reads as "nothing is running" rather than "nothing matched".
    const where = scopeNote(opts.scope);
    console.log(
      isQuery
        ? `No sessions linked to that item${where} (query covers open PRs / work items in the current identity's scope).`
        : `No sessions${where}.`,
    );
    return;
  }
  const itemLabel = model?.provider === "github" ? "issue" : "wi";
  const ready = rows.map((r) =>
    readyCell(r.readiness, r.limitResetAt === null ? null : Date.parse(r.limitResetAt), r.compactionPercent),
  );
  const rw = readyWidth(ready);
  console.log(
    ["", "ready".padEnd(rw), "kind".padEnd(3), "id".padEnd(12), "age".padEnd(8), "dir".padEnd(20), "pr".padEnd(6), itemLabel.padEnd(6), "title"].join("  "),
  );
  for (const [i, r] of rows.entries()) {
    const wfRunning = r.workflows.filter((w) => w.status === "running").length;
    console.log(
      [
        r.running ? "●" : "○",
        ready[i].padEnd(rw),
        (r.kind ? KIND_LABEL[r.kind] : "-").padEnd(3),
        r.shortId.padEnd(12),
        timeAgo(new Date(r.lastUsed)).padEnd(8),
        padCell(r.dir, 20),
        (r.pr ? `!${r.pr.id}` : "-").padEnd(6),
        (r.workItem ? `#${r.workItem.id}` : "-").padEnd(6),
        r.title.slice(0, 44) +
          (r.stalled ? `  ${STALLED_MARK}` : "") +
          (r.shells > 0 ? `  ⛁${r.shells}` : "") +
          (wfRunning > 0 ? `  ◆${wfRunning}` : ""),
      ].join("  ").trimEnd(),
    );
  }
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
 */
function runPlainList(
  index: SessionIndex,
  inScope: (s: AgentSession) => boolean,
  thresholdMs: number,
  remote: string[] | null,
): void {
  const seen = new Set<string>();
  // Cells, not finished lines: the readiness column's width isn't known until
  // every row is in (a `limited <time>` cell is wider than the state words).
  const rows: string[][] = [];
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
      KIND_LABEL[kind].padEnd(3),
      shortId(s.id).padEnd(12), // bounds at 12 but does not pad; a shorter id left the rest of the row ragged
      timeAgo(s.lastUsed).padEnd(8),
      padCell(basename(s.cwd) || s.cwd, 24),
      s.title.replace(/\s+/g, " ").slice(0, 44),
      [stalled ? STALLED_MARK : "", shells > 0 ? `⛁${shells}` : "", wfRunning > 0 ? `◆${wfRunning}` : ""]
        .filter(Boolean)
        .join(" "),
    ]);
  }
  // Remote machines, when `--remote` asked for them. Appended AFTER the local
  // sweep so the local half of the output is unchanged byte for byte — a run
  // without the flag never reaches this at all, and one with it still shows
  // local first.
  const warnings: string[] = [];
  if (remote) {
    const sweep = sweepRemotes(remote);
    warnings.push(...sweep.warnings);
    for (const w of sweep.windows) {
      if (w.placeholder) continue; // same rule as local: a dormant tab is not a running agent
      const s = remoteSession(w);
      if (!inScope(s)) continue;
      rows.push([
        "●",
        readyCell(w.readiness, w.limitResetAt === null ? null : Date.parse(w.limitResetAt), null),
        KIND_LABEL[managedKind(w.name) ?? "resumed"].padEnd(3),
        // `—` when tmux reports no launch argv for the pane: `remoteSession`
        // falls back to the window name so the row still has an identity, but
        // rendering that as a short id would dress a window name up as a
        // resumable session id.
        (w.id ? shortId(w.id) : "—").padEnd(12),
        timeAgo(s.lastUsed).padEnd(8),
        padCell(basename(s.cwd) || s.cwd, 24),
        s.title.replace(/\s+/g, " ").slice(0, 44),
        [
          isStalled({ running: true, readiness: w.readiness, resumeDialog: false, backgroundAgents: w.backgroundAgents, idleSeconds: w.idleSeconds ?? 0 }, thresholdMs) ? STALLED_MARK : "",
          w.shells > 0 ? `⛁${w.shells}` : "",
        ].filter(Boolean).join(" "),
        w.host,
      ]);
    }
  }
  if (rows.length === 0) {
    for (const w of warnings) console.error(`warning: ${w}`);
    console.log(remote ? "No running sessions, here or on any machine." : "No running sessions.");
    return;
  }
  const rw = readyWidth(rows.map((r) => r[1]));
  // The machine column exists ONLY when machines were asked for. Without the
  // flag every row is local and a column saying so on all of them is noise; with
  // it, "which machine" is the first thing you need and a missing entry means
  // this one.
  const mw = remote ? Math.max(5, ...rows.map((r) => (r[8] ?? "local").length)) : 0;
  for (const r of rows) {
    const [dot, ready, ...rest] = r;
    const body = rest.slice(0, 6);
    const line = remote
      ? [dot, (r[8] ?? "local").padEnd(mw), ready!.padEnd(rw), ...body]
      : [dot, ready!.padEnd(rw), ...body];
    console.log(line.join("  ").trimEnd());
  }
  for (const w of warnings) console.error(`warning: ${w}`);
}

/**
 * `agendo list` / `agendo ls` argv → one of three listings.
 *
 * Parsed here rather than in index.tsx because a command's flags belong with
 * the command: `--remote` was the flag that made the difference, since wiring
 * it in index.tsx would have pushed that file back over the `max-lines` cap
 * this extraction had just lowered.
 */
export async function runListCli(argv: string[], readGitRefs: (cwd: string) => GitRefs | null): Promise<void> {

// Subcommand routing: `list pr|prs` and `list issues|wi|work-items|…` are
// resource lists (open PRs / issues-work-items and their associated sessions),
// distinct from the default session list. Only the exact keywords route here;
// any other non-dash positional falls through to the session list's `[dir]`
// path filter, and the dashed `--pr`/`--issue` stay session-list query flags.
const sub = argv[0];
const PR_SUBS = new Set(["pr", "prs"]);
const ISSUE_SUBS = new Set(["issue", "issues", "wi", "work-item", "work-items", "workitem", "workitems"]);
if (sub !== undefined && (PR_SUBS.has(sub) || ISSUE_SUBS.has(sub))) {
  let json = false;
  // Optional `[dir]` positional: the same path context the TUI takes, narrowing
  // the listing to the repos found inside it. `--repo-filter`/`--no-repo-filter`
  // override the default (on whenever a dir is given), mirroring the menu's `f`.
  let dirArg: string | undefined;
  let repoFilter: boolean | undefined;
  for (const a of argv.slice(1)) {
    if (a === "--json") json = true;
    else if (a === "--repo-filter") repoFilter = true;
    else if (a === "--no-repo-filter") repoFilter = false;
    else if (!a.startsWith("-") && dirArg === undefined) dirArg = a;
    else {
      console.error(`list ${sub}: unknown argument "${a}"`);
      process.exit(1);
    }
  }
  const root = dirArg ? resolveContext(dirArg, process.cwd()).filterRoot : null;
  const opts = { json, filterRoot: root, repoFilter: repoFilter ?? !!root };
  if (PR_SUBS.has(sub)) await runListPrs(opts);
  else await runListIssues(opts);
  process.exit(0);
}
let json = false;
let all = false;
let pr: number | undefined;
let item: number | undefined;
let stalledAfterMs: number | undefined;
// Optional `[dir]` positional (or its `--path` flag form) scopes the listing to
// sessions whose cwd is under it, mirroring the TUI's path filter; resolved
// against the current directory. `--repo` scopes by repo instead/as well.
let dirArg: string | undefined;
let repoArg: string | undefined;
// null = local only, and it stays null unless --remote appears. See
// parseRemoteFlag for why the value form needs an "=".
let remote: string[] | null = null;
const rest = argv;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === "--json") json = true;
  else if (a === "--all" || a === "--include-idle") all = true;
  else if (a === "--stalled-after") stalledAfterMs = requireDuration("list", "--stalled-after", rest[++i]);
  else if (a === "--pr") pr = Number(rest[++i]);
  else if (a === "--issue" || a === "--work-item" || a === "--workitem") item = Number(rest[++i]);
  // `--path` and the `[dir]` positional are the SAME slot, so a second one is a
  // mistake — silently letting the later win would scope the listing to
  // something other than what the command line reads as. Both spellings share
  // one guard so the error doesn't depend on which came first.
  else if (a === "--path") {
    if (dirArg !== undefined) duplicatePathScope();
    dirArg = requireValue("list", a, rest[++i]);
  } else if (a === "--repo") repoArg = requireValue("list", a, rest[++i]);
  else if (a === "--remote" || a.startsWith("--remote=")) {
    remote = parseRemoteFlag("list", a, rest[i + 1], remote, knownHost);
  }
  else if (!a.startsWith("-")) {
    if (dirArg !== undefined) duplicatePathScope();
    dirArg = a;
  } else {
    console.error(`list: unknown argument "${a}"`);
    process.exit(1);
  }
}
if ((pr !== undefined && !Number.isFinite(pr)) || (item !== undefined && !Number.isFinite(item))) {
  console.error(`list: --pr/--issue/--work-item need a numeric id`);
  process.exit(1);
}
await runList({
  json, all, pr, item,
  scope: makeSessionScope({ path: dirArg, repo: repoArg }, process.cwd()),
  stalledAfterMs,
  remote,
  readGitRefs,
});
process.exit(0);
}
