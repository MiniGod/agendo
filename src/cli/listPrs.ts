import { type LoadedModel } from "../model.ts";
import { printJson } from "../output.ts";
import type { PRWithSessions } from "../types.ts";
import { type ResourceListOptions, assocSessions, loadScopedModel } from "./resources.ts";
import { flushWarnings } from "./warnings.ts";

/**
 * `list pr|prs`: the current identity's OPEN pull requests from the active
 * backend, each with the session working its branch (running one preferred) — an
 * orchestrator's "what PRs are in flight and which can I delegate to / poke". We
 * reuse the model's forward PR lists (linkedPrs + orphanPrs — PRs I created;
 * review PRs are someone else's, so excluded) and its live-tmux set for the
 * association, so there's no new matcher. `--json` emits the full rows (id +
 * branch + status + ci + sessions[]) for scripting.
 */
export async function runListPrs(opts: ResourceListOptions): Promise<void> {
  let model: LoadedModel;
  try {
    model = await loadScopedModel(opts);
  } catch (e) {
    flushWarnings("list pr");
    console.error(`list pr: could not load pull requests from the backend: ${(e as Error)?.message ?? e}`);
    process.exit(1);
    return;
  }
  flushWarnings("list pr");
  // PRs I created: linked-to-a-work-item + orphans. Dedupe by repo:id — GitHub PR
  // numbers are per-repo, so id alone can collide across repos.
  const seen = new Set<string>();
  const prs: PRWithSessions[] = [];
  for (const pr of [...model.linkedPrs, ...model.orphanPrs]) {
    const key = `${pr.repositoryId}:${pr.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prs.push(pr);
  }
  prs.sort((a, b) => b.updatedDate - a.updatedDate || b.id - a.id);

  const prPrefix = model.provider === "github" ? "#" : "!";
  const rows = prs.map((pr) => ({
    id: pr.id,
    title: pr.title.replace(/\s+/g, " ").trim(),
    status: pr.status,
    isDraft: pr.isDraft,
    ci: pr.ci,
    approvedCount: pr.approvedCount,
    requiredCount: pr.requiredCount,
    branch: pr.branch,
    repositoryId: pr.repositoryId,
    repositoryName: pr.repositoryName ?? null,
    // null rather than the "" a backend payload without repo scope yields, so a
    // consumer never pastes a half-built link (see PullRequest.url).
    url: pr.url || null,
    sessions: assocSessions(pr.sessions, model.liveTmux),
  }));

  if (opts.json) {
    await printJson(rows);
    return;
  }
  if (rows.length === 0) {
    console.log("No open pull requests.");
    return;
  }
  console.log(
    ["", "pr".padEnd(6), "ci".padEnd(8), "appr".padEnd(5), "branch".padEnd(24), "session".padEnd(12), "title"].join("  "),
  );
  for (const r of rows) {
    const best = r.sessions[0];
    console.log(
      [
        best?.running ? "●" : r.sessions.length ? "○" : " ",
        `${prPrefix}${r.id}`.padEnd(6),
        r.ci.padEnd(8),
        `${r.approvedCount}/${r.requiredCount}`.padEnd(5),
        r.branch.slice(0, 24).padEnd(24),
        (best?.shortId ?? "-").padEnd(12),
        (r.isDraft ? "[draft] " : "") + r.title.slice(0, 44),
      ].join("  ").trimEnd(),
    );
  }
}
