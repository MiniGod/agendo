// Error context and retry classification.
//
// Two problems this solves, both seen in the wild as a launcher stuck on a bare
// `Error: Failed to parse JSON` / "Press r to retry, q to quit":
//
//  1. A JSON decode that fails says nothing about WHAT it was decoding. Bun's
//     `Response.json()` throws literally `Failed to parse JSON`, and
//     `JSON.parse` isn't much better, so an expired-auth HTML login page from
//     Azure DevOps and a corrupt `~/.agendo/state.json` produce the same
//     useless message. Every decode site goes through a helper here that names
//     its source — an absolute file path (plus line number for `.jsonl`), or
//     the HTTP method/URL/status plus a short body snippet.
//
//  2. Nothing distinguishes a failure worth retrying (the network blipped,
//     the backend 503'd) from one that never will (401, 403, 404, a malformed
//     local file). The UI's auto-retry needs that verdict, and getting it wrong
//     — retrying a hard auth failure forever — is worse than not retrying at
//     all. So classification defaults to PERMANENT and only the shapes we
//     recognise as transient opt in.

/** An error we raised ourselves, carrying machine-readable context. */
export interface ContextualError extends Error {
  /** HTTP status this came from, when it came from an HTTP response. */
  status?: number;
  /** Explicit retry verdict. Absent ⇒ classified from `status` (see isRetryable). */
  retryable?: boolean;
}

/** Tag an error with context and return it (so it can be thrown inline). */
export function tag(e: Error, ctx: { status?: number; retryable?: boolean }): ContextualError {
  const t = e as ContextualError;
  if (ctx.status !== undefined) t.status = ctx.status;
  if (ctx.retryable !== undefined) t.retryable = ctx.retryable;
  return t;
}

/** An HTTP response that came back with an error status. */
export function httpError(message: string, status: number): ContextualError {
  return tag(new Error(message), { status });
}

/**
 * A request that never got a response — DNS failure, connection refused, TLS
 * error, timeout, socket hang up. Always worth retrying: the same request may
 * well succeed once the network settles.
 */
export function networkError(message: string, cause: unknown): ContextualError {
  return tag(new Error(`${message}: ${messageOf(cause)}`, { cause }), { retryable: true });
}

/** The message of an unknown thrown value, without the `[object Object]` trap. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * Whether retrying this failure could plausibly succeed.
 *
 * Deliberately conservative: unless we recognise the failure as transient, the
 * answer is no. An auto-retry loop that keeps hammering a 404 (a team with no
 * sprints answers identically on every attempt) or an expired login is a worse
 * bug than the dead-end screen it replaces.
 *
 *   • explicit `retryable` tag  → that verdict, no questions asked
 *   • 408 / 425 / 429 / 5xx     → transient (timeout, too-early, rate limit, server)
 *   • any other status          → permanent (401/403/404 auth & not-found, and
 *                                 a 2xx whose body wasn't JSON at all — the
 *                                 server answered fine, just not with our API,
 *                                 which is what an auth-redirect login page is)
 *   • no status at all          → permanent (an unrecognised local failure)
 */
export function isRetryable(e: unknown): boolean {
  const c = e as ContextualError | undefined;
  if (typeof c?.retryable === "boolean") return c.retryable;
  const status = c?.status;
  if (typeof status !== "number") return false;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

// ── Retry policy ──────────────────────────────────────────────────────────────
// Bounded exponential backoff. The bound is the point: paired with the
// conservative isRetryable above it means a permanent failure (a team with no
// sprints 404ing, an expired login) stops immediately rather than looping, and
// even a genuinely transient one gives up and shows its error instead of
// hammering Azure DevOps or GitHub forever. Both knobs are env-overridable so
// the e2e suite can run the loop without real-time waits.

const DEFAULT_ATTEMPTS = 4; // the initial try plus 3 retries
const DEFAULT_BASE_MS = 1_000; // → waits of 1s, 2s, 4s
const MAX_DELAY_MS = 15_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  // `FOO= agendo` is the shell idiom for "unset this for one command", and
  // Number("") is 0 — so empty counts as absent, not as "zero retries".
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  // 0 IS meaningful (no retries / no wait); only a non-numeric setting falls back.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Total attempts for a retried load (1 initial + N retries). */
export function retryAttempts(): number {
  return Math.max(1, Math.floor(envInt("AGENDO_RETRY_ATTEMPTS", DEFAULT_ATTEMPTS)));
}

/** How long to wait after attempt `attempt` (1-based) before the next one. */
export function retryDelayMs(attempt: number): number {
  const base = envInt("AGENDO_RETRY_BASE_MS", DEFAULT_BASE_MS);
  return Math.min(base * 2 ** Math.max(0, attempt - 1), MAX_DELAY_MS);
}

// ── Non-fatal diagnostics ─────────────────────────────────────────────────────
// A corrupt local file must NOT brick the launcher — a stale cache is exactly
// the thing you want the tool to shrug off, and the data it holds (UI prefs,
// restored tabs) is all re-derivable. So those sites fall back to defaults and
// record here instead of throwing, and the UI surfaces the collected lines as a
// notice. Deduped, since the same file gets read on every reload.

const warnings: string[] = [];
/** Cap on retained *routine* diagnostics (skipped transcript lines). Bounds
 *  memory on a badly corrupted machine. Reset by each drain. */
const MAX_WARNINGS = 20;

/**
 * Record a non-fatal diagnostic for the UI to surface. Deduped by text.
 *
 * `always` opts out of the cap. It marks the diagnostics that are about the
 * launcher's OWN state — a config/state/snapshot file it had to ignore — which
 * must never be crowded out by a run of routine transcript-line skips. The set
 * of such files is small and fixed, so dedup alone bounds that tier.
 */
function reportWarning(message: string, opts: { always?: boolean } = {}): void {
  if (warnings.includes(message)) return;
  if (!opts.always && warnings.length >= MAX_WARNINGS) return;
  warnings.push(message);
}

/**
 * Drain the diagnostics recorded since the last drain.
 *
 * Draining (rather than accumulating) is what keeps the UI notice honest: the
 * caller reports what THIS load ran into, so a file the user has since fixed
 * stops being reported, and a load that hit nothing returns nothing — leaving
 * whatever notice the user was already looking at alone instead of stomping it.
 */
export function takeWarnings(): string[] {
  return warnings.splice(0, warnings.length);
}

// ── JSON decoding, with the source attached ───────────────────────────────────

/** Longest body excerpt we quote back. Enough to recognise `<!DOCTYPE html>`. */
const SNIPPET_CHARS = 200;

/**
 * A short, single-line, quoted excerpt of a response body for an error message.
 * Whitespace is collapsed so a pretty-printed HTML page stays on one line.
 */
function bodySnippet(body: string, limit = SNIPPET_CHARS): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat) return "empty body";
  const cut = flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
  return `body starts: ${JSON.stringify(cut)}`;
}

