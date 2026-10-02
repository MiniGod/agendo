import { spawn, spawnSync } from "child_process";
import { httpError, networkError, readJsonResponse, scrub, snippetOf } from "../../shared/errors.ts";
import {
  EMPTY_TOKEN_CACHE,
  authRejectedMessage,
  cachedTokenAt,
  isAuthRejection,
  isHtml,
  provesTokenAccepted,
  withAccepted,
  withMinted,
  withRefused,
  type TokenCache,
} from "./auth.ts";
import { BASE, cfg } from "./env.ts";

// ── Token (cached until shortly before its real expiry) ─────────────────────
// `az` serves its own cached token, which may have minutes left rather than an
// hour, so the cache lifetime comes from the token's `exp` (tokenCacheUntil),
// never from when we happened to fetch it. A token ADO refuses is dropped on
// the spot (withRefused) — `az login` in another terminal then takes effect
// within seconds instead of after a restart.
let tokens: TokenCache = EMPTY_TOKEN_CACHE;

export function getToken(): string {
  const now = Date.now();
  const hit = cachedTokenAt(tokens, now);
  if (hit) return hit;

  const res = spawnSync(
    "az",
    [
      "account", "get-access-token",
      "--tenant", cfg.tenant,
      "--resource", cfg.resource,
      "--query", "accessToken",
      "-o", "tsv",
    ],
    { encoding: "utf-8" },
  );
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(
      `Failed to get Azure DevOps token via az. Are you logged in (az login)?\n${res.stderr ?? ""}`,
    );
  }
  const value = res.stdout.trim();
  tokens = withMinted(tokens, value, now);
  return value;
}

/** A different token to retry with after ADO refused `stale`, or null when
 *  there is none — `az` handed back the very token that was just refused, so
 *  a retry would only be refused again. */
function tokenAfterRefusal(stale: string): string | null {
  tokens = withRefused(tokens, stale);
  const fresh = getToken();
  return fresh === stale ? null : fresh;
}

/** Whether `az` can mint a token for the configured org/tenant right now — the
 *  same call getToken() makes, so it's the accurate "logged in to this org"
 *  probe for the Settings page. Never throws; resolves false on any failure. */
export function checkAuth(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("az", [
      "account", "get-access-token",
      "--tenant", cfg.tenant,
      "--resource", cfg.resource,
      "--query", "accessToken",
      "-o", "tsv",
    ]);
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0 && out.trim().length > 0));
  });
}

// ── Low-level fetch ───────────────────────────────────────────────────────────
// Every echoed string is scrubbed of the bearer token(s) the request carried;
// the Authorization header is never included at all.

type InitFor = (token: string) => RequestInit;

async function send(method: string, url: string, init: RequestInit, secrets: string[]): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (cause) {
    throw networkError(`ADO ${method} ${scrub(url, secrets)}`, cause);
  }
}

function rejected(r: Response): boolean {
  return isAuthRejection({
    status: r.status,
    redirected: r.redirected,
    url: r.url,
    contentType: r.headers.get("content-type"),
  });
}

/**
 * One request, with every failure mode carrying its context:
 *   • no response at all (DNS / refused / TLS / timeout) → tagged retryable
 *   • ADO refusing the token (see isAuthRejection) → the cached token is
 *     dropped, a fresh one minted and the request sent ONCE more (skipped when
 *     `az` hands back the same token). A second refusal, or no new token to
 *     try, is a 401 telling the user to `az login` — never the "Failed to
 *     parse JSON" a sign-in page would otherwise produce, and never cached
 *     for the rest of the process, which is what made a restart the only cure
 *   • an error status → the status rides on the error, so the UI's auto-retry
 *     can tell a 503 (worth another go) from a 401/404 (never will be), plus a
 *     body excerpt: ADO puts the actual explanation there ("VS403496: The team
 *     … does not exist"), and a URL with a bare "404 Not Found" is undiagnosable
 *   • a 2xx whose body isn't JSON → the method, URL, status and a short body
 *     excerpt, instead of the runtime's bare "Failed to parse JSON".
 *
 * Redirects are followed (the default) and the landing classified, rather than
 * `redirect: "manual"` catching the 302: ADO legitimately redirects some REST
 * calls, and only the /_signin landing means the token was refused.
 */
