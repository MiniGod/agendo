import React, { useEffect, useRef, useState } from "react";
import { loadModelProgressively, type LoadedModel, type ModelStage } from "../../app/model/index.ts";
import { isRetryable, messageOf, retryAttempts, retryDelayMs, takeWarnings } from "../../shared/errors.ts";
import type { RepoInfo } from "../../repositories/index.ts";
import type { Identity, ProviderName } from "../../shared/types.ts";
import {
  INITIAL_LOAD_STATE,
  type ModelLoadState,
  type RetryState,
  type SliceLoadState,
} from "../models/loadState.ts";
import { vocab } from "../models/vocab.ts";
import { setVocab } from "../models/vocabState.ts";

interface ReadyState {
  provider: ProviderName | null;
  items: boolean;
  prs: boolean;
}

function pending(ready: boolean): SliceLoadState {
  return { phase: ready ? "refreshing" : "loading" };
}

function pendingState(ready: ReadyState): ModelLoadState {
  return { items: pending(ready.items), prs: pending(ready.prs) };
}

function failed(ready: boolean, completed: boolean, error: string): SliceLoadState {
  if (completed) return { phase: "ready" };
  return { phase: ready ? "stale-error" : "error", error };
}

function failedState(
  ready: ReadyState,
  completed: { items: boolean; prs: boolean },
  error: string,
): ModelLoadState {
  return {
    items: failed(ready.items, completed.items, error),
    prs: failed(ready.prs, completed.prs, error),
  };
}

function showWarnings(
  noticeRef: React.MutableRefObject<string | null>,
  setNotice: React.Dispatch<React.SetStateAction<string | null>>,
): void {
  if (noticeRef.current) return;
  const warnings = takeWarnings();
  if (warnings.length === 0) return;
  const shown = warnings.slice(0, 2);
  if (warnings.length > shown.length) shown.push(`+${warnings.length - shown.length} more`);
  setNotice(shown.join(" · "));
}

/**
 * Loads the model in independently publishable stages. A cold start exposes
 * local sessions before tracker requests finish; refreshes retain the last good
 * rows while local, item and PR data replace their respective slices.
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
  const [retrying, setRetrying] = useState<RetryState | null>(null);
  const [loadState, setLoadState] = useState<ModelLoadState>(INITIAL_LOAD_STATE);
  const [, setRetryTick] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const readyRef = useRef<ReadyState>({ provider: null, items: false, prs: false });

  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    if (readyRef.current.provider !== provider) {
      readyRef.current = { provider, items: false, prs: false };
    }
    setError(null);
    setLoadState(pendingState(readyRef.current));
    setRetrying(null);
    setVocab(vocab(provider));

    let cancelled = false;
    let activeAttempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;

    const publish = (token: number, completed: { items: boolean; prs: boolean }, stage: ModelStage) => {
      if (cancelled || token !== activeAttempt) return;
      setModel(stage.update);
      if (stage.kind === "items") {
        completed.items = true;
        readyRef.current.items = true;
        setLoadState((state) => ({ ...state, items: { phase: "ready" } }));
      }
      if (stage.kind === "complete") {
        completed.items = true;
        completed.prs = true;
        readyRef.current.items = true;
        readyRef.current.prs = true;
        setLoadState({ items: { phase: "ready" }, prs: { phase: "ready" } });
      }
    };

    (async () => {
      const attempts = retryAttempts();
      for (let attempt = 1; !cancelled; attempt++) {
        const completed = { items: false, prs: false };
        const token = ++activeAttempt;
        setLoadState(pendingState(readyRef.current));
        try {
          await loadModelProgressively(
            { provider, identity, hostSession, scopeRepos: discoveredRepos },
            (stage) => publish(token, completed, stage),
          );
          if (cancelled || token !== activeAttempt) return;
          setRetrying(null);
          showWarnings(noticeRef, setNotice);
          return;
        } catch (cause) {
          if (cancelled || token !== activeAttempt) return;
          activeAttempt++; // ignore late stages from sibling requests in this failed attempt
          const reason = messageOf(cause);
          if (!isRetryable(cause) || attempt >= attempts) {
            setRetrying(null);
            setError(reason);
            setLoadState(failedState(readyRef.current, completed, reason));
            return;
          }
          const delay = retryDelayMs(attempt);
          setLoadState(pendingState(readyRef.current));
          setRetrying({ attempt, attempts, resumeAt: Date.now() + delay, reason, waiting: true });
          await new Promise<void>((resolve) => {
            wake = resolve;
            timer = setTimeout(resolve, delay);
          });
          if (cancelled) return;
          setRetrying((state) => (state ? { ...state, waiting: false } : state));
        }
      }
    })();

    return () => {
      cancelled = true;
      activeAttempt++;
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }, [provider, identity, reloadKey, discoveredRepos, hostSession, setModel, setNotice, noticeRef]);

  useEffect(() => {
    if (!retrying?.waiting) return;
    const timer = setInterval(() => setRetryTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [retrying]);

  return { error, retrying, loadState, reload };
}
