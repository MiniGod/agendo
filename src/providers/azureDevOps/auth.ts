// The pure half of the ADO token handling in http.ts: how long a token `az`
// hands us may be cached, and whether a response is ADO refusing it. Kept free
// of env.ts (which reads the config file at import) so test/ can load it bare.

/** Re-mint this long before the token's real expiry, so a request never goes
 *  out on a token that dies in flight. */
export const EXPIRY_MARGIN_MS = 5 * 60_000;
/** How long to trust a token whose expiry we can't read. Short on purpose: an
 *  undecodable token is unusual, and the auth-rejection retry in http.ts
 *  covers a token that dies before this runs out. */
export const FALLBACK_TTL_MS = 5 * 60_000;
/** The least a still-live token is cached for, even inside the margin. Every
 *  cache miss is a blocking `az` spawn, and a load fans out to dozens of
 *  requests — so a token `az` hands back with under 5 minutes left must not
 *  cost one spawn per request. The refusal retry in http.ts covers the rest. */
export const MIN_CACHE_MS = 30_000;

/**
 * The `exp` claim of a JWT, in epoch milliseconds, or null when the token isn't
 * a JWT or has no numeric `exp`. Decoded locally rather than taken from `az`:
 * `expires_on` is None on some az versions and `expiresOn` is a local-time
 * string with no timezone. The signature is not checked — it doesn't need to
 * be, ADO checks it; this only decides when to ask `az` again.
 */
export function jwtExpiryMs(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf-8"));
    const exp = claims?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Until when (epoch ms) a token fetched at `now` may be served from cache: its
 * real expiry minus the margin, but never less than MIN_CACHE_MS from now and
 * never past the expiry itself. So a token already inside the margin is held
 * briefly (or until it dies, if sooner), and an expired one not at all.
 * `refused` marks a token ADO has already turned down.
 */
export function tokenCacheUntil(token: string, now: number, refused = false): number {
  const until = cacheUntilByExpiry(token, now);
  // `az` re-serving a token ADO already refused: hold it only briefly. Long
  // enough that a burst of concurrent refusals costs one `az` spawn, not one
  // each; short enough that `az login` takes effect on the next refresh.
  return refused ? Math.min(until, now + MIN_CACHE_MS) : until;
}

function cacheUntilByExpiry(token: string, now: number): number {
  const exp = jwtExpiryMs(token);
  if (exp === null) return now + FALLBACK_TTL_MS;
  return Math.min(exp, Math.max(now + MIN_CACHE_MS, exp - EXPIRY_MARGIN_MS));
}

// ── The token cache, as pure transitions ─────────────────────────────────────
// http.ts holds one of these and swaps it on every event; the decisions live
// here so test/ can pin them without spawning `az`.

export interface TokenCache {
  cached: { value: string; expiresAt: number } | null;
  /** Every token ADO has refused and not since accepted. `az` can keep serving
   *  one from its own cache (a wrong tenant, a revoked session), and knowing
   *  that is what stops every in-flight request re-spawning `az` for it. */
  refused: ReadonlySet<string>;
}

export const EMPTY_TOKEN_CACHE: TokenCache = { cached: null, refused: new Set() };

/** The cached token if it is still servable at `now`, else null. */
export function cachedTokenAt(c: TokenCache, now: number): string | null {
  return c.cached && now < c.cached.expiresAt ? c.cached.value : null;
}

/** `az` just minted `value`. A token ADO already refused is held only briefly. */
export function withMinted(c: TokenCache, value: string, now: number): TokenCache {
  return { ...c, cached: { value, expiresAt: tokenCacheUntil(value, now, c.refused.has(value)) } };
}

/**
 * ADO refused `token`: remember it, and drop it from the cache so the next ask
 * goes to `az`. Only the FIRST refusal drops it — concurrent requests refused
 * with the same token then share one re-mint, each later one finding either
 * the fresh token already minted or the refused one held briefly, never
 * spawning `az` again on its own.
 */
export function withRefused(c: TokenCache, token: string): TokenCache {
  if (c.refused.has(token)) return c;
  return {
    cached: c.cached?.value === token ? null : c.cached,
    refused: new Set([...c.refused, token]),
  };
}

/**
 * ADO took `token` after all, so it is no longer refused and gets its normal
 * cache lifetime back instead of the brief hold. (A plain 401 counts as a
 * refusal, and ADO answers one for a single resource the user can't see while
 * the token is good everywhere else.)
 */
export function withAccepted(c: TokenCache, token: string, now: number): TokenCache {
  if (!c.refused.has(token)) return c;
  const refused = new Set(c.refused);
  refused.delete(token);
  const cached = c.cached?.value === token ? { value: token, expiresAt: tokenCacheUntil(token, now) } : c.cached;
  return { cached, refused };
}

/**
 * Whether a response that wasn't a refusal shows ADO actually authenticated
 * the token. A transient status (5xx, 429, 408) can come from a gateway in
 * front of ADO and proves nothing about it, so it must not clear a refusal.
 */
export function provesTokenAccepted(status: number): boolean {
  return status < 500 && status !== 429 && status !== 408;
}

/** The parts of a Response that say whether ADO refused the bearer token. */
export interface AuthProbe {
  status: number;
  redirected: boolean;
  /** The FINAL url, after any redirects were followed. */
  url: string;
  contentType: string | null;
}

/**
 * Whether ADO rejected the token. A bad bearer token doesn't 401 on the REST
 * API — it 302s to `/_signin`, and fetch follows that to an HTML sign-in page
 * served as 203 Non-Authoritative Information. Any of these mean "not
 * authenticated", never "here is your JSON":
 *   • 401
 *   • 203 (the sign-in page's status)
 *   • a redirect that landed on a `/_signin` path
 *   • any other 2xx served as HTML — the REST API never answers in HTML
 */
export function isAuthRejection(r: AuthProbe): boolean {
  if (r.status === 401 || r.status === 203) return true;
  if (r.redirected && landedOnSignIn(r.url)) return true;
  return is2xx(r.status) && isHtml(r.contentType);
}

const is2xx = (status: number): boolean => status >= 200 && status < 300;

/** Whether a Content-Type header says HTML. */
export function isHtml(contentType: string | null): boolean {
  return /\btext\/html\b/i.test(contentType ?? "");
}

function landedOnSignIn(url: string): boolean {
  try {
    return /\/_signin(\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** What the user is told once a freshly minted token is refused too. A blank
 *  tenant (none configured) gets a plain `az login` rather than a dangling flag. */
export function authRejectedMessage(where: string, tenant: string): string {
  const login = tenant ? `az login --tenant ${tenant}` : "az login";
  return `Azure DevOps rejected the az token (${where}). Run '${login}' and retry.`;
}
