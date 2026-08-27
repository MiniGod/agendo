// The placeholder window itself: the paused tab a restored session shows until
// you press a key in it, and the shell command that puts it there.
//
// This is the half of restore that touches tmux. It sits below the snapshot
// logic — `retargetRestoreProfile` rebuilds a placeholder after rewriting a tab
// — and imports only the store, so the two never point at each other.
import { existsSync } from "fs";
import { LAUNCHER_SESSION, PLACEHOLDER_OPTION, exactTarget, isPlaceholderWindow, killWindow, markPlaceholder, newWindowIn } from "../tmux.ts";
import { loadRestore, type RestoreTab } from "./store.ts";

/**
 * Recreate a live, currently-paused placeholder window so its pane carries the
 * tab's CURRENT argv. tmux bakes the command into the window at creation time, so
 * there is no way to amend it in place — the window has to be killed and made
 * again. Costs the tab its position in the strip, which is the cheap half of the
 * trade. Returns whether a window was actually rebuilt.
 *
 * "Paused" covers both a never-opened tab and one whose agent has since exited
 * and fallen back to the placeholder screen: both carry the `@cl_placeholder`
 * flag, and in both the pane holds nothing but the idle bash loop, so the kill
 * below can't take a running agent with it.
 *
 * Two preconditions, both about not destroying something the user cares about:
 *  • `isPlaceholderWindow` — existence AND the `@cl_placeholder` flag read from a
 *    single query scoped to THIS host session, so the flag authorizing the kill
 *    can't be borrowed from a same-named window in another launcher's session
 *    while the one we're about to kill has already been woken into a real agent.
 *  • the cwd still exists — `restoreTabs` refuses to spawn a tab whose directory
 *    is gone (a pruned worktree) for the same reason it matters more here: the
 *    kill would succeed and the respawn fail silently under `tmuxQuiet`, so a
 *    *successful* move would destroy a visible tab and put nothing back.
 */
export function refreshPlaceholder(hostSession: string, tab: RestoreTab): boolean {
  if (!isPlaceholderWindow(hostSession, tab.name) || !existsSync(tab.cwd)) return false;
  killWindow(`${exactTarget(hostSession)}:${tab.name}`);
  spawnPlaceholder(hostSession, tab);
  return true;
}

/**
 * Create one lazy placeholder window for `tab` in the host session and flag it as
 * unloaded. Shared by first-run restore and the retarget path above so the two
 * can't drift on the marker or the argv.
 */
function spawnPlaceholder(hostSession: string, tab: RestoreTab): void {
  newWindowIn(hostSession, tab.name, tab.cwd, placeholderArgv(tab));
  // Mark it as an unloaded placeholder so isRunning doesn't report the idle
  // bash window as a running session. The placeholder script owns the flag from
  // here on: cleared when the tab is woken, set again when the agent exits and
  // the window falls back to the paused screen.
  markPlaceholder(`${hostSession}:${tab.name}`);
}

/** POSIX single-quote a string so it survives a `bash -c` script verbatim. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * How long to wait for more bytes after a bare `\e` before calling it a real
 * Escape keypress. An arrow / function key sends `\e` followed immediately by
 * the rest of its sequence, so a lone `\e` is only lone if nothing follows it —
 * the same trick a terminal editor's `ttimeoutlen` uses. Long enough that the
 * tail of a key sequence can't be mistaken for silence, short enough that a real
 * Esc closes the window without a perceptible pause.
 */
const ESC_SEQUENCE_TIMEOUT = "0.2";

/**
 * argv for a lazy placeholder window: a small bash loop around the tab's resume
 * command. It prints the session title, waits for a keypress, then runs the
 * resume in place. The pane is a tty, so `read` blocks on real input.
 *
 * Two deliberate departures from "print, read, exec":
 *
 *  • `q` (or `Q`) / Esc CLOSE the window instead of resuming. "Press any key" taken
 *    literally made the two keys a user reaches for to back out do the exact
 *    opposite. Closing only kills the tmux window: the session's transcript,
 *    worktree and branch are untouched and `agendo resume <id>` brings it back —
 *    it's the same "unload the tab" that `agendo close` does. A bare Esc is
 *    `\e`, but so is the FIRST byte of every arrow / function key, so a lone Esc
 *    is told apart by a short-timeout follow-up read (see ESC_SEQUENCE_TIMEOUT);
 *    when more bytes do follow we drain the rest of the sequence (so it can't
 *    leak into the agent's input) and treat it as an ordinary resume key.
 *
 *  • No `exec`, so control comes BACK here when the agent exits (Ctrl-D, /exit,
 *    or a crash) and the window returns to this paused screen instead of
 *    vanishing with its pane's process. Disposing of a session is then two
 *    deliberate steps — quit the agent, then press q/Esc — rather than one
 *    stray Ctrl-D. Re-running `tab.argv` on the next pass resumes the SAME
 *    session, not a duplicate: a restore tab's argv is always a `resumeArgv`
 *    (`claude --resume <id>` / `copilot --resume=<id>`, plus env/flags), which
 *    addresses the session by its stable id and carries no initial prompt — so
 *    it's idempotent and needs no second-pass variant.
 *
 * Ctrl-C is deliberately NOT a third way out: it reaches the agent as usual, but
 * neither killing the agent with it nor pressing it on the paused screen closes
 * the window (see the `trap` in the script). Closing stays a q/Esc decision.
 *
 * The `@cl_placeholder` window option is kept honest on every path: cleared
 * before the agent runs so the live set counts the window as running, and set
 * again as soon as the agent exits so a re-paused window stops counting. Both
 * are addressed from inside the pane (no `-t`), i.e. the current window.
 * The quit path takes the window — and its options — with it.
 */
