// The pure half of the ADO token handling (src/providers/azureDevOps/auth.ts).
// The e2e fake `az` mints non-JWT strings, so the JWT-expiry path —
// the one every real token takes — is unreachable from a spec, as is a sign-in
// page reached by a real redirect (the mock server answers 203 directly).
import { describe, expect, test } from "bun:test";
import {
  EMPTY_TOKEN_CACHE,
  EXPIRY_MARGIN_MS,
  FALLBACK_TTL_MS,
  MIN_CACHE_MS,
  authRejectedMessage,
  cachedTokenAt,
  isAuthRejection,
  isHtml,
  provesTokenAccepted,
  jwtExpiryMs,
  tokenCacheUntil,
  withAccepted,
  withMinted,
  withRefused,
} from "../src/providers/azureDevOps/auth.ts";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (claims: unknown) => `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.sig`;

const NOW = 1_800_000_000_000;
const EXP_S = NOW / 1000 + 3600; // an hour from NOW, in JWT seconds

describe("jwtExpiryMs", () => {
  test("reads exp (seconds) as epoch milliseconds", () => {
    expect(jwtExpiryMs(jwt({ exp: EXP_S, aud: "499b84ac" }))).toBe(EXP_S * 1000);
  });

  test("anything that isn't a JWT with a numeric exp is null", () => {
    expect(jwtExpiryMs("fake-ado-token")).toBeNull();
    expect(jwtExpiryMs("")).toBeNull();
    expect(jwtExpiryMs("a.%%%not-base64%%%.c")).toBeNull();
    expect(jwtExpiryMs(`a.${Buffer.from("not json").toString("base64url")}.c`)).toBeNull();
    expect(jwtExpiryMs(jwt({ aud: "x" }))).toBeNull();
    expect(jwtExpiryMs(jwt({ exp: "1800003600" }))).toBeNull();
    expect(jwtExpiryMs(jwt(null))).toBeNull();
  });
});

describe("tokenCacheUntil", () => {
  test("a JWT is cached until its real expiry minus the margin, not a flat lifetime", () => {
    expect(tokenCacheUntil(jwt({ exp: EXP_S }), NOW)).toBe(EXP_S * 1000 - EXPIRY_MARGIN_MS);
    // az handing back its own cached token with 8 minutes left: 3 minutes, not 50.
    const eight = NOW / 1000 + 8 * 60;
    expect(tokenCacheUntil(jwt({ exp: eight }), NOW)).toBe(NOW + 3 * 60_000);
  });

  test("a token inside the margin is held briefly, not re-minted on every request", () => {
    expect(tokenCacheUntil(jwt({ exp: NOW / 1000 + 120 }), NOW)).toBe(NOW + MIN_CACHE_MS);
    // …but never past its own expiry.
    expect(tokenCacheUntil(jwt({ exp: NOW / 1000 + 10 }), NOW)).toBe(NOW + 10_000);
  });

  test("an already-expired token is not cached at all", () => {
    expect(tokenCacheUntil(jwt({ exp: NOW / 1000 - 600 }), NOW)).toBeLessThanOrEqual(NOW);
  });

  test("a token ADO already refused is held only briefly, however long it has left", () => {
    expect(tokenCacheUntil(jwt({ exp: EXP_S }), NOW, true)).toBe(NOW + MIN_CACHE_MS);
    expect(tokenCacheUntil("fake-ado-token", NOW, true)).toBe(NOW + MIN_CACHE_MS);
    // …and still never past its own expiry.
    expect(tokenCacheUntil(jwt({ exp: NOW / 1000 + 10 }), NOW, true)).toBe(NOW + 10_000);
  });

  test("an undecodable token falls back to a short TTL", () => {
    expect(tokenCacheUntil("fake-ado-token", NOW)).toBe(NOW + FALLBACK_TTL_MS);
  });
});

