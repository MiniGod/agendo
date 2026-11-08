// Running the `gh` CLI. Every GitHub request agendo makes goes through `gh`, so
// it reuses the user's existing `gh auth login` and there is no token handling
// here.
import { spawn } from "child_process";
import { type ContextualError, messageOf, snippetOf, tag } from "../../shared/errors.ts";

/**
 * Whether a failed `gh` run looks worth retrying. `gh` collapses every failure
 * into a non-zero exit, so the only signal is stderr: a 5xx, a rate limit, or a
 * transport-level error can clear on its own, while a 401/403/404 or a bad
 * argument is the same answer every time. Anything unrecognised counts as
 * permanent — see isRetryable on why that's the safe default.
 */
export function transientGhFailure(stderr: string): boolean {
  return /HTTP 5\d\d|\brate limit\b|connection (reset|refused)|timed? ?out|temporary failure|no such host|network is unreachable|EOF\b/i.test(
    stderr,
  );
}

/** Whether a failed `gh` run was refused by GitHub's rate limiter, primary or secondary. */
export function isRateLimited(e: unknown): boolean {
  return /\brate limit/i.test(messageOf(e));
}

/** A failed `gh` run, with whatever JSON it still printed. */
export interface GhError extends ContextualError {
  /** stdout parsed as JSON, when it was JSON: `gh api graphql` prints the whole body even when it exits 1. */
  body?: any;
}

function parsedOrUndefined(out: string): any {
  try {
    return JSON.parse(out);
  } catch {
    return undefined;
  }
}

/**
 * The `data` a GraphQL request returned alongside its `errors`, for a failure
 * that still has some. `gh api graphql` exits 1 whenever the body carries
 * `errors`, even when `data` is filled in. One node GitHub won't show —
 * a SAML-protected org, a repo that has since gone — would otherwise fail
 * the whole answer, so the rest is kept and `onErrors` is told what was
 * left out. A rate limit is never partial: it is rethrown, as is anything
 * with no data.
 */
export function partialData(e: unknown, onErrors: (first: string) => void): any {
  const body = (e as GhError | undefined)?.body;
  if (isRateLimited(e) || !body?.data) throw e;
  onErrors(messageOf(body.errors?.[0]?.message ?? "an unknown error"));
  return body.data;
}

/** Run `gh` and parse its stdout as JSON (null on empty output). */
export function gh(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args);
    // A GraphQL query is kilobytes of text; name it by its first line instead.
    const cmd = `gh ${args.map((a) => a.split("\n")[0]).join(" ")}`;
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject); // couldn't spawn (gh not installed) — never transient
    child.on("close", (code) => {
      if (code !== 0) {
        const failure: GhError = tag(new Error(`${cmd} -> exit ${code}: ${err.trim()}`), { retryable: transientGhFailure(err) });
        failure.body = parsedOrUndefined(out);
        reject(failure);
        return;
      }
      try {
        resolve(out.trim() ? JSON.parse(out) : null);
      } catch (cause) {
        // Name the command AND quote what came back, so `gh` printing an
        // interstitial ("A new release of gh is available…") or an HTML error
        // page is recognisable rather than a bare parse failure.
        reject(
          new Error(`Failed to parse JSON from \`${cmd}\` (${snippetOf(out)}): ${messageOf(cause)}`, { cause }),
        );
      }
    });
  });
}
