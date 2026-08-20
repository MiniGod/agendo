import React, { useEffect, useMemo, useRef } from "react";
import { loadActivity } from "../../sessions.ts";
import { sameActivity } from "../equality.ts";
import type { Activity } from "../format.ts";
import { sessionId, type Row } from "../rows.ts";
import type { AgentSession } from "../../types.ts";

const POLL_MS = 1000;

/**
 * Live activity polling for expanded sessions: one `setInterval` per open
 * session identity, reconciled whenever that SET changes.
 *
 * Extracted verbatim from App. The hook OWNS the two timer bookkeeping refs
 * (`watchers`, `inFlight`) and the memo that derives the open-session set, so
 * both dependency arrays are unchanged. `setActivity` is still App's — the
 * activity cache is read by the row model, which runs before this hook — and
 * the reconcile effect that uses it already carries its `-- <why>` disable.
 *
 * The two effects stay adjacent and in their original order: the second is the
 * first one's unmount-only teardown and must keep running after it.
 */
export function useActivityWatchers({
  rows,
  setActivity,
}: {
  rows: Row[];
  setActivity: React.Dispatch<React.SetStateAction<Map<string, Activity>>>;
}) {
  // Live-poll timers: one setInterval per expanded session identity.
  const watchers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const inFlight = useRef<Set<string>>(new Set());

  // Derive the set of session identities that are currently expanded (and have a
  // log to poll), plus a lookup map and a stable string key for the effect dep.
  const openSessionInfo = useMemo(() => {
    const ids = new Set<string>();
    const lookup = new Map<string, AgentSession>();
    for (const r of rows) {
      if (r.kind === "session" && r.expanded && r.session.logPath) {
        const id = sessionId(r.session);
        ids.add(id);
        lookup.set(id, r.session);
      }
    }
    const key = [...ids].sort().join(",");
    return { openSessionIds: ids, sessionLookup: lookup, key };
  }, [rows]);

  // Reconcile live-poll timers whenever the set of open sessions changes.
  useEffect(() => {
    const { openSessionIds, sessionLookup } = openSessionInfo;
    // Start a timer for each newly-opened session.
    for (const id of openSessionIds) {
      if (watchers.current.has(id)) continue;
      const s = sessionLookup.get(id);
      if (!s) continue;
      const handle = setInterval(async () => {
        if (inFlight.current.has(id)) return;
        inFlight.current.add(id);
        try {
          const a = await loadActivity(s);
          if (!watchers.current.has(id)) return; // timer cleared mid-read
          setActivity((p) => {
            const prev = p.get(id);
            if (sameActivity(prev, a)) return p;
            const next = new Map(p);
            next.set(id, a);
            return next;
          });
        } catch {
          // leave last good data on error
        } finally {
          inFlight.current.delete(id);
        }
      }, POLL_MS);
      watchers.current.set(id, handle);
    }
    // Clear timers for sessions that are no longer open.
    for (const id of watchers.current.keys()) {
      if (!openSessionIds.has(id)) {
        clearInterval(watchers.current.get(id));
        watchers.current.delete(id);
      }
    }
  }, [openSessionInfo.key]); // eslint-disable-line react-hooks/exhaustive-deps -- `.key` is the sorted id digest built above precisely so this reconciles timers when the id SET changes; the object itself changes on every `rows` recompute, which would tear down live timers.

  // Leak-proof teardown: clear all timers when the component unmounts.
  //
  // `watchers.current` is read once into a local rather than in the cleanup. The
  // two are the same object for the component's whole life — `watchers` is a
  // container ref whose `.current` is assigned exactly once, at useRef, and only
  // ever mutated through Map methods — so this is a no-op that also stops the
  // linter warning about a ref read at cleanup time, which is a real hazard for
  // node refs and not for this one.
  useEffect(() => {
    const timers = watchers.current;
    return () => {
      for (const t of timers.values()) clearInterval(t);
      timers.clear();
    };
  }, []);
}