describe("isAuthRejection", () => {
  const ok = { status: 200, redirected: false, url: "https://dev.azure.com/o/_apis/wit/wiql", contentType: "application/json; charset=utf-8" };

  test("a normal JSON answer, and ordinary errors, are not auth rejections", () => {
    expect(isAuthRejection(ok)).toBe(false);
    expect(isAuthRejection({ ...ok, status: 404 })).toBe(false);
    expect(isAuthRejection({ ...ok, status: 403 })).toBe(false);
    expect(isAuthRejection({ ...ok, status: 503, contentType: "text/html" })).toBe(false);
    expect(isAuthRejection({ ...ok, contentType: null })).toBe(false);
  });

  test("401 and the sign-in page's 203 are rejections whatever the body type", () => {
    expect(isAuthRejection({ ...ok, status: 401 })).toBe(true);
    expect(isAuthRejection({ ...ok, status: 203, contentType: "application/json" })).toBe(true);
  });

  test("a redirect that landed on /_signin is a rejection; any other redirect is not", () => {
    const signin = "https://dev.azure.com/o/_signin?realm=dev.azure.com&reason=Unauthorized";
    expect(isAuthRejection({ ...ok, redirected: true, url: signin, contentType: "application/json" })).toBe(true);
    expect(isAuthRejection({ ...ok, redirected: true, url: "https://dev.azure.com/o/_signin/x" })).toBe(true);
    expect(isAuthRejection({ ...ok, redirected: true, url: "https://dev.azure.com/o/_apis/projects" })).toBe(false);
    expect(isAuthRejection({ ...ok, redirected: true, url: "https://dev.azure.com/o/_signinx" })).toBe(false);
    expect(isAuthRejection({ ...ok, redirected: true, url: "not a url" })).toBe(false);
    // The path alone, without a redirect, is not the signal.
    expect(isAuthRejection({ ...ok, url: signin })).toBe(false);
  });

  test("a 2xx served as HTML is a rejection — the REST API never answers in HTML", () => {
    expect(isAuthRejection({ ...ok, contentType: "text/html; charset=utf-8" })).toBe(true);
    expect(isAuthRejection({ ...ok, status: 204, contentType: "TEXT/HTML" })).toBe(true);
    expect(isAuthRejection({ ...ok, contentType: "text/plain" })).toBe(false);
  });
});

test("isHtml reads a Content-Type header, parameters and case notwithstanding", () => {
  expect(isHtml("text/html")).toBe(true);
  expect(isHtml("Text/HTML; charset=utf-8")).toBe(true);
  expect(isHtml("application/json")).toBe(false);
  expect(isHtml("application/xhtml+xml")).toBe(false);
  expect(isHtml(null)).toBe(false);
});

test("authRejectedMessage names the request and the exact az login to run", () => {
  const msg = authRejectedMessage("POST https://x/_apis/wit/wiql -> 203 Non-Authoritative Information", "tid-123");
  expect(msg).toContain("Azure DevOps rejected the az token");
  expect(msg).toContain("POST https://x/_apis/wit/wiql -> 203");
  expect(msg).toContain("Run 'az login --tenant tid-123' and retry.");
  expect(authRejectedMessage("GET x -> 401", "")).toContain("Run 'az login' and retry.");
});

describe("the token cache transitions", () => {
  const T1 = jwt({ exp: EXP_S, n: 1 });
  const T2 = jwt({ exp: EXP_S, n: 2 });
  const minted = withMinted(EMPTY_TOKEN_CACHE, T1, NOW);

  test("a minted token is served until its cache lifetime, then not", () => {
    expect(cachedTokenAt(EMPTY_TOKEN_CACHE, NOW)).toBeNull();
    expect(cachedTokenAt(minted, NOW)).toBe(T1);
    expect(cachedTokenAt(minted, tokenCacheUntil(T1, NOW) - 1)).toBe(T1);
    expect(cachedTokenAt(minted, tokenCacheUntil(T1, NOW))).toBeNull();
  });

  test("a refusal drops the token from the cache — only the first time", () => {
    const refused = withRefused(minted, T1);
    expect(cachedTokenAt(refused, NOW)).toBeNull();
    expect(refused.refused.has(T1)).toBe(true);
    // az re-serves it: held briefly, and a second refusal of the same token
    // (a concurrent request) does NOT drop it again — that would be one az
    // spawn per in-flight request.
    const reserved = withMinted(refused, T1, NOW);
    expect(reserved.cached?.expiresAt).toBe(NOW + MIN_CACHE_MS);
    expect(withRefused(reserved, T1)).toBe(reserved);
  });

  test("refusing a token that isn't the cached one leaves the cache alone", () => {
    const fresh = withMinted(withRefused(minted, T1), T2, NOW);
    const late = withRefused(fresh, T1);
    expect(cachedTokenAt(late, NOW)).toBe(T2);
    expect(withRefused(fresh, T2).cached).toBeNull();
    expect(withRefused(fresh, T2).refused).toEqual(new Set([T1, T2]));
  });

  test("an accepted token is no longer refused and gets its full lifetime back", () => {
    const held = withMinted(withRefused(minted, T1), T1, NOW);
    const later = NOW + 10_000;
    const ok = withAccepted(held, T1, later);
    expect(ok.refused.has(T1)).toBe(false);
    expect(ok.cached?.expiresAt).toBe(tokenCacheUntil(T1, later));
    // Accepting a token nobody refused is a no-op, and accepting a refused one
    // that isn't cached leaves the cache untouched.
    expect(withAccepted(minted, T1, later)).toBe(minted);
    const other = withMinted(withRefused(minted, T1), T2, NOW);
    expect(withAccepted(other, T1, later).cached).toBe(other.cached);
  });
});

test("only a non-transient answer proves ADO accepted the token", () => {
  for (const status of [200, 204, 400, 403, 404, 409]) expect(provesTokenAccepted(status)).toBe(true);
  for (const status of [408, 429, 500, 502, 503]) expect(provesTokenAccepted(status)).toBe(false);
});
