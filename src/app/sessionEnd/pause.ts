// What PAUSING adds to closing: the session's window is ended exactly as `close`
// ends it, and a restore placeholder takes its place in the same host session —
// the `⏸` tab `agendo list` shows as paused, which a keypress in it, `enter` on
// its row, or `agendo resume <id>` wakes again.
//
// Pause leaves the restore snapshot HOLDING the tab (close drops it), so the
// paused tab also survives the launcher being restarted.
import { existsSync } from "fs";
import { resumeArgv } from "../../launch/index.ts";
import { rememberRestoreTab, spawnPlaceholder, type RestoreTab } from "../../runtime/restore/index.ts";
import { isPaneTarget, isPlaceholderWindow, sessionName, sessionWindowCount, type LiveTarget } from "../../runtime/tmux/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import { refused, type Refusal } from "./guards.ts";

/** The restore tab a paused session leaves behind: the shape `buildTabs` persists. */
export function pausedTab(s: AgentSession): RestoreTab {
  const name = sessionName(s);
  return { name, cwd: s.cwd, title: s.title.replace(/\s+/g, " ").trim() || name, argv: resumeArgv(s) };
}

/**
 * Why this session cannot be left as a paused tab, or null when it can. Pausing
 * needs three things closing does not: a TAB of its own in a host session for
 * the placeholder to replace, a transcript for the placeholder to resume, and a
 * working directory that still exists for it to resume in (`restoreTabs` skips a
 * tab whose cwd is gone for the same reason). None of these can be forced: what
 * is missing is the paused state itself, so the answer is `close`.
 */
export function unpausableReason(
  s: AgentSession | undefined,
  label: string,
  target: string,
  live: LiveTarget | null | undefined,
  location: string | null,
): Refusal | null {
  const why = unpausableWhy(s, live, location);
  if (!why) return null;
  return refused(1, `Not pausing ${label} (${target}): ${why} — close it instead.`, why);
}

function unpausableWhy(s: AgentSession | undefined, live: LiveTarget | null | undefined, location: string | null): string | null {
  if (live && isPaneTarget(live.target)) return "it runs in a pane of another window, so there is no tab of its own to leave paused";
  if (!location) return "it runs as a tmux session of its own, not as a tab in one, so there is no tab to leave paused";
  if (!s) return "it has no transcript yet, so a paused tab would have nothing to resume";
  if (!existsSync(s.cwd)) return `its working directory is gone (${s.cwd}), so a paused tab could never resume there`;
  return null;
}

/**
 * A tab that is the ONLY window of its host session cannot be paused: tmux
 * destroys a session with its last window, so the kill would take the host with
 * it and leave the placeholder nowhere to go. Refused before anything is killed
 * rather than discovered after, as a pause left half done. A count of 0 is a
 * read that failed, not a lone tab — the kill's own checks still stand.
 */
export function loneTabRefusal(label: string, target: string, location: string | null): Refusal | null {
  const host = location?.split(":")[0];
  if (!host || sessionWindowCount(host) !== 1) return null;
  const why = `it is the only window in tmux session ${host}, which ends with it, so there is nowhere to leave the paused tab`;
  return refused(1, `Not pausing ${label} (${target}): ${why} — close it instead.`, why);
}

/**
 * Put the paused tab in place of the window just killed, in the same host
 * session, and keep it in that host's restore snapshot. A placeholder already
 * squatting the canonical name there (a restored tab never woken while the
 * session ran in a `cl-wi-…` window) IS the paused tab, so it is kept rather
 * than doubled. Returns whether the paused tab is there afterwards.
 */
export function leavePausedTab(host: string, s: AgentSession): boolean {
  const tab = pausedTab(s);
  if (!isPlaceholderWindow(host, tab.name)) spawnPlaceholder(host, tab);
  rememberRestoreTab(host, tab);
  return isPlaceholderWindow(host, tab.name);
}
