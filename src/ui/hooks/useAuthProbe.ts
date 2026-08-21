import { useEffect, useState } from "react";
import { getProvider, PROVIDER_INFO } from "../../provider.ts";
import type { Mode } from "../keys/context.ts";
import type { ProviderName } from "../../types.ts";

/**
 * Per-backend auth status for the Settings page.
 *
 * Extracted verbatim from App: the hook OWNS `authStatus` (nothing outside the
 * probe ever wrote it, and only the Settings screen reads it), and the effect
 * keeps its `[mode.kind]` dependency array and its `-- <why>` disable comment
 * unchanged. Called from the position the effect occupied, so effect order is
 * untouched.
 */
export function useAuthProbe({ mode, available }: { mode: Mode; available: Set<ProviderName> }) {
  // Per-backend auth status for the Settings page: absent ⇒ not yet probed,
  // "checking" ⇒ probe in flight, boolean ⇒ result. Refreshed each time the
  // Settings page opens (auth can change out from under us between opens).
  const [authStatus, setAuthStatus] = useState<Map<ProviderName, "checking" | boolean>>(new Map());

  // Probe each backend's auth status whenever the Settings page opens. Not-
  // installed backends resolve to false immediately (no CLI to ask); installed
  // ones show "checking" until their async probe lands.
  useEffect(() => {
    if (mode.kind !== "settings") return;
    let cancelled = false;
    for (const info of PROVIDER_INFO) {
      if (!available.has(info.name)) {
        setAuthStatus((m) => new Map(m).set(info.name, false));
        continue;
      }
      setAuthStatus((m) => new Map(m).set(info.name, "checking"));
      getProvider(info.name)
        .checkAuth()
        .then((ok) => !cancelled && setAuthStatus((m) => new Map(m).set(info.name, ok)))
        .catch(() => !cancelled && setAuthStatus((m) => new Map(m).set(info.name, false)));
    }
    return () => {
      cancelled = true;
    };
  }, [mode.kind]); // eslint-disable-line react-hooks/exhaustive-deps -- probe-on-open, not a subscription: keyed to entering the Settings page. Adding `available` re-probes every backend each time that map is rebuilt.

  return authStatus;
}