export function placeholderArgv(tab: RestoreTab): string[] {
  const cmd = tab.argv.map(shq).join(" ");
  const head = shq(`⏸  ${tab.title}`);
  const hint = shq("Press any key to resume · q or Esc to close this window");
  const unmark = `tmux set-option -uw ${PLACEHOLDER_OPTION} 2>/dev/null`;
  const remark = `tmux set-option -w ${PLACEHOLDER_OPTION} 1 2>/dev/null`;
  // Swallow whatever is already buffered on the tty. Without it, a keystroke
  // typed at the agent as it exited (or the tail of the Ctrl-D that ended it)
  // would be read as the answer to a prompt that isn't on screen yet.
  const drain = `while read -rsn1 -t 0.01 _; do :; done`;
  const script = [
    // Killing the current window ends this process too; the exit is the fallback
    // for a pane that somehow isn't in tmux, so the shell never spins on.
    `cl_quit() { tmux kill-window 2>/dev/null; exit 0; }`,
    // Ctrl-C must reach the AGENT without taking this wrapper down with it: a
    // non-interactive bash whose foreground child dies from SIGINT re-raises it
    // on itself and exits — which under `exec` didn't matter and now would close
    // the window on an interrupt, the very thing this loop exists to prevent. A
    // no-op handler (not `trap ""`, which children would inherit as *ignored*
    // and so swallow the user's Ctrl-C) keeps the signal working everywhere it
    // should: bash resets caught traps to their default in the commands it runs.
    `trap : INT`,
    `while :; do`,
    `  ${drain}`,
    `  clear`,
    `  printf '%s\\n\\n' ${head}`,
    `  printf '%s\\n' ${hint}`,
    `  read -rsn1 cl_key; cl_status=$?`,
    // >128 means a signal interrupted the read (Ctrl-C on the paused screen) —
    // redraw and keep waiting; only q/Esc closes a window. Any other failure is
    // EOF: no input will ever arrive, so leave rather than spin on it.
    `  if [ "$cl_status" -gt 128 ]; then continue; fi`,
    `  if [ "$cl_status" -ne 0 ]; then exit 0; fi`,
    `  case "$cl_key" in`,
    `    q|Q) cl_quit ;;`,
    `    $'\\e')`,
    `      if read -rsn1 -t ${ESC_SEQUENCE_TIMEOUT} _; then ${drain}; else cl_quit; fi ;;`,
    `  esac`,
    `  ${unmark}`,
    `  clear`,
    `  ${cmd}`,
    `  ${remark}`,
    `done`,
  ].join("\n");
  return ["bash", "-c", script];
}

/**
 * Recreate the saved agent tabs as lazy placeholder windows in the launcher
 * host session — each a real tmux tab that stays unloaded until you open it.
 * Called once, right after the host session is freshly created (an existing
 * session already has its live windows, so there's nothing to restore).
 */
export function restoreTabs(hostSession: string = LAUNCHER_SESSION): void {
  for (const tab of loadRestore(hostSession)) {
    // The saved cwd may have been deleted or moved since the snapshot (e.g. a
    // pruned worktree). `tmux new-window -c <gone>` either silently falls back to
    // a different start-directory (resuming in the wrong place) or fails outright
    // with the error swallowed by tmuxQuiet — either way the tab misbehaves with
    // no diagnostic. Skip it and say so. (Runs from the `--tmux` bootstrap in
    // index.tsx, which exits before Ink renders, so stderr is safe here.)
    if (!existsSync(tab.cwd)) {
      console.error(`restore: skipping ${tab.name} — working dir gone: ${tab.cwd}`);
      continue;
    }
    spawnPlaceholder(hostSession, tab);
  }
}

