import { PROVIDER_INFO } from "../provider.ts";
import type { Identity, ProviderName } from "../types.ts";
import type { Mode } from "./keys/context.ts";

/** What picking `name` in the provider picker means, given what is installed and current. */
export type ProviderSwitch =
  | { kind: "unavailable"; notice: string }
  | { kind: "same" }
  | { kind: "switch" };

/** The auth hint for a backend whose CLI is not installed. */
export function unavailableNotice(name: ProviderName): string {
  const info = PROVIDER_INFO.find((p) => p.name === name);
  return `${info?.label ?? name} unavailable — ${info?.authHint ?? "CLI not installed"}`;
}

export function providerSwitch(name: ProviderName, current: ProviderName, available: ReadonlySet<ProviderName>): ProviderSwitch {
  if (!available.has(name)) return { kind: "unavailable", notice: unavailableNotice(name) };
  if (name === current) return { kind: "same" };
  return { kind: "switch" };
}

/**
 * Switching backend from the provider picker.
 *
 * Same shape as `makeCloneActions`: plain closures over App's setters, no
 * hooks. Only to an INSTALLED backend. A real switch clears the
 * (provider-specific) identity override so the new backend's own "me" is
 * used, resets scroll/search, persists the choice, and always lands on the
 * list so you see the new backend's data reload. Picking an uninstalled
 * backend just surfaces its auth hint (back on `fallback`); picking the
 * current one is a no-op.
 */
export function makeProviderActions({
  provider,
  available,
  setProvider,
  setIdentity,
  persist,
  setCursor,
  clearSearch,
  setMode,
  setNotice,
}: {
  provider: ProviderName;
  available: ReadonlySet<ProviderName>;
  setProvider: (p: ProviderName) => void;
  setIdentity: (i: Identity | null) => void;
  persist: (next: { provider: ProviderName; identity: null }) => void;
  setCursor: (c: number) => void;
  clearSearch: () => void;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
}) {
  function switchTo(name: ProviderName): void {
    setProvider(name);
    setIdentity(null); // ADO identity ids are meaningless on GitHub and vice-versa
    persist({ provider: name, identity: null });
    setCursor(0);
    clearSearch();
    setMode({ kind: "list" });
  }

  function stayOn(fallback: Mode, next: ProviderSwitch): void {
    setMode(fallback);
    if (next.kind === "unavailable") setNotice(next.notice);
  }

  function applyProvider(name: ProviderName, fallback: Mode): void {
    const next = providerSwitch(name, provider, available);
    if (next.kind === "switch") switchTo(name);
    else stayOn(fallback, next);
  }

  return { applyProvider };
}
