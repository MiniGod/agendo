// The pure decisions `agendo focus` makes: what its argv asks for, and which
// session to bring forward when a PR or work item has several.
import type { AgentSession } from "../../shared/types.ts";
import { isRepo, isSessionToken, itemTarget, parseItemId, type FocusTarget } from "./url.ts";

/** A candidate and the state `list` would report for it. */
export interface FocusCandidate {
  s: AgentSession;
  state: "running" | "paused" | "idle";
  /** For a paused session: the tmux session its placeholder tab sits in, where a resume should put it back. */
  host?: string;
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

const USAGE = "usage: focus --pr <n> [--repo <repo>] | --work-item <n> [--repo <repo>] | <session-id>";

/** The value after a `--pr`/`--work-item` flag as an item id, or the error saying why not. */
function itemFlag(kind: "pr" | "workItem", flag: string, raw: string | undefined): FocusArgs {
  const id = raw === undefined ? null : parseItemId(raw);
  if (id === null) return { ok: false, error: `${flag} needs a positive number (got "${raw ?? ""}")` };
  return { ok: true, target: itemTarget(kind, id, undefined) };
}

/** `--repo` applied to what the rest of argv selected: only a PR or work item takes one, and only a well-formed one. */
function withRepo(found: FocusArgs, repo: string | undefined): FocusArgs {
  if (repo === undefined || !found.ok) return found;
  if (!isRepo(repo)) return { ok: false, error: `--repo needs a repo name or owner/name (got "${repo}")` };
  if (found.target.kind === "session") return { ok: false, error: `--repo goes only with --pr or --work-item\n${USAGE}` };
  return { ok: true, target: itemTarget(found.target.kind, found.target.id, repo) };
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
 * `focus <session-id>` — exactly one of them, and `--repo <repo>` with either of
 * the first two. Strict for the reason
 * `parseSessionArgs` gives: a token nobody recognises is refused, never
 * repurposed, and two selectors are a confused caller rather than a choice.
 */
export function parseFocusArgs(argv: string[]): FocusArgs {
  const at = argv.indexOf("--repo");
  if (at === -1) return parseSelector(argv);
  if (argv.indexOf("--repo", at + 1) !== -1) return { ok: false, error: `give --repo once\n${USAGE}` };
  const repo = argv[at + 1] ?? "";
  return withRepo(parseSelector([...argv.slice(0, at), ...argv.slice(at + 2)]), repo);
}

/** Exactly one selector: `--pr`, `--work-item` or a session id. */
function parseSelector(argv: string[]): FocusArgs {
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
