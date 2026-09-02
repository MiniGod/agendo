// Creating a repo that doesn't exist anywhere yet, so the new-session picker can
// offer it like any other checkout — the local-only sibling of src/clone.ts.
// Three separable pieces, none of which know anything about sessions, worktrees
// or tmux (the UI wires the result back into the ordinary repo flow):
//
//   1. rankParentDirs / resolveParentInput — where the repo could go: the parent
//      folders of every checkout agendo already knows about, most common first,
//      plus whatever absolute (or `~/…`) path the user types instead.
//   2. repoNameError / inspectInitDest — whether the name is a folder name at
//      all, and what is already sitting at the destination (nothing, an empty
//      folder, a repo, something else).
//   3. initRepo — `mkdir -p` + `git init` + an empty initial commit, with the
//      partial directory removed again if git fails.
//
// See docs/new-local-repo.md for the flow and the decisions behind it.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs";
import { dirname, join } from "path";
import { normalizeCwd } from "./context.ts";

// ── where it could go ─────────────────────────────────────────────────────────

/**
 * The parent folders of `roots`, deduplicated and ranked by how many of the
 * roots sit in each — the folder holding most of the user's checkouts is the
 * likeliest home for the next one. Ties break on the path itself, so the order
 * is stable across reloads. Roots are normalized first, so the same checkout
 * spelled two ways (trailing slash, a `..` segment) counts once; a relative or
 * empty root contributes nothing, and neither does the filesystem root, which
 * has no parent.
 */
export function rankParentDirs(roots: string[]): string[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  for (const raw of roots) {
    const root = normalizeCwd(raw);
    if (!root.startsWith("/") || seen.has(root)) continue;
    seen.add(root);
    const parent = dirname(root);
    if (parent === root) continue;
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([parent]) => parent);
}

/**
 * A typed parent folder → an absolute, normalized path, or null when it isn't
 * one. `~` and `~/…` expand to `home` (typing the full home path is exactly
 * the chore the candidate list exists to spare, so the shorthand has to work
 * here too); anything else must already be absolute — a relative path would
 * silently resolve against the launcher's cwd, which the user cannot see.
 */
export function resolveParentInput(raw: string, home: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const expanded = s === "~" ? home : s.startsWith("~/") ? join(home, s.slice(2)) : s;
  return expanded.startsWith("/") ? normalizeCwd(expanded) : null;
}

// ── what the name and the destination are ─────────────────────────────────────

/**
 * Why `name` can't be the new repo's folder name, or null when it can. A
 * single path segment is all that is accepted: a slash would make the "parent"
 * question the next screen asks meaningless, and `.`/`..` name a folder that
 * already exists. Control characters never reach here (the prompt strips them).
 */
export function repoNameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Type a folder name for the new repo.";
  if (n.includes("/") || n.includes("\0")) return "A repo name is a single folder name — no slashes.";
  if (n === "." || n === "..") return `"${n}" is not a folder name.`;
  return null;
}

/** What is already at the destination, if anything. */
export type DestState = "free" | "empty" | "repo" | "nonempty" | "file";

export interface DestInfo {
  /** `<parent>/<name>`, normalized. */
  dest: string;
  state: DestState;
  /** The parent itself: a folder, absent (mkdir -p will create it), or a file. */
  parent: "dir" | "missing" | "file";
}

function pathKind(p: string): "dir" | "missing" | "file" {
  try {
    return statSync(p).isDirectory() ? "dir" : "file";
  } catch {
    return "missing";
  }
}

/**
 * Look at `<parent>/<name>` and classify it, so the caller can refuse, reuse or
 * create with a message that says which. An existing folder counts as a repo
 * when it carries `.git` — a file there (a linked worktree) counts too, since
 * `git init` in one would silently reinitialize the wrong repository.
 */
export function inspectInitDest(parent: string, name: string): DestInfo {
  const dest = join(normalizeCwd(parent), name.trim());
  const parentKind = pathKind(dirname(dest));
  const kind = pathKind(dest);
  if (kind === "missing") return { dest, state: "free", parent: parentKind };
  if (kind === "file") return { dest, state: "file", parent: parentKind };
  if (existsSync(join(dest, ".git"))) return { dest, state: "repo", parent: parentKind };
  let entries: string[] = [];
  try {
    entries = readdirSync(dest);
  } catch {
    return { dest, state: "nonempty", parent: parentKind }; // unreadable — treat as taken
  }
  return { dest, state: entries.length === 0 ? "empty" : "nonempty", parent: parentKind };
}

// ── creating it ───────────────────────────────────────────────────────────────

export interface InitOutcome {
  ok: boolean;
  /** One-line failure reason, git's own words where it had any. */
  error?: string;
  /** The parent folder did not exist and was created along the way. */
  createdParent: boolean;
  /** The empty initial commit landed (see initRepo for why there is one). */
  committed: boolean;
  /** Why it didn't, when it didn't — reported, never fatal. */
  commitError?: string;
}

/** git's stderr reduced to the line worth showing. */
function gitError(stderr: string | undefined, fallback: string): string {
  const lines = (stderr ?? "").split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return [...lines].reverse().find((l) => /^(?:fatal|error):/i.test(l)) || lines[lines.length - 1] || fallback;
}

/**
 * Create `dest` (and any missing parents) and run `git init` in it.
 *
 * Also makes one EMPTY initial commit. Everything downstream of the picker
 * assumes a repo with history: `git worktree add -b <branch> <path> HEAD` — the
 * work-item and PR flows' only way in — fails outright on an unborn HEAD, so a
 * bare `git init` would hand the user a repo the very next screen can't use.
 * The commit runs with signing off, hooks skipped and every prompt disabled,
 * because a pinentry or a hook waiting on a terminal the TUI owns would hang
 * the screen; it is best-effort, and a failure (no `user.name`, say) is
 * reported on the outcome rather than failing the init — the repo still exists.
 *
 * `-C dest` rather than `git init dest`: the directory is created here first so
 * the two failure cases (can't create the folder / git refused) stay distinct,
 * and an absolute path can never be read as a flag. If git fails, a directory
 * this call created is removed again; one that already existed (the
 * empty-folder case) only loses the `.git` git may have started writing.
 */
export function initRepo(dest: string): InitOutcome {
  const parent = dirname(dest);
  const createdParent = !existsSync(parent);
  const preExisted = existsSync(dest);
  const fail = (error: string): InitOutcome => ({ ok: false, error, createdParent, committed: false });
  try {
    mkdirSync(dest, { recursive: true });
  } catch (e) {
    return fail(`could not create ${dest}: ${(e as Error).message}`);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const init = spawnSync("git", ["-C", dest, "init", "--quiet"], { encoding: "utf-8", env });
  if (init.error || init.status !== 0) {
    try {
      if (!preExisted) rmSync(dest, { recursive: true, force: true });
      else rmSync(join(dest, ".git"), { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover is reported by the next attempt's inspection.
    }
    return fail(init.error ? `could not run git: ${init.error.message}` : gitError(init.stderr, "git init failed"));
  }
  const commit = spawnSync(
    "git",
    ["-C", dest, "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "Initial commit"],
    { encoding: "utf-8", env },
  );
  const committed = !commit.error && commit.status === 0;
  return {
    ok: true,
    createdParent,
    committed,
    ...(committed ? {} : { commitError: commit.error ? commit.error.message : gitError(commit.stderr, "git commit failed") }),
  };
}
