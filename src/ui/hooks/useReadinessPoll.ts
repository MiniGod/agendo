import { useEffect, useRef, useState } from "react";
import type { LoadedModel } from "../../model.ts";
import {
  capturePane,
  capturePaneState,
  sendResume,
  sendDialogReveal,
  paneReadiness,
  paneResumeSafe,
  paneLimitDialogActive,
  paneShells,
  paneCompactionPercent,
  stripAnsi,
} from "../../tmux.ts";
import { paneResetAt, shouldAutoResume, shouldRevealDialog } from "../../usageLimit.ts";
import type { PaneState } from "../format.ts";

// How often to re-read running sessions' panes for input readiness. Each tick
// captures one pane per running session (cheap tmux calls), so keep it modest.
const READINESS_MS = 1500;

/**
 * Input-readiness polling for every running session, plus the #8 auto-resume
 * bookkeeping that rides the same capture.
 *
 * Extracted verbatim from App. The hook OWNS every piece of state the poll
 * needs — the pane snapshot map, the three per-limited-session ref maps, and
 * the `autoResume` mirror ref — so nothing here is shared with the rest of the
 * component and the effect's dependency array is unchanged (`[model]`).
 *
 * Effect order: the `autoResumeRef` mirror is declared immediately before the
 * poll effect, exactly as it was relative to the poll in App. It is a pure
 * ref-assignment with no cleanup, no other effect in the tree reads that ref,
 * and the ref is seeded with the correct value at `useRef(autoResume)` time, so
 * its position among the unrelated effects it used to sit between is inert.
 */
