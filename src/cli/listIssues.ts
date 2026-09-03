import { type LoadedModel } from "../model.ts";
import { printJson } from "../output.ts";
import type { WorkItem } from "../types.ts";
import { type ResourceListOptions, assocSessions, loadModelOrExit, oneLine, sessionMark } from "./resources.ts";
import { padCell } from "../ui/format.ts";

/** One issue / work item, as `list issues --json` emits it. */
export type IssueRow = ReturnType<typeof issueRows>[number];

/** The model's item lists (current + other + prLinked) as one deduplicated, newest-first list of rows. */
export function issueRows(model: Pick<LoadedModel, "current" | "other" | "prLinked" | "liveTmux">) {
  const seen = new Set<number>();
  const items: WorkItem[] = [];
  for (const it of [...model.current, ...model.other, ...model.prLinked]) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  items.sort((a, b) => b.id - a.id);
  return items.map((it) => ({
    id: it.id,
    type: it.type,
    title: oneLine(it.title),
    state: it.state,
    url: it.url || null,
    sessions: assocSessions(it.sessions, model.liveTmux),
  }));
}

export const issueHeader = (label: string): string => ["", "id".padEnd(7), "state".padEnd(14), "session".padEnd(12), label].join("  ");

/** One table line: the session mark, the id, the state, the best session and the title. */
export function formatIssueRow(r: IssueRow): string {
  return [
    sessionMark(r.sessions),
    `#${r.id}`.padEnd(7),
    padCell(r.state || "-", 14),
    (r.sessions[0]?.shortId ?? "-").padEnd(12),
    r.title.slice(0, 50),
  ].join("  ").trimEnd();
}

/**
 * `list issues` (aliases `wi` / `work-items`): issues / work items known to the
 * active backend, each with any associated session. Provider-aware vocab —
 * GitHub says "issue", Azure DevOps "work item". Reuses the model's item lists
 * (current + other + prLinked) and its live-tmux set; `--json` emits full rows
 * (id + state + sessions[]).
 */
export async function runListIssues(opts: ResourceListOptions): Promise<void> {
  const model = await loadModelOrExit(opts, "list issues", "work items");
  const label = model.provider === "github" ? "issue" : "work item";
  const rows = issueRows(model);
  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(`No ${label}s found.`);
    return;
  }
  console.log(issueHeader(label));
  for (const r of rows) console.log(formatIssueRow(r));
}
