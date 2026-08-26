// "Does this checkout hold work that isn't on the remote?" — answered by
// reading `.git` ref files directly, WITHOUT ever spawning `git`.
//
// WHY NOT `git`: the orchestrator's real question about a parked session is "is
// there unfinished work here?", and "idle for 22h AND the branch has commits the
// remote doesn't AND no PR" is a far stronger answer than idle time alone. But
// the obvious implementation — `git -C <cwd> rev-parse` per session — is exactly
// what the session index must never do. `SessionIndex.build()` and
// `loadLocalSessions()` are network- and shell-free and run on a 2s rescan timer
// behind an mtime/size cache; a per-repo process spawn there re-introduces the
// CPU regression that cache exists to prevent.
//
// So this reads the ref files git itself maintains. Everything here is a handful
// of small `readFileSync`s and no subprocess — but it is still deliberately NOT
// called from the index build or the rescan path. Only the one-shot CLI reads
// (`agendo status`, the enriched `agendo list`) reach it.
//
// LIMITS (surfaced honestly by the caller, not papered over):
//   • The comparison is against tracking refs as this clone last saw them. There
//     is no fetch, so a branch pushed from another machine reads as unpushed
//     until something fetches.
//   • "unpushed" means the local tip is not the tip of any tracking ref this
//     branch could plausibly live under — which also covers "behind" and
//     "diverged". It means "this commit isn't one the remote has", the useful
//     signal here; it is not a reachability check (we can't walk the graph).
//   • With no configured upstream we fall back to assuming `origin/<same name>`
//     and SAY so (`upstreamConfigured: false`) rather than asserting the work was
//     never pushed. A branch tracking another LOCAL branch (`remote = .`) has
//     nothing remote to compare against, so it takes that same fallback.
import { readFileSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, isAbsolute, join, resolve, sep } from "path";
import type { BranchSync } from "./types.ts";
export type { BranchSync } from "./types.ts";

/**
 * Per-repo file caches, keyed by `commonDir`.
 *
 * `agendo list --all --json` calls `branchSync` once per indexed session, and
 * sessions cluster heavily in a handful of repos — every worktree of one repo
 * shares its `commonDir`, so without this the same `packed-refs` (multi-MB in a
 * long-lived clone) and `config` are read and re-parsed once per session. Per
 * call the cost is the "handful of small reads" this module advertises; per
 * invocation it was hundreds of them. `repos.ts`'s `rootCache` is the same idea.
 *
 * Lifetime is the process, which is sound precisely because the only callers are
 * one-shot CLI commands — the long-running TUI must not call `branchSync` at
 * all (see the header), so there is no window in which these can go stale.
 */
const packedCache = new Map<string, Map<string, string>>();
const configCache = new Map<string, string | null>();


/** The two ref roots of a checkout: per-worktree (HEAD) and shared (refs/…). */
interface GitDirs {
  /** Holds this worktree's own HEAD. */
  gitDir: string;
  /** Holds the refs shared across all worktrees of the repo. */
  commonDir: string;
}

/**
 * Resolve a working directory's git dirs, or null when it isn't inside a
 * checkout (or no longer exists — indexed sessions routinely point at deleted
 * worktrees).
 *
 * A linked worktree's `.git` is a FILE containing `gitdir: <path>`, and that dir
 * carries a `commondir` pointing back at the main `.git` where branches and
 * remote-tracking refs actually live. Following both is what makes this work for
 * agendo's own `<repo>/.claude/worktrees/<name>` sessions, which are the common
 * case.
 *
 * The walk-up matters: a session's recorded cwd is wherever the agent was
 * started, which is routinely a SUBDIRECTORY of the checkout (`cd src && claude`
 * records `<repo>/src`). Note this deliberately does NOT reuse
 * `repoRootForCwd` — that maps `<root>/.claude/worktrees/<name>` to the MAIN
 * repo root by design, which would make every worktree session report the main
 * checkout's branch instead of its own.
 */
