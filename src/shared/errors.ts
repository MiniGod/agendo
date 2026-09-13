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
 * Forget which transcripts have already warned.
 *
 * Exists for tests. The one-warning-per-file cap is deliberately process-wide
 * and has no expiry — that is what makes it a cap — but a suite that asserts on
 * warnings needs each case to start from a clean slate, and without this a
 * second test naming a path some earlier test already used would not fail, it
 * would silently assert nothing. Not called from the application.
 */
export function resetTranscriptWarnings(): void {
  warnedTranscripts.clear();
}

/** The last non-whitespace character before `i`, or "" at the start of input. */
function charBefore(text: string, i: number): string {
  let j = i - 1;
  // Exactly RFC 8259's whitespace: space, tab, LF, CR.
  while (j >= 0 && (text[j] === " " || text[j] === "\t" || text[j] === "\r" || text[j] === "\n")) j--;
  return j >= 0 ? text[j] : "";
}

/**
 * Recover the last complete record from a line holding more than one.
 *
 * Two agents appending to the same transcript can interleave: one write is cut
 * short and the next is appended straight onto its stump, with no newline
 * between them. Observed in the wild as a 4,799-byte line holding a record
 * truncated mid-signature followed by a complete, perfectly parseable one. The
 * whole line fails `JSON.parse`, and dropping it costs BOTH records — so the
 * intact one is thrown away along with the damaged one it got stuck to. This
 * gets it back: a torn append should cost one record, not two.
 *
 * The boundary is found by trying, not by matching. Every plausible record
 * start — `{` followed by a quoted key — is a CANDIDATE, and a candidate is
 * accepted only when the text from there to end-of-line parses. That is what
 * makes it safe without knowing the record shape, which matters because we do
 * not have one shape: Claude transcripts alone start on `parentUuid` (114k
 * records) or `type` (55k), and copilot `events.jsonl` and a workflow's
 * `journal.jsonl` come through here too. Anchoring on a known first key would
 * be wrong for three of the four readers.
 *
 * Splitting on `}{` would be wrong for a different reason: it is not where the
 * damage is. The specimen's truncated record ends mid-base64, so there is no
 * `}` before the join at all — the naive split finds nothing here, while
 * legitimately occurring inside every nested object it would find plenty.
 *
 * PARSING IS NOT ENOUGH ON ITS OWN, and this is the trap the first cut of this
 * function fell into. A record truncated just after one of its own nested
 * objects closes leaves that object as the rightmost thing on the line, and it
 * parses perfectly — so a plain try-parse hands back
 * `{"web_search_requests":0,"web_fetch_requests":0}` and calls a mangled line
 * recovered. That is worse than dropping it: the reader gets a non-record, and
 * the diagnostic that would have named the damage is suppressed. Truncating
 * 400 real records at every one of 1,131,454 byte offsets produced 1,587 such
 * bogus recoveries.
 *
 * So a candidate must also sit where a NEW record could start. Inside one
 * well-formed record every `{` other than the root is a VALUE, and a value can
 * only follow `:`, `,` or `[`. Filtering on that one character takes the same
 * 1,131,454-offset sweep to ZERO bogus recoveries, and cuts the specimen's ten
 * candidates to exactly one.
 *
 * What that filter costs, stated honestly: `:`, `,` and `[` are ~4.5% of the
 * bytes in a real record, so a write severed immediately after one of them is
 * a join the filter refuses to see. Measured over torn-append pairs built from
 * real records, ~5% of severance points are lost this way. They degrade to the
 * pre-change behaviour — null, and a warning — never to a wrong answer, which
 * is the trade being made: a missed recovery is a line we already failed on,
 * while a wrong recovery is a non-record handed to a reader in silence.
 *
 * (A brace-depth scan would be the textbook answer and does not work here: the
 * stump is severed mid-string, so a forward walk takes the next record's first
 * quote as its own string terminator and desynchronises. On the specimen it
 * reports one top-level record, at offset 0, and finds no boundary at all.)
 *
 * The walk runs right-to-left purely for COST, not for correctness: at most one
 * candidate can parse — any candidate left of the true boundary has that whole
 * record sitting after it as trailing data, which `JSON.parse` rejects — so the
 * answer does not depend on the direction. Starting at the right just reaches
 * it sooner and on shorter slices. There is no attempt cap: a filter-surviving
 * candidate inside the tail record is a `{` at the end of a string value, and
 * parsing from there is permanently out of phase, so it fails almost
 * immediately. The largest real-shaped truncated line (1.6MB) costs 1.4ms, and
 * a wholly synthetic 2.12MB line of 40,000 concatenated stumps — none of them
 * recoverable, so every candidate is tried — costs ~33ms.
 *
 * Only the LAST record is recovered. A stump ahead of it is unrecoverable by
 * definition, and several torn writes in a row are handled by the same walk,
 * each unparseable stump simply skipped over. Two cases are genuinely
 * forfeited: a write severed at exactly its trailing newline, leaving two
 * intact records joined, and a three-way interleave where an intact record sits
 * between two damaged ones. Both lose a record that was on the line whole. The
 * first is a single-byte target in a multi-kilobyte record; neither appears in
 * the wild sample, and recovering them would mean re-parsing every prefix.
 *
 * One more thing this accepts by design: it cannot tell a stump from any other
 * unparseable prefix, so `garbage {"type":"assistant",…}` recovers the record
 * and stays quiet about the garbage. The intact record is worth more than the
 * diagnostic, and there is no signal here that would separate the two.
 */
function recoverTornLine(text: string): any | null {
  const starts: number[] = [];
  const candidate = /\{\s*"/g;
  for (let m = candidate.exec(text); m; m = candidate.exec(text)) {
    // Offset 0 is the whole line, which the caller has already tried.
    if (m.index === 0) continue;
    // A `{` in value position belongs to the record already in progress.
    const prev = charBefore(text, m.index);
    if (prev === ":" || prev === "," || prev === "[") continue;
    starts.push(m.index);
  }
  for (let i = starts.length - 1; i >= 0; i--) {
    try {
      // Anchored on `{`, so a successful parse is necessarily an object.
      return JSON.parse(text.slice(starts[i]));
    } catch {
      // Not a boundary — keep walking left.
    }
  }
  return null;
}

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
 * Note what that dedup means for anyone reading a report: a warning that
 * disappears when you reload and comes back on a fresh start is the CAP
 * talking, not the file healing itself.
 *
 * A line that fails outright gets one more chance through `recoverTornLine`,
 * which pulls the intact record out of a torn append. Recovery is silent: the
 * record is back, nothing was lost, and there is nothing for the user to act
 * on — a diagnostic there would be noise about a problem that just got fixed.
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
    const recovered = recoverTornLine(text);
    if (recovered !== null) return recovered;
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
