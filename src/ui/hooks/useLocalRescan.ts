import React, { useEffect } from "react";
import { loadLocalSessions, type LoadedModel } from "../../model.ts";
import { mergeRepos, type RepoInfo } from "../../repos.ts";
import { sameLiveTmux, sameLiveWindows, sameRepos, sessionGroupsSig } from "../equality.ts";

const LIVE_POLL_MS = 2000; // background tmux-liveness refresh (no network)

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
    const handle = setInterval(async () => {
      if (inFlight || !modelRef.current) return; // no full model yet, or busy
      inFlight = true;
      try {
        const local = await loadLocalSessions();
        setModel((prev) => {
          if (!prev) return prev;
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
            sessionGroupsSig(prev.sessionGroups) === sessionGroupsSig(local.sessionGroups) &&
            sameLiveTmux(prev.liveTmux, local.live) &&
            sameLiveTmux(prev.livePlaceholders, local.livePlaceholders) &&
            sameLiveWindows(prev.liveWindows, local.liveWindows) &&
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
            sessionGroups: local.sessionGroups,
            repos,
            liveTmux: local.live,
            liveKinds: local.liveKinds,
            liveWindows: local.liveWindows,
            livePlaceholders: local.livePlaceholders,
          };
        });
      } catch {
        // Leave the last good model in place on a transient scan error.
      } finally {
        inFlight = false;
      }
    }, LIVE_POLL_MS);
    return () => clearInterval(handle);
    // All three are stable identities — two `useRef` objects and a `useState`
    // setter — so this array never changes and the interval is still armed
    // exactly once, as it was when the effect lived in App with `[]`. They are
    // listed rather than silenced because listing them is honest here: it costs
    // nothing, and it means a future caller passing something unstable re-arms
    // the timer instead of quietly reading a stale closure.
  }, [modelRef, discoveredReposRef, setModel]);
}