async function adoFetch(
  method: "GET" | "POST",
  url: string,
  initFor: InitFor,
  opts: { allow404?: boolean } = {},
): Promise<any> {
  const first = getToken();
  const r = await send(method, url, initFor(first), [first]);
  if (!rejected(r)) return accepted(r, first, method, url, [first], opts);
  // Drained before re-minting, which can throw (az itself logged out), so the
  // connection returns to the pool either way.
  const refusedBody = await readBody(r);
  const fresh = tokenAfterRefusal(first);
  if (fresh === null) throw authRejectedError(r, refusedBody, method, url, [first]);
  const secrets = [first, fresh];
  const again = await send(method, url, initFor(fresh), secrets);
  if (rejected(again)) {
    // Refused too: drop it now rather than serve it for the rest of its life.
    tokens = withRefused(tokens, fresh);
    throw authRejectedError(again, await readBody(again), method, url, secrets);
  }
  return accepted(again, fresh, method, url, secrets, opts);
}

const readBody = (r: Response): Promise<string> => r.text().catch(() => "");

function accepted(
  r: Response,
  token: string,
  method: string,
  url: string,
  secrets: string[],
  opts: { allow404?: boolean },
): Promise<any> {
  if (provesTokenAccepted(r.status)) tokens = withAccepted(tokens, token, Date.now());
  return readResult(r, method, url, secrets, opts);
}

/** The 401 for a token refused with no fresh one left to try. The body is
 *  echoed only when it isn't the HTML sign-in page — a plain 401 body is where
 *  ADO says why ("TF400813: … not authorized"). */
function authRejectedError(r: Response, body: string, method: string, url: string, secrets: string[]): Error {
  const detail = body && !isHtml(r.headers.get("content-type")) ? ` (${snippetOf(body, secrets)})` : "";
  const where = `${method} ${scrub(url, secrets)} -> ${r.status} ${r.statusText}`.trim();
  return httpError(authRejectedMessage(where, cfg.tenant) + detail, 401);
}

async function readResult(
  r: Response,
  method: string,
  url: string,
  secrets: string[],
  opts: { allow404?: boolean },
): Promise<any> {
  // A tolerated 404 is an ABSENT RESOURCE, i.e. a successful answer of "there
  // isn't one" — so it returns before any error is built, and the auto-retry
  // never sees it. That ordering matters: a 404 is permanent, so retrying the
  // no-sprints case would loop uselessly, which is the bug #21 fixed.
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) {
    // Also drains the body, so the connection returns to the pool.
    const body = await r.text().catch(() => "");
    const detail = body ? ` (${snippetOf(body, secrets)})` : "";
    throw httpError(`ADO ${method} ${scrub(url, secrets)} -> ${r.status} ${r.statusText}${detail}`, r.status);
  }
  return readJsonResponse(r, method, url, secrets);
}

/**
 * GET an ADO endpoint as JSON. `path` may be an absolute URL (the VSSPS/Graph
 * hosts) or a path appended to BASE.
 *
 * `allow404` lets a call site treat "not found" as an absent resource,
 * resolving to `null` instead of throwing. It's opt-in per call: on most
 * endpoints a 404 means a bad project/team/id and must surface as an error.
 */
export async function adoGet(path: string, opts: { allow404?: boolean } = {}): Promise<any> {
  const url = path.startsWith("http") ? path : `${BASE}/${path}`;
  return adoFetch("GET", url, (token) => ({ headers: { Authorization: `Bearer ${token}` } }), opts);
}

export async function adoPost(path: string, body: unknown): Promise<any> {
  const url = `${BASE}/${path}`;
  return adoFetch("POST", url, (token) => ({
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  }));
}

