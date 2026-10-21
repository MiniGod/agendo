// The pure decisions `agendo focus` makes: what its argv asks for, and which
// session to bring forward when a PR or work item has several.
import type { AgentSession } from "../../shared/types.ts";
import { isSessionToken, parseItemId, type FocusTarget } from "./url.ts";

/** A candidate and the state `list` would report for it. */
export interface FocusCandidate {
  s: AgentSession;
  state: "running" | "paused" | "idle";
}

/**
 * The session to focus: the most recently active RUNNING one, else the most
 * recently active of the rest. Running wins outright because focusing it costs
 * nothing, while anything else has to be resumed — and resuming a second agent
 * for a PR that already has one live would be the surprise here.
 */
export function pickSession(cands: FocusCandidate[]): FocusCandidate | null {
  const pool = cands.some((c) => c.state === "running") ? cands.filter((c) => c.state === "running") : cands;
  let best: FocusCandidate | null = null;
  for (const c of pool) if (!best || c.s.lastUsed.getTime() > best.s.lastUsed.getTime()) best = c;
  return best;
}

export type FocusArgs = { ok: true; target: FocusTarget } | { ok: false; error: string };

const USAGE = "usage: focus --pr <n> | --work-item <n> | <session-id>";

/** The value after a `--pr`/`--work-item` flag as an item id, or the error saying why not. */
function itemFlag(kind: "pr" | "workItem", flag: string, raw: string | undefined): FocusArgs {
  const id = raw === undefined ? null : parseItemId(raw);
  if (id === null) return { ok: false, error: `${flag} needs a positive number (got "${raw ?? ""}")` };
  return { ok: true, target: { kind, id } as FocusTarget };
}

/** One argv token, read against what has been parsed so far. */
function readToken(argv: string[], i: number): { args: FocusArgs; used: number } {
  const a = argv[i];
  if (a === "--pr") return { args: itemFlag("pr", a, argv[i + 1]), used: 2 };
  if (a === "--work-item" || a === "--wi" || a === "--issue") return { args: itemFlag("workItem", a, argv[i + 1]), used: 2 };
  if (a.startsWith("-")) return { args: { ok: false, error: `unknown argument "${a}"` }, used: 1 };
  if (!isSessionToken(a)) return { args: { ok: false, error: `"${a}" is not a session id` }, used: 1 };
  return { args: { ok: true, target: { kind: "session", token: a } }, used: 1 };
}

/**
 * `focus --pr <n>`, `focus --work-item <n>` (alias `--issue`, `--wi`) or
 * `focus <session-id>` — exactly one of them. Strict for the reason
 * `parseSessionArgs` gives: a token nobody recognises is refused, never
 * repurposed, and two selectors are a confused caller rather than a choice.
 */
export function parseFocusArgs(argv: string[]): FocusArgs {
  let found: FocusArgs | null = null;
  for (let i = 0; i < argv.length; ) {
    const { args, used } = readToken(argv, i);
    if (!args.ok) return args;
    if (found) return { ok: false, error: `give exactly one of --pr, --work-item or a session id\n${USAGE}` };
    found = args;
    i += used;
  }
  return found ?? { ok: false, error: USAGE };
}
