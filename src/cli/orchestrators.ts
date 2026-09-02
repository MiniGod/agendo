// How the CLI's listings show the coordination hierarchy:
//
//     global orchestrator  →  per-repo orchestrators  →  per-worktree sessions
//
// A human scanning `agendo list` has to be able to see, without reading titles,
// which sessions are coordinators and which repos have nobody coordinating them.
// That is one label in the `kind` column plus one summary block, and both live
// here so the plain and the enriched list can't render them differently.
import { basename } from "path";
import { repoRootForCwd } from "../repos.ts";
import type { OrchestratorRole } from "../orchestrator.ts";
import type { SessionKind } from "../tmux.ts";
import { KIND_LABEL } from "./glyphs.ts";

/**
 * Width of the `kind` column. Wider than the 3 the kind labels alone need,
 * because the two coordinator labels are what a reader is scanning FOR: `orch`
 * and `global` have to be spelled out, not abbreviated into the noise.
 */
export const KIND_COL = 6;

/**
 * The `kind` cell for a session: its coordination role when it has one, else how
 * it was launched. The role WINS over the kind — an orchestrator is launched as a
 * `bg` session, and reporting it as one is exactly the thing this column exists
 * to stop.
 */
export function roleLabel(role: OrchestratorRole | null, kind: SessionKind | null): string {
  if (role === "global") return "global";
  if (role === "repo") return "orch";
  return kind ? KIND_LABEL[kind] : "-";
}

/** One session's contribution to the per-repo orchestrator summary. */
export interface OrchestratorSummaryRow {
  shortId: string;
  cwd: string;
  role: OrchestratorRole | null;
  running: boolean;
}

/** A repo and the orchestrator coordinating it, if any. */
export interface RepoOrchestrator {
  root: string;
  name: string;
  /** The repo-level orchestrators found here (normally 0 or 1), running flag kept. */
  orchestrators: { shortId: string; running: boolean }[];
}

/**
 * Group listed sessions by repo root and pick out the repo-level orchestrators.
 *
 * A session's repo is its checkout's root, so every worktree of a repo folds back
 * onto the repo itself (`repoRootForCwd`) — otherwise each worktree would look
 * like an unmanaged repo of its own, which is the exact opposite of the question
 * this answers. The global orchestrator belongs to no repo and is excluded here;
 * it is reported separately.
 */
export function repoOrchestrators(rows: OrchestratorSummaryRow[]): RepoOrchestrator[] {
  const byRoot = new Map<string, RepoOrchestrator>();
  for (const r of rows) {
    if (r.role === "global") continue;
    const root = repoRootForCwd(r.cwd);
    let entry = byRoot.get(root);
    if (!entry) {
      entry = { root, name: basename(root) || root, orchestrators: [] };
      byRoot.set(root, entry);
    }
    if (r.role === "repo") entry.orchestrators.push({ shortId: r.shortId, running: r.running });
  }
  return [...byRoot.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Fold the orchestrators that are NOT running into a summary built from the live
 * windows.
 *
 * The plain `list` walks live tmux targets, so on its own it can only ever print
 * `●` — and a repo whose only orchestrator has been closed would read `none`.
 * That is the one reading this block exists to prevent: `none` is what a
 * coordinator acts on by starting an orchestrator, and a second one in a repo
 * squash-merges into the same main branch as the first. The marker file outlives
 * the window precisely so the answer can be `○` instead.
 *
 * Repo-level ones only join a repo the summary ALREADY has a row for. This block
 * describes the repos of the sessions above it; a repo with nothing running is
 * not something the reader is looking at, and inventing a line for it would say
 * "here is a repo" on the strength of a marker alone. The GLOBAL orchestrator is
 * different — it belongs to no repo, there is at most one, and "the one you
 * closed is still there to resume" is the whole of what its line says.
 *
 * `sessions` must already be scope-filtered by the caller; this adds rows, and a
 * row the scope excluded has no business appearing through the back door.
 */
export function withRememberedOrchestrators(
  live: OrchestratorSummaryRow[],
  sessions: { id: string; cwd: string }[],
  roles: Map<string, OrchestratorRole>,
  toShortId: (id: string) => string,
): OrchestratorSummaryRow[] {
  const listed = new Set(live.map((r) => r.shortId));
  const repos = new Set(live.filter((r) => r.role !== "global").map((r) => repoRootForCwd(r.cwd)));
  const out = [...live];
  for (const s of sessions) {
    const role = roles.get(s.id);
    if (!role) continue;
    const sid = toShortId(s.id);
    if (listed.has(sid)) continue;
    if (role === "repo" && !repos.has(repoRootForCwd(s.cwd))) continue;
    listed.add(sid);
    out.push({ shortId: sid, cwd: s.cwd, role, running: false });
  }
  return out;
}

/**
 * The block printed under the session table: one line per repo naming its
 * orchestrator or saying it has none, plus any global orchestrator — running or
 * merely remembered, since ● vs ○ is what says which, and "the one you closed is
 * still there to resume" is worth as much as "one is running".
 *
 * Deliberately NOT a ready-to-paste `launch --orchestrator` command. That flag
 * starts a session in the user's MAIN checkout and tells it to merge there, so
 * it is an escalation a human authorises — `--help` and the README document it,
 * and `--llm` pointedly does not (see src/launchPrompt.ts). Saying "none" is the
 * information; handing every agent that runs `list` the command is not.
 */
export function printOrchestratorSummary(rows: OrchestratorSummaryRow[]): void {
  const repos = repoOrchestrators(rows);
  const global = rows.filter((r) => r.role === "global");
  if (repos.length === 0 && global.length === 0) return;
  console.log("");
  console.log("orchestrators:");
  // Same ●/○ vocabulary as the session table two lines up. An orchestrator that
  // is remembered but not running is NOT the same answer as one that is — it is
  // "resume this, don't start a second" — and printing both as ● would contradict
  // the very table it sits under.
  const glyph = (running: boolean) => (running ? "●" : "○");
  for (const repo of repos) {
    const who = repo.orchestrators.length
      ? repo.orchestrators.map((o) => `${glyph(o.running)} ${o.shortId}`).join("  ")
      : "none";
    console.log(`  ${repo.name.padEnd(24)}  ${who}`);
  }
  for (const g of global) console.log(`  ${"(global)".padEnd(24)}  ${glyph(g.running)} ${g.shortId}`);
}
