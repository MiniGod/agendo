import { vocab, type Vocab } from "../vocab.ts";

// Provider-specific terminology for the current model. Set once per render from
// `model.provider` (see App), before any row-building runs — so the module-level
// render helpers that import it (format, rows, targets, components, App) can read
// it without threading it through every call. Safe because rendering is
// synchronous and the launcher menu is a single instance.
export let V: Vocab = vocab("ado");

/** Repoint the shared vocabulary (see `V`) at the current provider's terms. */
export function setVocab(next: Vocab) {
  V = next;
}
