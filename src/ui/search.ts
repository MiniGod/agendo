import { sessionRepo } from "./format.ts";
import type { AgentSession, LinkedPR, PullRequest, ReviewPRWithSessions, WorkItem } from "../types.ts";

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
