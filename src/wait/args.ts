// argv → WaitOptions, and the `agendo wait` entry point that runs the result.
import { makeSessionScope, scopeFlagValue } from "../scope.ts";
import { runWait } from "./loop.ts";
import { WAIT_STATES, type WaitOptions, type WaitState } from "./types.ts";

/** Parse a duration like `500ms`, `2s`, `5m`, `1h` (bare number ⇒ seconds); null
 *  if the string is missing or malformed, so the caller can reject it loudly
 *  rather than silently fall back to a default the user didn't ask for. */
export function parseDuration(s: string | undefined): number | null {
  if (!s) return null;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "s").toLowerCase()) {
    case "ms": return n;
    case "s": return n * 1_000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    default: return null;
  }
}

// `--repo`/`--path` appear both as a selector in their own right (scope alone
// picks the set) and as a modifier on the others, which is exactly what they are.

/**
 * Parse `wait`'s argv tail into options. Returns the exit code to use on bad
 * input (printing the reason) rather than exiting, so the whole command is
 * testable in-process.
 */
export function parseWaitArgs(rest: string[], cwd = process.cwd()): WaitOptions | number {
  let all = false;
  let any = false;
  let json = false;
  let prefix: string | undefined;
  let repo: string | undefined;
  let pathArg: string | undefined;
  let state: string | undefined;
  let not: string | undefined;
  let timeoutMs = 120_000;
  let intervalMs = 2_000;
  const ids: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--all") all = true;
    else if (a === "--any") any = true;
    else if (a === "--json") json = true;
    // `--prefix` keeps its raw read: an empty prefix has always meant "match
    // every basename" (i.e. `--all`), so guarding it like the scope flags below
    // would turn a working invocation into an error.
    else if (a === "--prefix") prefix = rest[++i];
    else if (a === "--repo" || a === "--path") {
      const v = scopeFlagValue("wait", a, rest[++i]);
      if (v === null) return 1;
      if (a === "--repo") repo = v;
      else pathArg = v;
    }
    else if (a === "--state") state = rest[++i];
    else if (a === "--not") not = rest[++i];
    else if (a === "--timeout" || a === "--interval") {
      const ms = parseDuration(rest[++i]);
      if (ms === null) {
        console.error(`wait: ${a} needs a duration like 500ms, 2s, 5m, 1h (got "${rest[i] ?? ""}")`);
        return 1;
      }
      if (a === "--timeout") timeoutMs = ms;
      else intervalMs = ms;
    } else if (a === "--") { ids.push(...rest.slice(i + 1)); break; }
    // A session id can't start with `-` (shortId strips non-alphanumerics), so a
    // dashed token here is a mistyped flag. Taking it as an id would report "no
    // session found for --repo=x" and blame the user for a session that never
    // existed, instead of naming the actual mistake. `--` above still escapes.
    else if (a.startsWith("-")) {
      console.error(`wait: unknown argument "${a}"`);
      return 1;
    } else ids.push(a);
  }
  for (const [flag, v] of [["--state", state], ["--not", not]] as const) {
    if (v !== undefined && !WAIT_STATES.includes(v as WaitState)) {
      console.error(`wait: ${flag} must be one of ${WAIT_STATES.join("|")}, got "${v}"`);
      return 1;
    }
  }
  if (state !== undefined && not !== undefined) {
    console.error("wait: use only one of --state / --not");
    return 1;
  }
  return {
    ids, all, any, json, prefix,
    scope: makeSessionScope({ path: pathArg, repo }, cwd),
    state: state as WaitState | undefined,
    not: not as WaitState | undefined,
    timeoutMs, intervalMs,
  };
}

/** Parse argv and run the wait. Returns the process exit code. */
export async function runWaitCli(rest: string[]): Promise<number> {
  const parsed = parseWaitArgs(rest);
  return typeof parsed === "number" ? parsed : runWait(parsed);
}