function gitDirs(cwd: string): GitDirs | null {
  // The cwd itself must still exist before we walk anywhere. Indexed sessions
  // routinely point at DELETED worktrees (`<repo>/.claude/worktrees/<name>`,
  // removed after a merge), and walking up from one of those lands on the parent
  // repo's `.git` three levels up — which would report the MAIN checkout's
  // branch as if it were the dead session's, the most misleading answer this
  // module could give. A vanished checkout is "unknown", i.e. null.
  try {
    if (!statSync(cwd).isDirectory()) return null;
  } catch {
    return null;
  }
  let dir = cwd;
  let dotGit: string | null = null;
  let st: ReturnType<typeof statSync> | null = null;
  while (true) {
    // Stop before $HOME, exactly as `bootstrapRepoRoot` (repos.ts) does and for
    // the same reason: on a machine whose $HOME is itself a checkout — chezmoi,
    // yadm, a bare dotfiles repo, all common — an unbounded walk-up resolves ANY
    // cwd outside a repo to $HOME. `agendo status` would then print a `work:`
    // line about the user's DOTFILES, and `--json` would carry `unpushed: true`
    // for it: a confident wrong "unfinished work here", which is the one failure
    // this module exists to avoid. A session whose cwd IS that checkout is a
    // different matter — nothing was inferred there, so it's allowed through.
    if (dir !== cwd && atOrAboveHome(dir)) return null;
    const candidate = join(dir, ".git");
    try {
      st = statSync(candidate);
      dotGit = candidate;
      break;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return null; // reached the filesystem root
      dir = parent;
    }
  }
  if (!dotGit || !st) return null;
  let gitDir: string;
  if (st.isDirectory()) {
    gitDir = dotGit;
  } else {
    const raw = readText(dotGit);
    const m = raw?.match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    const p = m[1].trim();
    // Relative to the directory holding `.git` — which after the walk-up is
    // `dir`, not necessarily the cwd we started from.
    gitDir = isAbsolute(p) ? p : resolve(dir, p);
  }
  let commonDir = gitDir;
  const common = readText(join(gitDir, "commondir"))?.trim();
  if (common) commonDir = isAbsolute(common) ? common : resolve(gitDir, common);
  return { gitDir, commonDir };
}

/** Whether `dir` is $HOME itself or an ancestor of it (i.e. we walked too far). */
function atOrAboveHome(dir: string): boolean {
  const home = homedir();
  if (!home) return false;
  return dir === home || home.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** A loose ref file's contents (a sha, or a `ref: …` redirect), or null. */
function looseRef(dir: string, ref: string): string | null {
  return readText(join(dir, ref))?.trim() || null;
}

/**
 * A ref's sha from `packed-refs`, the fallback for refs git has packed away
 * (routine for remote-tracking refs in a long-lived clone, so skipping this
 * would report freshly-cloned branches as never-pushed). `^`-prefixed lines are
 * peeled tag targets and are skipped.
 */
function packedRef(commonDir: string, ref: string): string | null {
  let packed = packedCache.get(commonDir);
  if (!packed) {
    packed = new Map<string, string>();
    for (const line of readText(join(commonDir, "packed-refs"))?.split("\n") ?? []) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      packed.set(line.slice(sp + 1).trim(), line.slice(0, sp).trim());
    }
    packedCache.set(commonDir, packed);
  }
  return packed.get(ref) ?? null;
}

/** Resolve a ref to a sha, following `ref: …` redirects (bounded). */
function resolveRef(dirs: GitDirs, ref: string, depth = 0): string | null {
  if (depth > 4) return null;
  const loose = looseRef(dirs.commonDir, ref);
  if (loose) {
    const m = loose.match(/^ref:\s*(.+)$/);
    return m ? resolveRef(dirs, m[1].trim(), depth + 1) : loose;
  }
  return packedRef(dirs.commonDir, ref);
}

/**
 * The branch's CONFIGURED tracking ref from git config
 * (`[branch "x"] remote = … / merge = …`), or null when it has no upstream.
 *
 * Without this we would have to assume `origin/<same name>`, which is wrong the
 * moment a repo names its remote something else (`upstream` in a fork workflow,
 * a renamed `origin`) or a branch was pushed under a different name — and the
 * failure isn't a null, it's a confident "never been pushed" for work that is
 * fully pushed. That is precisely the false signal an orchestrator would act on.
 */
