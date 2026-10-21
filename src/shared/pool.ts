// Bounded-concurrency fan-out for the session index's per-file work.
//
// A plain `Promise.all(files.map(read))` starts every read at once, so the
// index's peak memory scaled with the number of transcripts on disk — every
// buffer in flight at the same moment. Here at most `limit` calls run at a
// time, so the peak is bounded by `limit`, not by the size of the store.

/** How many transcripts one provider reads at once while indexing. */
export const INDEX_CONCURRENCY = 8;

/**
 * Run `fn` over every item with at most `limit` calls in flight. Resolves once
 * all of them have settled. The first rejection rejects the run at once (as
 * `Promise.all` would); the other workers finish their current item but start
 * no new ones.
 */
export async function forEachPooled<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failed = true;
        throw e;
      }
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, worker));
}
