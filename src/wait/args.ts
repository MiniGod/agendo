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
  // The regex admits exactly these units, so the lookup cannot miss.
  return Number(m[1]) * UNIT_MS[(m[2] ?? "s").toLowerCase() as keyof typeof UNIT_MS];
}

const UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;

// `--repo`/`--path` appear both as a selector in their own right (scope alone
// picks the set) and as a modifier on the others, which is exactly what they are.

/** The options as they accumulate over the argv, before the scope is built. */
interface WaitDraft {
  all: boolean;
  any: boolean;
  json: boolean;
  prefix?: string;
  repo?: string;
  pathArg?: string;
  state?: string;
  not?: string;
  timeoutMs: number;
  intervalMs: number;
  ids: string[];
}

/** A flag that takes the next token: applies it, or prints why not and returns 1. */
type ValueSetter = (d: WaitDraft, flag: string, v: string | undefined) => 1 | undefined;

function setScope(d: WaitDraft, flag: string, v: string | undefined): 1 | undefined {
  const value = scopeFlagValue("wait", flag, v);
  if (value === null) return 1;
  if (flag === "--repo") d.repo = value;
  else d.pathArg = value;
  return undefined;
}

function setDuration(d: WaitDraft, flag: string, v: string | undefined): 1 | undefined {
  const ms = parseDuration(v);
  if (ms === null) {
    console.error(`wait: ${flag} needs a duration like 500ms, 2s, 5m, 1h (got "${v ?? ""}")`);
    return 1;
  }
  if (flag === "--timeout") d.timeoutMs = ms;
  else d.intervalMs = ms;
  return undefined;
}

const TOGGLES: Record<string, "all" | "any" | "json"> = { "--all": "all", "--any": "any", "--json": "json" };

const VALUE_FLAGS: Record<string, ValueSetter> = {
  // `--prefix` keeps its raw read: an empty prefix has always meant "match
  // every basename" (i.e. `--all`), so guarding it like the scope flags would
  // turn a working invocation into an error.
  "--prefix": (d, _flag, v) => void (d.prefix = v),
  "--state": (d, _flag, v) => void (d.state = v),
  "--not": (d, _flag, v) => void (d.not = v),
  "--repo": setScope,
  "--path": setScope,
  "--timeout": setDuration,
  "--interval": setDuration,
};

/** A bare token is a session id — unless it is dashed, which is a mistyped flag. */
function takePositional(d: WaitDraft, a: string): 1 | undefined {
  // A session id can't start with `-` (shortId strips non-alphanumerics), so a
  // dashed token here is a mistyped flag. Taking it as an id would report "no
  // session found for --repo=x" and blame the user for a session that never
  // existed, instead of naming the actual mistake. `--` still escapes.
  if (a.startsWith("-")) {
    console.error(`wait: unknown argument "${a}"`);
    return 1;
  }
  d.ids.push(a);
  return undefined;
}

/** `--state` and `--not` must each name a state, and not both be given. */
function checkStates(state: string | undefined, not: string | undefined): 1 | undefined {
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
  return undefined;
}

/**
 * One token of the argv: a toggle, `--` (everything after it is an id), a
 * value flag with the token after it, or a positional. Returns the index to
 * resume at, or -1 once a refusal has been printed.
 */
function takeToken(d: WaitDraft, rest: string[], i: number): number {
  const a = rest[i]!;
  const toggle = TOGGLES[a];
  if (toggle) {
    d[toggle] = true;
    return i + 1;
  }
  if (a === "--") {
    d.ids.push(...rest.slice(i + 1));
    return rest.length;
  }
  const set: ValueSetter | undefined = VALUE_FLAGS[a];
  const err = set ? set(d, a, rest[i + 1]) : takePositional(d, a);
  if (err) return -1;
  return set === undefined ? i + 1 : i + 2;
}

/**
 * Parse `wait`'s argv tail into options. Returns the exit code to use on bad
 * input (printing the reason) rather than exiting, so the whole command is
 * testable in-process.
 */
export function parseWaitArgs(rest: string[], cwd = process.cwd()): WaitOptions | number {
  const d: WaitDraft = { all: false, any: false, json: false, timeoutMs: 120_000, intervalMs: 2_000, ids: [] };
  for (let i = 0; i < rest.length; ) {
    i = takeToken(d, rest, i);
    if (i < 0) return 1;
  }
  if (checkStates(d.state, d.not)) return 1;
  const { ids, all, any, json, prefix, repo, pathArg, state, not, timeoutMs, intervalMs } = d;
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
