import { type LoadedModel } from "../model.ts";
import { printJson } from "../output.ts";
import type { WorkItem } from "../types.ts";
import { type ResourceListOptions, assocSessions, loadScopedModel } from "./resources.ts";
import { flushWarnings } from "./warnings.ts";

/**
 * `list issues` (aliases `wi` / `work-items`): issues / work items known to the
 * active backend, each with any associated session. Provider-aware vocab —
 * GitHub says "issue", Azure DevOps "work item". Reuses the model's item lists
 * (current + other + prLinked) and its live-tmux set; `--json` emits full rows
 * (id + state + sessions[]).
 */
export async function runListIssues(opts: ResourceListOptions): Promise<void> {
  let model: LoadedModel;
  try {
    model = await loadScopedModel(opts);
  } catch (e) {
    flushWarnings("list issues");
    console.error(`list issues: could not load work items from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
    return;
  }
  flushWarnings("list issues");
  const label = model.provider === "github" ? "issue" : "work item";
  const seen = new Set<number>();
  const items: WorkItem[] = [];
  for (const it of [...model.current, ...model.other, ...model.prLinked]) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
  }
  items.sort((a, b) => b.id - a.id);

  const rows = items.map((it) => ({
    id: it.id,
    type: it.type,
    title: it.title.replace(/\s+/g, " ").trim(),
    state: it.state,
    url: it.url || null,
    sessions: assocSessions(it.sessions, model.liveTmux),
  }));

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log(`No ${label}s found.`);
    return;
  }
  console.log(
    ["", "id".padEnd(7), "state".padEnd(14), "session".padEnd(12), label].join("  "),
  );
  for (const r of rows) {
    const best = r.sessions[0];
    console.log(
      [
        best?.running ? "●" : r.sessions.length ? "○" : " ",
        `#${r.id}`.padEnd(7),
        (r.state || "-").slice(0, 14).padEnd(14),
        (best?.shortId ?? "-").padEnd(12),
        r.title.slice(0, 50),
      ].join("  ").trimEnd(),
    );
  }
}