export function useReadinessPoll({
  model,
  autoResume,
}: {
  model: LoadedModel | null;
  autoResume: boolean;
}) {
  // Live pane snapshot (input readiness + background-shell count) per running
  // session, by canonical name. Polled on a short timer independent of the
  // ADO-backed model reload.
  const [panes, setPanes] = useState<Map<string, PaneState>>(new Map());
  // Per-limited-session bookkeeping for auto-resume, keyed by canonical name:
  //   • limitWindows — the frozen reset instant for the current limit window
  //     (null when no reset time was parseable, so we know not to auto-resume);
  //   • resumeFired  — the reset instant we've already sent `continue` for, so a
  //     single window fires at most once.
  //   • dialogRevealed — canonical names we've already sent the one reveal Escape
  //     to (the numbered dialog hides its reset time; one Escape reveals it). Kept
  //     SEPARATE from resumeFired so the reveal can't be confused with the later
  //     Escape→continue→Enter resume, and so a reset time that never appears just
  //     parks (no repeat Escape). All three are cleared when a session leaves the
  //     limited state, so its next limit window starts fresh.
  const limitWindows = useRef<Map<string, number | null>>(new Map());
  const resumeFired = useRef<Map<string, number>>(new Map());
  const dialogRevealed = useRef<Set<string>>(new Set());
  // Mirror the setting into a ref so the readiness poll's interval closure reads
  // the current value without re-arming the timer.
  const autoResumeRef = useRef(autoResume);
  useEffect(() => { autoResumeRef.current = autoResume; }, [autoResume]);

  // Poll input readiness for every running session by reading its tmux pane.
  // Re-armed whenever the model reloads (the live-window set may have changed);
  // captures are synchronous and only over running sessions, so no overlap.
  useEffect(() => {
    const windows = model?.liveWindows;
    if (!windows || windows.size === 0) {
      setPanes((p) => (p.size === 0 ? p : new Map()));
      // No live windows to attribute to — drop all auto-resume bookkeeping so a
      // relaunched session can't inherit a stale (possibly past) reset instant.
      limitWindows.current.clear();
      resumeFired.current.clear();
      dialogRevealed.current.clear();
      return;
    }
    const sample = () => {
      // Capture each pane once (outside the state updater, which must stay pure)
      // and derive readiness, shell count, and — when limited — the reset time
      // from the same snapshot. Auto-resume is folded in here so it rides the
      // same cadence and the same fresh capture.
      const next = new Map<string, PaneState>();
      for (const [canon, win] of windows) {
        const { raw, cursor } = capturePaneState(win);
        const readiness = paneReadiness(raw, cursor);
        let resetAt: number | null | undefined;
        if (readiness === "limited") {
          // Freeze the reset instant on first *successful* parse of this limit
          // window: a bare "3pm" parses as the next 3pm, which would jump to
          // tomorrow the moment the clock passes it — freezing keeps a stable
          // target to fire on. Re-parse while still null (a first capture can
          // race the TUI paint and miss the reset line) so a transient miss
          // doesn't permanently disable auto-resume for the window.
          const frozen = limitWindows.current.get(canon);
          if (frozen != null) resetAt = frozen;
          else {
            resetAt = paneResetAt(stripAnsi(raw));
            limitWindows.current.set(canon, resetAt ?? null);
          }
          // Auto-resume: once the frozen reset has passed (plus grace) and we
          // haven't already fired for it, re-verify the pane is STILL safely
          // limited — empty input box, no open dialog (guarding the sample→act
          // gap and never clobbering a draft/dialog) — then send `continue`.
          if (autoResumeRef.current) {
            const fired = resumeFired.current.get(canon) ?? null;
            if (shouldAutoResume({ enabled: true, readiness, resetAt: resetAt ?? null, now: Date.now(), firedFor: fired })) {
              const fresh = capturePaneState(win);
              if (paneResumeSafe(fresh.raw, fresh.cursor)) {
                sendResume(win);
                resumeFired.current.set(canon, resetAt as number); // non-null per shouldAutoResume
              }
            } else if (
              // No reset time yet AND we're parked in the numbered dialog (which
              // hides it): send ONE Escape to reveal the "resets <time>" notice, so
              // the NEXT poll can parse+freeze it and shouldAutoResume can fire.
              // Never sends `continue` this tick — just reveals.
              shouldRevealDialog({
                enabled: true,
                readiness,
                dialogActive: paneLimitDialogActive(raw),
                resetAt: resetAt ?? null,
                revealed: dialogRevealed.current.has(canon),
              })
            ) {
              // Re-capture fresh to guard the sample→act gap, and confirm it's STILL
              // the active dialog before pressing Escape (only ever Escape a pane
              // whose own "Esc to cancel" affordance is showing).
              if (paneLimitDialogActive(capturePane(win))) {
                sendDialogReveal(win);
                dialogRevealed.current.add(canon);
              }
            }
          }
        } else if (readiness !== "busy" && readiness !== "unknown") {
          // Definitively recovered (ready / queued / dialog / compacting): drop
          // the frozen window + fire record so a *future* limit window starts
          // fresh. We deliberately keep them through "busy" (the generation our
          // own `continue` kicks off) and "unknown" (a transient blank capture),
          // so a single flicker can't wipe the fire-once guard and re-fire.
          limitWindows.current.delete(canon);
          resumeFired.current.delete(canon);
          dialogRevealed.current.delete(canon);
        }
        next.set(canon, {
          readiness,
          shells: paneShells(raw),
          resetAt,
          // Read from the same snapshot as the readiness it belongs to, so the
          // percent shown can never be a different frame's than the state word.
          compactionPercent: readiness === "compacting" ? paneCompactionPercent(raw) : null,
        });
      }
      // A window that vanished between reloads leaves stale bookkeeping; prune it.
      for (const canon of limitWindows.current.keys()) if (!windows.has(canon)) limitWindows.current.delete(canon);
      for (const canon of resumeFired.current.keys()) if (!windows.has(canon)) resumeFired.current.delete(canon);
      for (const canon of dialogRevealed.current) if (!windows.has(canon)) dialogRevealed.current.delete(canon);
      setPanes((prev) => {
        const same =
          prev.size === next.size &&
          [...next].every(
            ([k, v]) =>
              prev.get(k)?.readiness === v.readiness &&
              prev.get(k)?.shells === v.shells &&
              prev.get(k)?.resetAt === v.resetAt &&
              // Load-bearing: without it the map is judged "same" for the whole
              // compaction and the percent freezes at whatever the first poll saw.
              prev.get(k)?.compactionPercent === v.compactionPercent,
          );
        return same ? prev : next;
      });
    };
    sample(); // paint without waiting a full interval
    const handle = setInterval(sample, READINESS_MS);
    return () => clearInterval(handle);
  }, [model]);

  return panes;
}