/**
 * Replace every occurrence of each secret with `***`. Applied to anything we
 * echo back from an authenticated request, so a token can never reach the
 * screen, a log file, or a bug report — we never include the Authorization
 * header itself, and this is the belt-and-braces for a body or URL that
 * happens to contain the same string.
 */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 8) out = out.split(s).join("***");
  }
  return out;
}

/**
 * Read an HTTP response body as JSON, naming the request in any failure:
 *
 *   Failed to parse JSON from GET https://dev.azure.com/… -> 203 Non-Authoritative
 *   Information (body starts: "<!DOCTYPE html><html>…")
 *
 * which is instantly recognisable as an auth redirect to a sign-in page rather
 * than the mystery `Failed to parse JSON` the runtime gives you. The response
 * status rides along on the error so `isRetryable` can classify it, and
 * `secrets` are scrubbed from everything echoed back.
 */
export async function readJsonResponse<T = any>(
  r: Response,
  method: string,
  url: string,
  secrets: readonly string[] = [],
): Promise<T> {
  const safeUrl = scrub(url, secrets);
  let text: string;
  try {
    text = await r.text();
  } catch (cause) {
    // The body stream died mid-read — a dropped connection, worth retrying.
    throw tag(
      new Error(`Failed to read ${method} ${safeUrl} -> ${r.status}: ${messageOf(cause)}`, { cause }),
      { status: r.status, retryable: true },
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    const where = `${method} ${safeUrl} -> ${r.status} ${r.statusText}`.trim();
    // The parser's own message is scrubbed too: Bun/JSC never echoes the input,
    // but V8 embeds ~30 characters around the fault offset — which would be an
    // unscrubbed body excerpt if the runtime ever changed under us.
    const why = scrub(messageOf(cause), secrets);
    throw tag(new Error(`Failed to parse JSON from ${where} (${snippetOf(text, secrets)}): ${why}`, { cause }), {
      status: r.status,
    });
  }
}

/**
 * A scrubbed body excerpt. Scrubbing happens BEFORE truncation and that order is
 * load-bearing: a bearer token is 1–2kB, so a token starting just inside the
 * 200-char window would survive an exact-match scrub applied afterwards — the
 * snippet would hold only a prefix of it, which no longer matches the secret and
 * would be printed verbatim.
 */
export function snippetOf(body: string, secrets: readonly string[] = []): string {
  return bodySnippet(scrub(body, secrets));
}

/** Transcripts already reported for a line skip — see parseJsonLine. */
const warnedTranscripts = new Set<string>();

/**
 * Parse one line of a `.jsonl` file, returning null instead of throwing — a
 * single unreadable record must never cost you the whole transcript.
 *
 * The skip is recorded as a warning naming `path:line`, so a corrupt record in
 * a 50MB transcript is a coordinate rather than a hunt. Pass `isLast` for the
 * file's final line to suppress that: a live agent appending to its transcript
 * routinely leaves a half-written trailing record, which is normal rather than
 * corruption.
 *
 * At most ONE warning per file. Transcripts are re-parsed on the launcher's
 * couple-of-seconds local rescan, and a file with many bad records would
 * otherwise emit one diagnostic per record forever. The first coordinate is
 * what you need to start looking; the rest is noise that would crowd the cap.
 */
export function parseJsonLine(
  text: string,
  path: string,
  line: number,
  opts: { isLast?: boolean } = {},
): any | null {
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!opts.isLast && !warnedTranscripts.has(path)) {
      warnedTranscripts.add(path);
      reportWarning(`Skipped unparseable JSON at ${path}:${line} (${messageOf(e)})`);
    }
    return null;
  }
}

/**
 * Parse an on-disk JSON file's contents, falling back to `fallback` and
 * recording a warning naming the absolute path rather than throwing.
 *
 * Used for the launcher's own state files (`config.json`, `state.json`, the
 * restore snapshots). All of them are caches or preferences: every value is
 * re-derivable and the worst case of ignoring one is a launcher that starts
 * with defaults. Bricking the tool over a stale file — with no message saying
 * which file — is strictly worse, so these are reported-and-ignored.
 */
export function parseJsonFileOr<T>(text: string, path: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    // `always`: this is the launcher's own state, never crowded out by routine
    // transcript-line skips.
    reportWarning(`Ignoring ${path} — it isn't valid JSON (${messageOf(e)}); using defaults.`, { always: true });
    return fallback;
  }
}
