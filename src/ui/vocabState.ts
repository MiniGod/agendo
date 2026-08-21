import { vocab, type Vocab } from "../vocab.ts";

// Provider-specific terminology for the current model, so the module-level
// render helpers that import it (format, rows, targets, components, keys, App)
// can read it without threading it through every call. That matters because
// several of them — the `rows.ts` builders, the key handlers — are not
// components and cannot take a React context; passing it explicitly would mean
// another parameter on signatures that already carry ten.
//
// Written by `useModelLoader`, immediately before it publishes the model the
// terms describe, and nowhere else. It deliberately does NOT get written during
// render: React may begin a render and discard it, which would leave this
// pointing at a provider that is not on screen. Updating it alongside `model`
// in the same tick keeps the two in step without depending on render timing.
//
// This is TUI-only state. The CLI derives its own vocabulary per call
// (`linkVocab(provider)` in src/index.tsx), so nothing here affects it.
export let V: Vocab = vocab("ado");

/** Repoint the shared vocabulary (see `V`) at the current provider's terms. */
export function setVocab(next: Vocab) {
  V = next;
}
