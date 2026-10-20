// Where a session to be ended lives in tmux, how to address it for the read and
// the kill, and the tidying after a close.
import { forgetRestoreTab } from "../../runtime/restore/index.ts";
import type { AgentSession } from "../../shared/types.ts";
import {
  exactTarget, isPaneTarget, isPlaceholderWindow, killManagedTarget, killPane, liveTargetForShortId,
  sessionName, windowLocations, type LiveTarget,
} from "../../runtime/tmux/index.ts";
import type { KillHow } from "./guards.ts";

/**
 * For a known session: whatever window it's live in, under its canonical name.
 * For one too new to be indexed: the live id-bearing target named after this
 * very short id — which is only ever that session's own, so it's as safe a
 * target as the canonical name.
 *
 * The resolved target is KEPT, not rebuilt from the name. A pane-hosted session
 * has no window of that name, so re-deriving `{name, target: name}` would send
 * `closeAddress` down the window branch and leave the one thing we can plainly
 * see running uncloseable. `send` and `unblock` reach it by this same handle.
 */
export function liveHandle(
  s: AgentSession | undefined,
  sid: string,
  liveWindows: ReadonlyMap<string, LiveTarget>,
): { live: LiveTarget | null | undefined; canon: string | null } {
  const live = s ? liveWindows.get(sessionName(s)) : liveTargetForShortId(sid);
  const canon = s ? sessionName(s) : (live?.name ?? null);
  return { live, canon };
}

/**
 * The tmux name to end, if anything is there to end. A placeholder squats the
 * canonical name with no agent behind it; end it by that name (it's a real tmux
 * window) when no live window vouches for the session.
 */
export function closeTargetOf(
  live: LiveTarget | null | undefined,
  canon: string,
  livePlaceholders: ReadonlySet<string>,
): { placeholder: boolean; target: string | undefined } {
  const placeholder = !live && livePlaceholders.has(canon);
  const target = live?.name ?? (placeholder ? canon : undefined);
  return { placeholder, target };
}

export interface CloseAddress {
  readTarget: string;
  locations: string[];
  location: string | null;
  kill: () => { how: KillHow; gone: boolean };
}

/**
 * How to address the target for BOTH the pane read and the kill, so neither
 * falls back to tmux's current-session lookup.
 *
 * Two shapes, and telling them apart is the whole job. A session hosted in a
 * PANE of somebody else's window (the global orchestrator, beside the menu) owns
 * no window and no session, so `windowLocations` reports nothing for it and
 * `killManagedTarget` can place it nowhere. Its pane id is the handle, and it is
 * unambiguous by construction. `kill-pane` is also the only correct kill: the
 * window belongs to the menu, not to this session.
 *
 * Otherwise the name resolves to window locations. tmux allows duplicate window
 * names and this launcher produces them — a global and a path-scoped launcher
 * can each hold a tab for the same session — so more than one means we cannot
 * tell which window the caller meant. Reading the wrong one is harmless; killing
 * it is not. No location at all means the target is a tmux session of its own
 * (an agent launched outside tmux). The kill addresses a window by its
 * `session:index` location, re-reading the name there first (see
 * `killManagedTarget`), since tmux renumbers windows when one closes.
 */
export function closeAddress(name: string, live: LiveTarget | null | undefined): CloseAddress {
  if (live && isPaneTarget(live.target)) {
    const pane = live.target;
    return { readTarget: pane, locations: [], location: null, kill: () => ({ how: "pane", gone: killPane(pane, name) }) };
  }
  const locations = windowLocations(name);
  const location = locations[0] ?? null;
  return {
    readTarget: exactTarget(location ?? name),
    locations,
    location,
    kill: () => killManagedTarget(name, location),
  };
}

/**
 * Tidy the host session the window we just CLOSED lived in — a standalone agent
 * session (launched outside tmux) was never a tab in one, and gets nothing here.
 *
 * A dormant placeholder can carry the canonical name alongside the real window
 * we just killed — reconcileLive drops it from `livePlaceholders` in exactly
 * that case — so ask tmux directly rather than trust the reconciled set. Without
 * this the closed session is still sitting in the tab strip as an unopened tab.
 *
 * Scoped to that one host session, and flag-checked inside it: the same
 * canonical name can be tabbed in a SECOND launcher, and that launcher's strip
 * is none of this command's business — we don't edit its restore snapshot
 * either, so killing its tab would only make it reappear there on its next
 * start. The tab is dropped from the restore snapshot of that one host.
 */
export function tidyHost(host: string | undefined, canon: string, placeholder: boolean): void {
  if (!host) return;
  if (!placeholder && isPlaceholderWindow(host, canon)) killLeftoverPlaceholder(host, canon);
  forgetRestoreTab(canon, host);
}

function killLeftoverPlaceholder(host: string, canon: string): void {
  const leftover = windowLocations(canon).find((l) => l.startsWith(`${host}:`));
  if (leftover) killManagedTarget(canon, leftover);
}
