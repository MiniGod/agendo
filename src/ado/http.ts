import { spawn, spawnSync } from "child_process";
import { httpError, networkError, readJsonResponse, scrub, snippetOf } from "../errors.ts";
import { BASE, cfg } from "./env.ts";

// ── Token (cached for the process lifetime, refreshed before expiry) ──────────
let cachedToken: { value: string; expiresAt: number } | null = null;

export function getToken(): string {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - now > 60_000) return cachedToken.value;

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
  // Tokens last ~60–90 min; treat as valid for 50 min to be safe.
  cachedToken = { value, expiresAt: now + 50 * 60_000 };
  return value;
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
/** Bearer token(s) to scrub from any error text we surface. The Authorization
 *  header is never echoed; this covers a URL or response body that happens to
 *  contain the same string. */
function tokenSecrets(): string[] {
  return cachedToken ? [cachedToken.value] : [];
}

/**
 * One request, with every failure mode carrying its context:
 *   • no response at all (DNS / refused / TLS / timeout) → tagged retryable
 *   • an error status → the status rides on the error, so the UI's auto-retry
 *     can tell a 503 (worth another go) from a 401/404 (never will be), plus a
 *     body excerpt: ADO puts the actual explanation there ("VS403496: The team
 *     … does not exist"), and a URL with a bare "404 Not Found" is undiagnosable
 *   • a 2xx whose body isn't JSON → the method, URL, status and a short body
 *     excerpt, so an ADO auth redirect to an HTML sign-in page reads as one
 *     instead of as the runtime's bare "Failed to parse JSON".
 * Every echoed string is scrubbed of the bearer token; the Authorization header
 * is never included at all.
 */
async function adoFetch(
  method: "GET" | "POST",
  url: string,
  init: RequestInit,
  opts: { allow404?: boolean } = {},
): Promise<any> {
  const secrets = tokenSecrets();
  const safeUrl = scrub(url, secrets);
  let r: Response;
  try {
    r = await fetch(url, init);
  } catch (cause) {
    throw networkError(`ADO ${method} ${safeUrl}`, cause);
  }
  // A tolerated 404 is an ABSENT RESOURCE, i.e. a successful answer of "there
  // isn't one" — so it returns before any error is built, and the auto-retry
  // never sees it. That ordering matters: a 404 is permanent, so retrying the
  // no-sprints case would loop uselessly, which is the bug #21 fixed.
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) {
    // Also drains the body, so the connection returns to the pool.
    const body = await r.text().catch(() => "");
    const detail = body ? ` (${snippetOf(body, secrets)})` : "";
    throw httpError(`ADO ${method} ${safeUrl} -> ${r.status} ${r.statusText}${detail}`, r.status);
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
  return adoFetch("GET", url, { headers: { Authorization: `Bearer ${getToken()}` } }, opts);
}

export async function adoPost(path: string, body: unknown): Promise<any> {
  const url = `${BASE}/${path}`;
  return adoFetch("POST", url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

