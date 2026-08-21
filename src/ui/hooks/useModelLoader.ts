import React, { useEffect, useState } from "react";
import { loadModel, type LoadedModel } from "../../model.ts";
import { isRetryable, messageOf, retryAttempts, retryDelayMs, takeWarnings } from "../../errors.ts";
import type { RepoInfo } from "../../repos.ts";
import type { Identity, ProviderName } from "../../types.ts";
import { vocab } from "../../vocab.ts";
import { setVocab } from "../vocabState.ts";

/**
 * The data load and its automatic-retry loop, plus the ticker that keeps the
 * countdown on the retry screen moving.
 *
 * Extracted verbatim from App. The hook OWNS `error`, `retrying`, the
 * countdown tick and the `reloadKey` that `reload()` bumps, so the retry-tick
 * effect touches nothing it did not create.
 *
 * `model` itself deliberately stays in App: the background local-rescan effect
 * merges into it with `setModel` from a mount-only (`[]`) effect, so moving the
 * state here would hand that effect a setter it cannot see the origin of. The
 * load effect takes `setModel`, `setNotice` and `noticeRef` as parameters for
 * the same reason, and its dependency array is unchanged — it is the one effect
 * in the tree.
 *
 * The load effect's dependency array is COMPLETE, and deliberately so — it
 * carried an exhaustive-deps finding for a long time, first in App and then
 * (four names wide instead of one) here. Listing all of them costs nothing and
 * buys a real tripwire: `setModel`, `setNotice` and `noticeRef` are a useState
 * setter pair and a ref, so React guarantees their identity and they never
 * trigger a re-run; `hostSession` comes from `resolveContext` at process start
 * and `<App>` renders once, so it is a per-process constant today. The effect
 * therefore re-runs on exactly the renders it always did — and the day someone
 * makes the host session re-scopable at runtime, the reload it needs is already
 * wired instead of being a stale-model bug nobody connects to that change.
 *
 * One thing to keep true: `setNotice` must stay the raw setter. An inline
 * `(v) => …` passed by a caller would change identity every render and turn
 * this effect into a per-render reload.
 */
export function useModelLoader({
  provider,
  identity,
  hostSession,
  discoveredRepos,
  setModel,
  setNotice,
  noticeRef,
}: {
  provider: ProviderName;
  identity: Identity | null;
  hostSession: string | undefined;
  discoveredRepos: RepoInfo[];
  setModel: React.Dispatch<React.SetStateAction<LoadedModel | null>>;
  setNotice: React.Dispatch<React.SetStateAction<string | null>>;
  noticeRef: React.MutableRefObject<string | null>;
}) {
  const [error, setError] = useState<string | null>(null);
  // Set while a failed load is waiting to try again: which attempt just failed,
  // out of how many, when the next one fires, and why the last one didn't.
  const [retrying, setRetrying] = useState<{
    attempt: number;
    attempts: number;
    resumeAt: number;
    reason: string;
    /** True while counting down; false once the next attempt is actually in
     *  flight — otherwise the screen would sit on "retrying in 0s" for the whole
     *  duration of a load, which is the frozen screen this feature replaces. */
    waiting: boolean;
  } | null>(null);
  // Bumped by a timer purely to re-render the retry countdown (see below).
  const [, setRetryTick] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  // Re-run the data load (bumping the key the load effect depends on). Used by
  // the inline `open` (to refresh running badges) and the `r` refresh key.
  const reload = () => setReloadKey((k) => k + 1);

  // Reload whenever the backend, identity, or a manual refresh changes.
  //
  // A failed load retries itself with bounded exponential backoff instead of
  // parking on the "Press r to retry" screen, which needs a human — an
  // unattended launcher would sit there dead. Two guard rails matter more than
  // the happy path:
  //   • only failures `isRetryable` recognises as transient are retried at all,
  //     so a permanent one (a 404 from a team with no sprints, an expired
  //     login) still stops on the first attempt rather than looping forever;
  //   • the retry count is capped, after which the error is shown as before.
  // Attempts are strictly sequential and each is a whole `loadModel`, so the
  // per-load cache invalidation (Provider.beginLoad) still runs exactly once
  // per attempt and nothing is fetched concurrently.
  useEffect(() => {
    setError(null);
    setModel(null);
    setRetrying(null);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Resolves the backoff wait early. Cleanup calls it so a cancelled loop
    // *resumes* and exits on its `cancelled` check, rather than being left
    // suspended forever on a timer that was cleared out from under it.
    let wake: (() => void) | undefined;

    (async () => {
      const attempts = retryAttempts();
      for (let attempt = 1; !cancelled; attempt++) {
        try {
          const m = await loadModel({ provider, identity, hostSession, scopeRepos: discoveredRepos });
          if (cancelled) return;
          // Repoint the shared vocabulary BEFORE publishing the model it
          // describes. This used to sit in App's render body, which made it a
          // side effect during render — React is allowed to start a render and
          // throw it away, and a discarded render would have left `V` pointing
          // at a provider no longer on screen. Here it is an ordinary state
          // transition: `V` and `model` are updated in the same tick, in that
          // order, so the render that setModel schedules already sees the right
          // terms and the first paint is never stale.
          //
          // This is the ONLY place a load can change the provider. The rescan's
          // `setModel` merges the local half into `prev` and never touches
          // `provider`, so it needs no vocabulary update.
          setVocab(vocab(m.provider));
          setModel(m);
          setRetrying(null);
          // Surface anything reported-and-ignored (a corrupt state file, an
          // unparseable transcript record) rather than losing it silently — but
          // only into an EMPTY notice slot. `open()` sets a notice and then
          // reloads, so writing unconditionally here would wipe the message the
          // user is meant to read. Not draining when we can't show means the
          // diagnostic waits for the next load instead of being thrown away.
          // Only the first couple, summarised: the notice is one line of chrome,
          // not a log — several bad files would wrap over the list.
          if (!noticeRef.current) {
            const warnings = takeWarnings();
            if (warnings.length) {
              const shown = warnings.slice(0, 2);
              if (warnings.length > shown.length) shown.push(`+${warnings.length - shown.length} more`);
              setNotice(shown.join(" · "));
            }
          }
          return;
        } catch (e) {
          if (cancelled) return;
          const reason = messageOf(e);
          if (!isRetryable(e) || attempt >= attempts) {
            setRetrying(null);
            setError(reason);
            return;
          }
          const delay = retryDelayMs(attempt);
          setRetrying({ attempt, attempts, resumeAt: Date.now() + delay, reason, waiting: true });
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, delay);
          });
          if (cancelled) return;
          // The wait is over — flip to "retrying now" so the next attempt shows
          // as in-flight rather than as a countdown stuck at zero.
          setRetrying((r) => (r ? { ...r, waiting: false } : r));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }, [provider, identity, reloadKey, discoveredRepos, hostSession, setModel, setNotice, noticeRef]);

  // Tick twice a second while a retry is counting down, so the countdown on the
  // retry screen actually counts down instead of freezing on its first value.
  useEffect(() => {
    if (!retrying?.waiting) return;
    const t = setInterval(() => setRetryTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [retrying]);

  return { error, retrying, reload };
}
