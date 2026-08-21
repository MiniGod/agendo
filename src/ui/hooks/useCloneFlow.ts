import { useEffect, useMemo, useRef, useState } from "react";
import {
  parseRepoUrl,
  cloneDirName,
  findMatchingCheckout,
  freeCloneDest,
  type CloneRun,
} from "../../clone.ts";
import type { Mode } from "../keys/context.ts";

/**
 * The clone step's own state: what the last clone did, the in-flight `git
 * clone`, and where the URL on the prompt would land.
 *
 * Extracted verbatim from App. The hook OWNS all of it — `cloneNote` and its
 * synchronous mirror ref, the `cloneRun` handle, and the `cloneDest`
 * resolution — so both effects keep their dependency arrays unchanged and
 * neither reaches for a setter it did not create. The elapsed-seconds ticker
 * for the cloning screen stays in App: it drives `mode`, which the whole
 * component shares.
 *
 * Called from the position the unmount-cancel effect occupied, so the two
 * effects here keep their place in App's effect order (after the ticker,
 * before the cursor clamp).
 */
export function useCloneFlow({ mode, filterRoot }: { mode: Mode; filterRoot: string | null }) {
  // What the clone step did, carried into the screens that follow it. `notice`
  // is a list-view banner, and a clone hands off directly to the next dialog —
  // without this, "reused the checkout you already had" would be invisible until
  // the user found their way back to the list. Cleared when a fresh flow starts.
  const [cloneNote, setCloneNote] = useState<string | null>(null);
  // The same value, readable synchronously. A PR target routes clone → checkout
  // → launch inside one keystroke, and `open()` overwrites the notice on the way
  // out; without a ref the note set moments earlier would still be the stale
  // render value there, so the PR flow would never report what it cloned.
  const cloneNoteRef = useRef<string | null>(null);
  // The in-flight `git clone`, so esc can cancel it and unmount can't orphan it.
  const cloneRun = useRef<CloneRun | null>(null);

  // Never leave a `git clone` (and its half-written directory) behind on
  // unmount. `immediate` because the child's exit will never be observed here.
  useEffect(() => () => cloneRun.current?.cancel({ immediate: true }), []);

  // What the typed URL means. Two halves, split by cost: parsing is pure string
  // work and belongs in render, but resolving *where it would land* reads the
  // filesystem — an `origin` per sibling checkout (spawned git), a stat per
  // candidate directory. In a folder holding dozens of checkouts that is long
  // enough to see, so it runs in an effect and lands as state: the identity
  // appears the instant you type, the destination a beat later, and the render
  // path never blocks.
  const cloneValue = mode.kind === "clone" ? mode.value : null;
  const cloneUrl = useMemo(
    () => (cloneValue?.trim() ? parseRepoUrl(cloneValue) : null),
    [cloneValue],
  );
  const [cloneDest, setCloneDest] = useState<{ key: string; match: string | null; dest: string | null } | null>(null);
  useEffect(() => {
    // Clearing on the way out matters: leaving the resolution behind would let a
    // later visit to the prompt match it by key and show a pre-clone answer
    // ("clones into …" for a repo that is now on disk) until the effect caught up.
    if (!cloneUrl || !filterRoot) {
      setCloneDest(null);
      return;
    }
    const match = findMatchingCheckout(filterRoot, cloneUrl.key);
    setCloneDest({
      key: cloneUrl.key,
      match,
      dest: match ? null : freeCloneDest(filterRoot, cloneDirName(cloneUrl.repo)),
    });
  }, [cloneUrl, filterRoot]);
  // Only trust a resolution that belongs to the URL currently on screen — the
  // previous one is about a different repo, and a stale destination is worse
  // than none.
  const resolved = cloneUrl && cloneDest?.key === cloneUrl.key ? cloneDest : null;

  return { cloneNote, setCloneNote, cloneNoteRef, cloneRun, cloneUrl, resolved };
}
