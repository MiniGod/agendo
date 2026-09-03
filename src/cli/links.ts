import { loadState } from "../config.ts";
import { loadModel, type SessionLink } from "../model.ts";
import { resolveInitialProvider } from "../provider.ts";
import type { AgentSession, Identity, ProviderName } from "../types.ts";
import { flushWarnings } from "./warnings.ts";

/**
 * Model-load options mirroring what the TUI (App.tsx) resolves: the persisted
 * backend (falling back to whichever CLI is installed) and the persisted
 * identity, if any. Used by the association-resolving `list` modes so their
 * gh/az fetch set matches what the menu would show. `forced` is the provider a
 * path context implies (App.tsx passes detectScopeProvider(filterRoot, …) the same
 * way) — the tracker of the `[dir]`'s origin wins over the persisted default.
 */
export function currentModelOptions(forced?: ProviderName | null): { provider: ProviderName; identity: Identity | null } {
  const st = loadState();
  const provider = resolveInitialProvider(st.provider, forced);
  const identity: Identity | null = st.identityId
    ? { id: st.identityId, displayName: st.identityName ?? "?", uniqueName: st.identityUniqueName ?? "" }
    : null;
  return { provider, identity };
}

/**
 * The PR / work item a session links to, resolved through the model's reverse
 * index (`sessionLinks`) — the same association the menu's `o` action opens, so
 * the CLI and the TUI can't drift. Loading the model costs a backend round-trip,
 * hence the opt-in callers. A failed load is returned as `error` rather than
 * thrown, so `status --urls` degrades to a note instead of dying.
 */
export async function resolveSessionLink(
  s: AgentSession,
  /** Command name for any reported-and-ignored load warnings (see flushWarnings). */
  prefix: string,
): Promise<{ link?: SessionLink; provider: ProviderName; error?: string }> {
  const opts = currentModelOptions();
  try {
    const model = await loadModel(opts);
    return { link: model.sessionLinks.get(`${s.source}:${s.id}`), provider: model.provider };
  } catch (e) {
    return { provider: opts.provider, error: (e as Error)?.message ?? String(e) };
  } finally {
    // Whether or not the load succeeded: a corrupt state.json silently drops the
    // persisted backend, which would otherwise resolve links against the wrong
    // one with no hint why. stderr, so `--print` output stays pipeable.
    flushWarnings(prefix);
  }
}

// A link with no resolvable URL reads as absent, never as a
// partial link a human might paste.
function usableLink<T extends { url?: string }>(l: T | undefined): T | undefined {
  return l?.url ? l : undefined;
}

export function usableLinks(link: SessionLink | undefined): { pr: SessionLink["pr"]; workItem: SessionLink["workItem"] } {
  return { pr: usableLink(link?.pr), workItem: usableLink(link?.workItem) };
}
