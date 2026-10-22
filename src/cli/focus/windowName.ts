// Naming a session by its tmux window: `agendo focus cl-wi-102`, or
// `agendo://focus?session=cl-bg-codex-abc`, alongside the session id and short
// id `focus` always took.
//
// A window name that embeds a short id (`cl-claude-`, `cl-copilot-`,
// `cl-codex-`, `cl-bg-`, `cl-new-`; see `ID_BEARING_NAME`) is that short id and
// nothing more. The rest — `cl-wi-…`, `cl-pr-…`, `cl-bg-codex-…`,
// `cl-new-codex-…`, legacy `cl-free-…` — say nothing about the session, so
// they go by whichever session the live window of exactly that name is
// ATTRIBUTED to: the session id in the window's own tag
// (`@cl_session_id`, see names.ts) where it carries one, else the cwd + most
// recently used fallback (`resolveWindowSession`, src/runtime/restore/). That is the same answer the TUI's
// row and `list` give for the window, which matters because the fallback is the
// common case — a `cl-wi-`/`cl-pr-` window is launched with no id to tag, and
// nothing completes the tag later.
//
// The match is deliberately against the session → window map focus itself
// moves the client by, never against the named window on its own. Attribution
// gives each session ONE window, so when two windows fall to the same session —
// two id-less windows in one cwd, or one beside that cwd's newest session's own
// window — the one that lost resolves to nothing and the link says so. Resolving
// it anyway would be worse: focus would then bring forward the session's OTHER
// window, or, finding the session it picked not running, resume it a second
// time onto the same transcript. A refusal is the only honest answer until
// these windows carry their session id. (That holds per snapshot: focus reads
// the map again to judge running vs idle, so attribution flipping in between —
// a new transcript landing in the same cwd — can still mislead it, exactly as
// it already could for a short id resolved by cwd. Closing that means focus
// reading tmux once, which is the lookup rework, not this file.)
// Placeholders are never attributed (they hold no agent), so never match.
//
// Read-only: the only tmux calls it can lead to are the window and pane
// listings behind `attributed`, and it returns sessions that already exist —
// what focus then does with them is focus's business, and a link can still
// only focus.
import { ID_BEARING_NAME, sessionName, type LiveTarget } from "../../runtime/tmux/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import { findSession } from "../commands/resume.ts";
import { isWindowName } from "./url.ts";

/**
 * The sessions `token` names: one for an id, a short id or an id-bearing window
 * name; for an id-less window name, the session its live window is attributed
 * to. `attributed` is canonical session name → the window it runs in (the
 * `liveWindows` of `refreshLiveTmux`), and is only called for an id-less window
 * name, so an id never costs a tmux read.
 */
export function sessionsForToken(all: AgentSession[], token: string, attributed: () => Map<string, LiveTarget>): AgentSession[] {
  // `findSession` already reads an id-bearing name as the short id it embeds.
  if (!isWindowName(token) || ID_BEARING_NAME.test(token)) {
    const s = findSession(all, token);
    return s ? [s] : [];
  }
  const windows = attributed();
  return all.filter((s) => windows.get(sessionName(s))?.name === token);
}
