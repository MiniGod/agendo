// How often agendo may ask GitHub, and what it does when GitHub says no.
//
// The GraphQL budget is 5000 points an hour per account, shared by everything
// the user runs. A load used to spend it as fast as it was asked to: `agendo
// web` reloads every tab's board every minute, and each reload re-ran every
// search, so the budget was gone within the hour and every list came back
// silently empty for the rest of it. So:
//
//  - A result is reused for TTL_MS, by every caller in the process: the three
//    fetches of one load, every root `agendo web` reloads, and every reload in
//    the menu that is not an explicit refresh (`invalidate`).
//  - Callers that arrive while a fetch is running wait for that fetch rather
//    than starting their own.
//  - A rate-limited fetch closes the gate until GitHub's reset time (read from
//    `gh api rate_limit`, which costs nothing). Until then no request is made:
//    the last result is served with a warning saying so, or, with nothing to
//    serve, the load fails saying until when. A secondary limit has no reset
//    time to read, so it backs off instead, doubling from a minute to fifteen.
import { reportWarning, tag } from "../../shared/errors.ts";
import { isRateLimited } from "./gh.ts";

export const TTL_MS = 5 * 60_000;
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

export interface ThrottleDeps<T> {
  /** The request itself, for one key. */
  fetch: (key: string) => Promise<T>;
  /** When the exhausted budget resets (epoch ms), or null when it is not the primary budget that ran out. */
  resetAt: () => Promise<number | null>;
  now?: () => number;
}

/** A clock time as the user reads it: local, 24-hour, HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export class Throttle<T> {
  private readonly entries = new Map<string, { value: T; at: number; stale: boolean }>();
  private readonly inflight = new Map<string, Promise<T>>();
  private blockedUntil = 0;
  private backoffMs = 0;
  private readonly now: () => number;

  constructor(private readonly deps: ThrottleDeps<T>) {
    this.now = deps.now ?? Date.now;
  }

  /** The value for `key`: cached while fresh, shared while in flight, the last one while rate limited. */
  get(key: string): Promise<T> {
    const entry = this.entries.get(key);
    if (entry && !entry.stale && this.now() - entry.at < TTL_MS) return Promise.resolve(entry.value);
    if (this.now() < this.blockedUntil) return Promise.resolve().then(() => this.limited(key));
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.deps.fetch(key)
      .then((value) => this.stored(key, value), (e) => this.failed(key, e))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Make the next `get` ask GitHub again. Keeps the last value to fall back on, and never opens a closed gate. */
  invalidate(): void {
    for (const entry of this.entries.values()) entry.stale = true;
  }

  private stored(key: string, value: T): T {
    this.backoffMs = 0;
    this.entries.set(key, { value, at: this.now(), stale: false });
    return value;
  }

  private async failed(key: string, e: unknown): Promise<T> {
    if (!isRateLimited(e)) throw e;
    const reset = await this.deps.resetAt().catch(() => null);
    if (reset !== null && reset > this.now()) {
      this.blockedUntil = reset;
    } else {
      this.backoffMs = Math.min(Math.max(MIN_BACKOFF_MS, this.backoffMs * 2), MAX_BACKOFF_MS);
      this.blockedUntil = this.now() + this.backoffMs;
    }
    return this.limited(key);
  }

  /** The last value with a warning, or — with none to serve — an error naming the reset time. */
  private limited(key: string): T {
    const until = clock(this.blockedUntil);
    const entry = this.entries.get(key);
    if (!entry) throw tag(new Error(`GitHub rate limited until ${until}`), { retryable: false });
    reportWarning(`GitHub rate limited until ${until} — showing data from ${clock(entry.at)}`, { always: true });
    return entry.value;
  }
}