function configuredUpstream(commonDir: string, branch: string): string | null {
  let raw = configCache.get(commonDir);
  if (raw === undefined) {
    raw = readText(join(commonDir, "config"));
    configCache.set(commonDir, raw);
  }
  if (!raw) return null;
  let inSection = false;
  let remote: string | undefined;
  let merge: string | undefined;
  const applyKv = (text: string): void => {
    const kv = text.match(/^([\w-]+)\s*=\s*(.*)$/);
    if (!kv) return;
    const value = unquote(kv[2].trim());
    if (kv[1].toLowerCase() === "remote") remote = value;
    else if (kv[1].toLowerCase() === "merge") merge = value;
  };
  for (const line of raw.split("\n")) {
    const t = stripComment(line);
    if (!t) continue;
    if (t.startsWith("[")) {
      // Section keywords are case-insensitive; the quoted subsection (the branch
      // name) is not. Anything after the closing `]` is a key git allows on the
      // header line — so match the header as a PREFIX, not the whole line, or a
      // `[branch "x"] remote = y` (or a trailing comment) silently loses the
      // section and we fall back to guessing.
      const m = t.match(/^\[branch\s+"((?:[^"\\]|\\.)*)"\]/i);
      inSection = !!m && unescape(m[1]) === branch;
      const tail = m ? t.slice(m[0].length).trim() : "";
      if (inSection && tail) applyKv(tail);
      continue;
    }
    if (inSection) applyKv(t);
  }
  if (!remote || !merge) return null;
  // `remote = .` means the upstream is another LOCAL branch (what
  // `branch.autoSetupMerge=always` produces). There is no remote-tracking ref
  // involved, so it can answer nothing about whether the work left this machine
  // — treat it as "no usable candidate" and let the origin/<branch> fallback
  // speak instead. Returning the local ref here would report `hasRemoteRef: true`
  // for a ref that is not a remote at all.
  if (remote === ".") return null;
  const short = merge.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge;
  return `refs/remotes/${remote}/${short}`;
}

/**
 * Drop a git-config trailing comment (`#` or `;`), which may appear after a
 * section header or a value. Quoted spans are exempt, so a `#` inside a quoted
 * value survives.
 */
function stripComment(line: string): string {
  let out = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted && c === "\\") {
      out += c + (line[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "#" || c === ";")) break;
    out += c;
  }
  return out.trim();
}

/** `\"` → `"`, `\\` → `\` (git-config escaping inside quoted spans). */
function unescape(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

/** Strip surrounding quotes from a git-config value, unescaping the inside. */
function unquote(s: string): string {
  return s.length > 1 && s.startsWith('"') && s.endsWith('"') ? unescape(s.slice(1, -1)) : s;
}

/** `refs/remotes/origin/main` → `origin/main`; anything else stays as-is. */
function displayRef(ref: string): string {
  return ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : ref;
}

/**
 * The local-vs-tracked state of the checkout at `cwd`, or null when it can't be
 * determined — not inside a git checkout, the directory is gone, HEAD is
 * detached, or the branch has no commits yet. Null means "unknown", never
 * "in sync".
 */
export function branchSync(cwd: string): BranchSync | null {
  const dirs = gitDirs(cwd);
  if (!dirs) return null;
  // HEAD is per-worktree, so it comes from gitDir — not the shared commonDir.
  const head = looseRef(dirs.gitDir, "HEAD");
  const m = head?.match(/^ref:\s*(refs\/heads\/.+)$/);
  if (!m) return null;
  const ref = m[1].trim();
  const branch = ref.slice("refs/heads/".length);
  const local = resolveRef(dirs, ref);
  if (!local) return null;
  // Two candidates, because neither alone is right for the workflows agendo
  // creates. The CONFIGURED upstream is authoritative when it exists — but
  // `git worktree add -b x` sets it to the BASE branch (`origin/master`), so a
  // branch that has since been pushed under its own name would read as
  // "differs from origin/master: unpushed" forever. Meanwhile assuming
  // `origin/<branch>` alone is wrong for forks and renamed remotes. So: if the
  // local tip equals EITHER candidate, this commit exists on a remote and the
  // work is not stranded here — which is the question actually being asked.
  const configured = configuredUpstream(dirs.commonDir, branch);
  const candidates = configured ? [configured] : [];
  const assumed = `refs/remotes/origin/${branch}`;
  if (!candidates.includes(assumed)) candidates.push(assumed);

  let matched: string | null = null; // a candidate whose tip IS the local tip
  let present: string | null = null; // the first candidate that exists at all
  for (const candidate of candidates) {
    const sha = resolveRef(dirs, candidate);
    if (sha === null) continue;
    present ??= candidate;
    if (sha === local) {
      matched = candidate;
      break;
    }
  }
  // Report the ref the verdict actually rests on: the match if there was one,
  // else whichever candidate exists, else the one we looked for and didn't find.
  const chosen = matched ?? present ?? candidates[0];
  return {
    branch,
    upstream: displayRef(chosen),
    upstreamConfigured: chosen === configured,
    hasRemoteRef: (matched ?? present) !== null,
    unpushed: matched === null,
  };
}
