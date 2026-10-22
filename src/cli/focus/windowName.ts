// Naming a session by its tmux window: `agendo focus cl-wi-102`, or
// `agendo://focus?session=cl-bg-codex-abc`, alongside the session id and short
// id `focus` always took.
//
// A window name that embeds a short id (`cl-claude-`, `cl-copilot-`,
// `cl-codex-`, `cl-bg-`, `cl-new-`; see `ID_BEARING_NAME`) is that short id and
// nothing more. The rest — `cl-wi-…`, `cl-pr-…`, a tagged `cl-bg-codex-…` —
// say nothing about the session, so they are looked up as a LIVE window of
// exactly that name and resolved by the session id the window carries in its
// tag (`@cl_session_id`, see names.ts). Never by cwd: the cwd + most-recent
// heuristic is fine for showing a row, not for deciding which agent a link
// brings forward. An untagged window, or a placeholder, resolves to nothing.
//
// Read-only: the only tmux call it can lead to is the pane listing `managed`
// stands for, and it returns sessions that already exist — what focus then
// does with them is focus's business, and a link can still only focus.
import { ID_BEARING_NAME, shortId, type ManagedTarget } from "../../runtime/tmux/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import { findSession } from "../commands/resume.ts";
import { isWindowName } from "./url.ts";

/**
 * The sessions `token` names: one for an id, a short id or an id-bearing window
 * name; for an id-less window name, every session a live window of that exact
 * name is tagged with (usually one — tmux allows a name twice, and `focus`
 * picks among several the way it does for a PR). `managed` is only called for
 * an id-less window name, so an id never costs a tmux read.
 */
export function sessionsForToken(all: AgentSession[], token: string, managed: () => ManagedTarget[]): AgentSession[] {
  if (!isWindowName(token)) {
    const s = findSession(all, token);
    return s ? [s] : [];
  }
  const sid = ID_BEARING_NAME.exec(token)?.[1];
  if (sid) {
    const s = all.find((x) => shortId(x.id) === sid);
    return s ? [s] : [];
  }
  const ids = new Set(managed().filter((m) => m.name === token && !m.placeholder).map((m) => m.tags?.sessionId));
  return all.filter((s) => ids.has(s.id));
}
