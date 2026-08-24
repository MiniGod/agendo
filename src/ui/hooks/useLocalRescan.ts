import React, { useEffect } from "react";
import { isRemoteKey, loadLocalSessions, type LoadedModel } from "../../model.ts";
import { mergeRepos, type RepoInfo } from "../../repos.ts";
import type { LiveTarget, SessionKind } from "../../tmux.ts";
import type { RepoSessions } from "../../types.ts";
import { sameLiveTmux, sameLiveWindows, sameRepos, sessionGroupsSig } from "../equality.ts";

const LIVE_POLL_MS = 2000; // background tmux-liveness refresh (no network)

/** A session group belonging to another machine — see `loadLocalSessions`. */
const isRemoteGroup = (g: RepoSessions) => g.sessions.some((x) => x.host);

/**
 * Fold a fresh LOCAL scan onto the remote half of the model already loaded.
 *
 * A remote entry is any key carrying a `<host>\0` prefix — `liveKey`'s doing, and
 * the reason it exists: local and remote live in the same maps and are still
 * told apart by their keys. The local scan is authoritative for everything else,
 * so its maps are the base and only the remote keys are carried over.
 */
function mergeRemote(
  prev: LoadedModel,
  local: { live: Set<string>; liveKinds: Map<string, SessionKind>; liveWindows: Map<string, LiveTarget>; livePlaceholders: Set<string> },
): { live: Set<string>; liveKinds: Map<string, SessionKind>; liveWindows: Map<string, LiveTarget>; livePlaceholders: Set<string> } {
  const live = new Set(local.live);
  const liveKinds = new Map(local.liveKinds);
  const liveWindows = new Map(local.liveWindows);
  const livePlaceholders = new Set(local.livePlaceholders);
  for (const k of prev.liveTmux) if (isRemoteKey(k)) live.add(k);
  for (const k of prev.livePlaceholders) if (isRemoteKey(k)) livePlaceholders.add(k);
  for (const [k, v] of prev.liveKinds) if (isRemoteKey(k)) liveKinds.set(k, v);
  for (const [k, v] of prev.liveWindows) if (isRemoteKey(k)) liveWindows.set(k, v);
  return { live, liveKinds, liveWindows, livePlaceholders };
}

/**
 * The background LOCAL rescan. Extracted from App unchanged apart from the
 * cancellation guard described below; called from the position the effect
 * occupied, so its place in App's effect order is unchanged.
 */
export function useLocalRescan({
  modelRef,
  discoveredReposRef,
  setModel,
}: {
  modelRef: React.MutableRefObject<LoadedModel | null>;
  discoveredReposRef: React.MutableRefObject<RepoInfo[]>;
  setModel: React.Dispatch<React.SetStateAction<LoadedModel | null>>;
}) {
  // Background LOCAL rescan every LIVE_POLL_MS: re-run the cheap, network-free
  // session scan (loadLocalSessions → SessionIndex.build + discoverRepos +
  // refreshLiveTmux) and merge its fresh session groups / repos / live-tmux state
  // into the model the app already has. This is what makes a session started
  // AFTER the last full `loadModel` appear in the list — and, critically, puts its
  // window into `liveWindows` — without a manual `r`, so the readiness poll and
  // #8 auto-resume can act on it. The SLOW backend fetch (work items / PRs / team)
  // stays on the `r` / provider-change cadence; nothing here touches the network.
  // Mount-only: reads `model` via modelRef; merges via setModel so the
  // network-derived fields (items, PRs, teamMembers, sessionLinks) are preserved.
  // `discoveredRepos` is read through a ref: an `r` rescan can replace it, and a
  // mount-only interval closing over the old array would drop a just-cloned repo
  // back out of the fresh-session picker on the next tick.
  useEffect(() => {
    let inFlight = false; // a slow disk scan must not overlap the next tick
    // `clearInterval` stops FUTURE ticks but does nothing about a tick already
    // awaiting the disk scan, so without this the resolution would still call
    // `setModel` after unmount. Harmless in React 18 (the setState is dropped)
    // and the interval is mount-only, so in practice this fires only on exit —
    // but "the cleanup does not actually cancel the work" is worth closing
    // rather than relying on a no-op that used to be a warning.
    let stopped = false;
    const handle = setInterval(async () => {
      if (inFlight || stopped || !modelRef.current) return; // no full model yet, or busy
      inFlight = true;
      try {
        const local = await loadLocalSessions();
        if (stopped) return; // unmounted while the scan was running
        setModel((prev) => {
          if (!prev) return prev;
          // Remote machines are NOT re-swept here, and must not be. This timer
          // fires every 2 seconds; a beam call costs ~45 ms and a sweep is
          // ~2 calls per remote window (docs/remote-machines.md §11.2), so a
          // handful of remote sessions would put most of a second of subprocess
          // work on a 2-second timer — the same CPU regression the gitrefs
          // import guard exists to prevent, an order of magnitude worse.
          //
          // So the fresh LOCAL scan is folded onto whatever the last FULL load
          // found remotely, rather than replacing it. Remote rows therefore keep
          // their readiness until the next `r`; local rows stay live at 2 s.
          // That difference is real and is the honest trade — a stale remote row
          // beats a launcher that stalls for a second at a time.
          const remoteGroups = prev.sessionGroups.filter(isRemoteGroup);
          const carried = mergeRemote(prev, local);
          // The rescan's repos are session-derived only, so re-apply the same
          // merge loadModel does — otherwise a path-discovered repo that has
          // never hosted a session would drop out of the fresh-session picker a
          // tick after every load.
          const repos = mergeRepos(local.repos, discoveredReposRef.current);
          // Only re-render when something the list / readiness effect cares about
          // actually changed — an unchanged local scan is a no-op, so a stable
          // limited session doesn't thrash the readiness effect (which re-arms on
          // every `model` change and would otherwise re-sample constantly).
          const unchanged =
            sessionGroupsSig(prev.sessionGroups) === sessionGroupsSig([...local.sessionGroups, ...remoteGroups]) &&
            sameLiveTmux(prev.liveTmux, carried.live) &&
            sameLiveTmux(prev.livePlaceholders, carried.livePlaceholders) &&
            sameLiveWindows(prev.liveWindows, carried.liveWindows) &&
            sameRepos(prev.repos, repos);
          if (unchanged) return prev;
          // Merge the fresh LOCAL half; keep the NETWORK half from the last full
          // load. NB: item.sessions / pr.sessions were associated against the OLD
          // index, so a brand-new session's backlink to an item/PR lags until the
          // next full `r` — acceptable for v1 (the session itself still appears and
          // is live-polled). We deliberately DON'T touch limitWindows/resumeFired/
          // dialogRevealed (now private to useReadinessPoll): a rescan must never
          // reset a frozen reset instant or the guard, or auto-resume re-fires it.
          return {
            ...prev,
            sessionGroups: [...local.sessionGroups, ...remoteGroups],
            repos,
            liveTmux: carried.live,
            liveKinds: carried.liveKinds,
            liveWindows: carried.liveWindows,
            livePlaceholders: carried.livePlaceholders,
          };
        });
      } catch {
        // Leave the last good model in place on a transient scan error.
      } finally {
        inFlight = false;
      }
    }, LIVE_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
    // All three are stable identities — two `useRef` objects and a `useState`
    // setter — so this array never changes and the interval is still armed
    // exactly once, as it was when the effect lived in App with `[]`. They are
    // listed rather than silenced because listing them is honest here: it costs
    // nothing, and it means a future caller passing something unstable re-arms
    // the timer instead of quietly reading a stale closure.
  }, [modelRef, discoveredReposRef, setModel]);
}
