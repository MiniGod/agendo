// Session scoping for the CLI selectors, shared by `agendo list`, `status` and
// `wait` so the three can't drift into three different ideas of "in this repo".
//
// Two orthogonal, optional axes — AND-ed when both are given:
//   • `--path <dir>`  the session's cwd IS that directory or sits under it,
//                     segment-aware so `/x/repo` never matches `/x/repo-other`
//   • `--repo <name>` the session's checkout belongs to that repo, compared as
//                     `owner/repo` slugs when both sides have one and bare repo
//                     names otherwise (see `repoScopeFilter` in sessions.ts —
//                     the same matcher the work-item↔session join uses)
//
// This lives in its own module rather than inline in the entrypoint because
// src/index.tsx *runs* the CLI on import and so can't be unit-tested; the
// resolution and the predicate below can.
import { realpathSync } from "fs";
import { resolve } from "path";
import { isUnderRoot, normalizeCwd } from "./context.ts";
import { repoScopeFilter } from "./sessions.ts";
import type { AgentSession } from "./types.ts";

export interface SessionScope {
  /**
   * Absolute roots a session's cwd may sit under; a session matches if it is
   * under ANY of them. Empty ⇒ no path constraint. More than one entry only
   * when the requested path is (or goes through) a symlink — see
   * `resolveScopeRoots`.
   */
  roots: string[];
  /** Wanted repo — a bare name or an `owner/repo` slug. Null ⇒ unconstrained. */
  repo: string | null;
}

/**
 * Resolve a user-supplied `--path` to the form(s) a recorded session cwd can
 * take. The literal `path.resolve` spelling is always kept; the symlink-resolved
 * one is added when it differs.
 *
 * Both are needed, and returning only one is a bug either way. Recorded cwds
 * come from real process working directories (`getcwd`, tmux's
 * `pane_current_path`), which are already symlink-free — so a user pointing at a
 * symlinked checkout (`~/work → /mnt/big/work`) needs the REAL path to match
 * anything. But the temp-dir trees the e2e suite and plenty of real setups run
 * under are themselves reached through a symlink (macOS `/tmp` → `/private/tmp`),
 * where the recorded cwd keeps the symlinked spelling and only the LITERAL path
 * matches. Keeping both makes the filter a superset of the naive one, so it can
 * never hide a session that a plain `resolve` would have matched.
 *
 * A path that isn't on disk (a stale or not-yet-created directory) simply has no
 * real form — the literal one still filters correctly against recorded cwds.
 */
export function resolveScopeRoots(pathArg: string, cwd: string): string[] {
  const abs = normalizeCwd(resolve(cwd, pathArg));
  let real: string;
  try {
    real = normalizeCwd(realpathSync(abs));
  } catch {
    return [abs];
  }
  return real === abs ? [abs] : [abs, real];
}

/**
 * Build a scope from the parsed `--path` / `--repo` flags, or null when neither
 * was given. Null (rather than an empty scope) is what lets every caller keep
 * its unfiltered behavior byte-identical: `scopeFilter(null)` is the identity
 * predicate, and callers can test the scope's presence to decide whether a
 * selector was supplied at all.
 */
export function makeSessionScope(
  opts: { path?: string; repo?: string },
  cwd: string,
): SessionScope | null {
  const roots = opts.path ? resolveScopeRoots(opts.path, cwd) : [];
  const repo = opts.repo?.trim() ? opts.repo.trim() : null;
  if (!roots.length && !repo) return null;
  return { roots, repo };
}

/** Everything passes — the no-scope predicate, hoisted so it isn't re-allocated. */
const MATCH_ALL = () => true;

/**
 * The session predicate for a scope. The wanted repo is parsed once here rather
 * than per session — and callers should hoist the returned predicate out of their
 * own loop for the same reason, since a slug-form `--repo` resolves each distinct
 * repo root through `git` (memoized by root, but still once per root).
 */
export function scopeFilter(scope: SessionScope | null): (s: AgentSession) => boolean {
  if (!scope) return MATCH_ALL;
  const inRepo = scope.repo ? repoScopeFilter(scope.repo) : null;
  return (s) => {
    if (scope.roots.length && !scope.roots.some((r) => isUnderRoot(s.cwd, r))) return false;
    return inRepo ? inRepo(s) : true;
  };
}

/**
 * Validate a scope flag's value, returning null (having printed why) when it is
 * unusable. Blank counts as missing, whitespace included: `--repo "  "` trims
 * away to "no repo wanted" and the command would then act on EVERY session at
 * exit 0. Handing back more than was asked for is the one failure mode a scoping
 * flag must not have, so an unusable value is an error rather than a silent
 * absence — as is a flag at the end of argv, or one followed by another flag.
 *
 * Returns rather than exits so `wait`, whose whole argv tail parses to an exit
 * code in-process (`parseWaitArgs`), can use the same guard as the subcommands
 * that do exit; `index.tsx` wraps it in the exiting form.
 */
export function scopeFlagValue(cmd: string, flag: string, v: string | undefined): string | null {
  if (v === undefined || v.trim() === "" || v.startsWith("-")) {
    console.error(`${cmd}: ${flag} needs a value`);
    return null;
  }
  return v;
}

/** ` in scope (…)` for an error message, or "" when nothing was scoped. Shared so
 *  every "not found / nothing matched" message names the scope the same way. */
export function scopeNote(scope: SessionScope | null): string {
  return scope ? ` in scope (${describeScope(scope)})` : "";
}

/** The scope as the flags that would reproduce it, for error messages. */
export function describeScope(scope: SessionScope | null): string {
  if (!scope) return "";
  const bits: string[] = [];
  // roots[0] is always the literal path the user asked for; the symlink-resolved
  // alternative is an implementation detail, so it stays out of the message.
  if (scope.roots.length) bits.push(`--path ${scope.roots[0]}`);
  if (scope.repo) bits.push(`--repo ${scope.repo}`);
  return bits.join(" ");
}
