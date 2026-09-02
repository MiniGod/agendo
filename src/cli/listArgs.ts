// The argv of `list` and its subcommands, parsed apart from running them.
//
// `list` is three commands behind one word — the session list, the resource
// lists (`list prs`, `list issues`) and `list repos` — each with its own flag
// set, and the parse of all three used to sit in one function in dispatch.ts.
// Here each is a small pure parser over an argv tail, so every arm can be read
// beside the one next to it and refused inputs are assertions in test/, not
// ends of the process. Nothing here runs a listing; dispatch.ts does that.

import { duplicatePathScope, requireDuration, requireValue, unknownArgument } from "./args.ts";

const PR_SUBS = new Set(["pr", "prs"]);
const ISSUE_SUBS = new Set(["issue", "issues", "wi", "work-item", "work-items", "workitem", "workitems"]);
const REPO_SUBS = new Set(["repo", "repos"]);

/**
 * Which of the three listings `list <sub>` names. Only the exact keywords
 * route; any other non-dash positional falls through to the session list's
 * `[dir]` path filter, and the dashed `--pr`/`--issue` stay session-list query
 * flags.
 */
export type ListRoute = { kind: "sessions" } | { kind: "repos" | "prs" | "issues"; sub: string };

export function listRoute(sub: string | undefined): ListRoute {
  if (sub === undefined) return { kind: "sessions" };
  if (REPO_SUBS.has(sub)) return { kind: "repos", sub };
  if (PR_SUBS.has(sub)) return { kind: "prs", sub };
  if (ISSUE_SUBS.has(sub)) return { kind: "issues", sub };
  return { kind: "sessions" };
}

/** `list prs` / `list issues`: the resource lists' `[dir]` context and its filter switch. */
export interface ResourceListArgs {
  json: boolean;
  /** The same path context the TUI takes, narrowing the listing to the repos found inside it. */
  dirArg?: string;
  /** `--repo-filter` / `--no-repo-filter` override the default (on whenever a dir is given), mirroring the menu's `f`. */
  repoFilter?: boolean;
}

export function parseResourceListArgs(sub: string, argv: string[]): ResourceListArgs {
  const out: ResourceListArgs = { json: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--repo-filter") out.repoFilter = true;
    else if (a === "--no-repo-filter") out.repoFilter = false;
    else if (!a.startsWith("-") && out.dirArg === undefined) out.dirArg = a;
    else unknownArgument(`list ${sub}`, a);
  }
  return out;
}

/** The scope selectors the session list and `list repos` share. */
export interface ScopeArgs {
  /** `[dir]` or `--path`: sessions whose cwd is under it, resolved against the current directory. */
  dirArg?: string;
  /** `--repo`: scope by repo instead, or as well. */
  repoArg?: string;
}

/**
 * `--path` and the `[dir]` positional are the SAME slot, so a second one is a
 * mistake — silently letting the later win would scope the listing to
 * something other than what the command line reads as. Both spellings share
 * one guard so the error doesn't depend on which came first.
 */
function setPathScope(out: ScopeArgs, dir: string): void {
  if (out.dirArg !== undefined) duplicatePathScope();
  out.dirArg = dir;
}

/** One scope token; returns how many following tokens it consumed. A dashed token nobody knows is refused. */
function scopeArg(cmd: string, out: ScopeArgs, a: string, next: string | undefined): 0 | 1 {
  if (a === "--path") {
    setPathScope(out, requireValue(cmd, a, next));
    return 1;
  }
  if (a === "--repo") {
    out.repoArg = requireValue(cmd, a, next);
    return 1;
  }
  if (a.startsWith("-")) unknownArgument(cmd, a);
  setPathScope(out, a);
  return 0;
}

/** `list repos`: the session list's own scope selectors, and `--json`. */
export interface RepoListArgs extends ScopeArgs {
  json: boolean;
}

export function parseRepoListArgs(sub: string, argv: string[]): RepoListArgs {
  const out: RepoListArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else i += scopeArg(`list ${sub}`, out, a, argv[i + 1]);
  }
  return out;
}

/** `list` itself: which sessions, how filtered, how printed. */
export interface SessionListArgs extends ScopeArgs {
  json: boolean;
  all: boolean;
  pr?: number;
  item?: number;
  stalledAfterMs?: number;
}

const SESSION_SWITCHES: Record<string, "json" | "all"> = { "--json": "json", "--all": "all", "--include-idle": "all" };
const ITEM_FLAGS = new Set(["--issue", "--work-item", "--workitem"]);

/** One session-list token; returns how many following tokens it consumed. */
function sessionListArg(out: SessionListArgs, a: string, next: string | undefined): 0 | 1 {
  const sw = SESSION_SWITCHES[a];
  if (sw) {
    out[sw] = true;
    return 0;
  }
  if (a === "--stalled-after") {
    out.stalledAfterMs = requireDuration("list", a, next);
    return 1;
  }
  if (a === "--pr") {
    out.pr = Number(next);
    return 1;
  }
  if (ITEM_FLAGS.has(a)) {
    out.item = Number(next);
    return 1;
  }
  return scopeArg("list", out, a, next);
}

function numericOrAbsent(n: number | undefined): boolean {
  return n === undefined || Number.isFinite(n);
}

export function parseSessionListArgs(argv: string[]): SessionListArgs {
  const out: SessionListArgs = { json: false, all: false };
  for (let i = 0; i < argv.length; i++) i += sessionListArg(out, argv[i], argv[i + 1]);
  if (!numericOrAbsent(out.pr) || !numericOrAbsent(out.item)) {
    console.error(`list: --pr/--issue/--work-item need a numeric id`);
    process.exit(1);
  }
  return out;
}
