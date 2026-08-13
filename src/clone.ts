// Cloning a repo the user doesn't have on disk yet, so the new-session picker
// can offer it like any other checkout. Three separable pieces, none of which
// know anything about sessions, worktrees or tmux (the UI wires the result back
// into the ordinary repo flow):
//
//   1. parseRepoUrl — a pasted URL (GitHub or Azure DevOps, web or clone, HTTPS
//      or SSH) → the remote to clone plus a canonical identity key.
//   2. findMatchingCheckout / freeCloneDest — where the clone should land in the
//      target directory, preferring an existing checkout of the same repo over a
//      second copy.
//   3. startClone — run `git clone` asynchronously with live progress, no
//      possibility of an interactive prompt hanging the TUI, and cleanup of the
//      partial directory on failure or cancellation.
//
// See docs/cloning.md for the flow and the decisions behind it.
import { spawn, spawnSync } from "child_process";
import { existsSync, readdirSync, rmSync, statSync } from "fs";
import { join } from "path";
import { normalizeCwd } from "./context.ts";
import { parseGithubRemote } from "./github.ts";

export type RepoHost = "github" | "ado";

export interface RepoUrl {
  host: RepoHost;
  /** GitHub owner / ADO organization. */
  owner: string;
  /** ADO project; "" on GitHub (which has no project layer). */
  project: string;
  /** Repo name — also the basis for the clone directory name. */
  repo: string;
  /** Canonical URL to hand `git clone` (never the pasted string verbatim). */
  remote: string;
  /**
   * Canonical lowercase identity: `github:owner/repo` / `ado:org/project/repo`.
   * Two URLs for the same repo (web vs. clone, HTTPS vs. SSH, dev.azure.com vs.
   * the legacy visualstudio.com host) share a key, which is what lets an
   * existing checkout be recognized instead of cloned again.
   */
  key: string;
}

// ── URL parsing ───────────────────────────────────────────────────────────────

/**
 * Strip the decoration a pasted URL picks up: surrounding quotes and angle
 * brackets (chat clients wrap links in `<…>`), and any `?query`/`#fragment` —
 * ADO web URLs carry `?path=/src&version=GBmain`, which is never part of the
 * remote.
 */
function tidy(token: string): string {
  return token
    .replace(/^[<"'`(]+/, "")
    .replace(/[>"'`),.]+$/, "")
    .replace(/[?#][\s\S]*$/, "");
}

/** How many whitespace-separated tokens of the input to consider (see below). */
const MAX_TOKENS = 8;

/**
 * The candidate URLs in a pasted string, in order. A URL contains no whitespace,
 * so splitting on it and trying each token in turn makes the parse forgiving of
 * what people actually paste — `git clone https://…` copied out of a README,
 * `--depth 1` still attached, a URL sitting in a sentence — without loosening
 * any of the host anchoring: a token only parses if it is *itself* a URL on a
 * recognized host, and the remote handed to git is rebuilt from that parse
 * rather than from the pasted text.
 */
function candidates(input: string): string[] {
  return input.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TOKENS).map(tidy).filter(Boolean);
}

const stripGit = (s: string) => s.replace(/\.git$/i, "");

/** Percent-decoding for display/identity only — remotes keep the encoded form. */
function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const segments = (path: string) => path.split("/").filter(Boolean);

// The ADO host must sit at the very start, after at most a scheme and a `user@`
// userinfo — so `https://evil.example/dev.azure.com/x` (host `evil.example`) and
// `https://dev.azure.com@evil.example/x` (host `evil.example` again, with
// `dev.azure.com` as the *username*) are both rejected. Same rigour as
// parseGithubRemote's anchoring, expressed for a leading rather than embedded
// host. Port-aware and case-insensitive throughout.
const ADO_SSH_RE =
  /^(?:ssh:\/\/)?([^/@\s]*@)?(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::\d+)?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
const ADO_HTTPS_RE = /^(?:https?:\/\/)?([^/@\s]*@)?dev\.azure\.com(?::\d+)?\/(\S+)$/i;
// `{org}.visualstudio.com` — the org label may not itself contain a dot, so
// `evil.visualstudio.com.example.org` can't slip through.
const ADO_LEGACY_RE = /^(?:https?:\/\/)?([^/@\s]*@)?([^./@\s]+)\.visualstudio\.com(?::\d+)?\/(\S+)$/i;

/**
 * Split an ADO path (already stripped of the org for dev.azure.com) into the
 * project and repo. The repo is the segment immediately after `_git`, so every
 * trailing web segment (`/pullrequest/42`, `/commit/abc`) falls away. With no
 * project segment (`https://dev.azure.com/{org}/_git/{repo}`) the project is
 * named after the repo, which is ADO's own convention for that shorthand. A
 * `DefaultCollection` segment is a legacy collection marker, not a project.
 */
function adoProjectAndRepo(segs: string[]): { project: string; repo: string } | null {
  const i = segs.findIndex((s) => s.toLowerCase() === "_git");
  if (i < 0) return null;
  const repo = stripGit(segs[i + 1] ?? "");
  if (!repo) return null;
  const before = segs.slice(0, i).filter((s) => s.toLowerCase() !== "defaultcollection");
  return { project: before[before.length - 1] ?? repo, repo };
}

function adoUrl(opts: { org: string; project: string; repo: string; remote: string }): RepoUrl {
  return {
    host: "ado",
    owner: dec(opts.org),
    project: dec(opts.project),
    repo: dec(opts.repo),
    remote: opts.remote,
    key: `ado:${dec(opts.org)}/${dec(opts.project)}/${dec(opts.repo)}`.toLowerCase(),
  };
}

/** Azure DevOps, all four shapes; null if this isn't an ADO URL. */
function parseAdo(url: string): RepoUrl | null {
  const ssh = url.match(ADO_SSH_RE);
  if (ssh) {
    const [, userinfo = "", host, org, project, repo] = ssh;
    // The legacy host wants the org as the SSH user; `git@` is right for
    // ssh.dev.azure.com. Keep whatever was pasted when it was explicit.
    const user = userinfo || (/^vs-ssh\./i.test(host) ? `${org}@` : "git@");
    return adoUrl({
      org,
      project,
      repo,
      remote: `${user}${host.toLowerCase()}:v3/${org}/${project}/${repo}`,
    });
  }

  const https = url.match(ADO_HTTPS_RE);
  if (https) {
    const [, userinfo = "", path] = https;
    const segs = segments(path);
    const org = segs[0];
    const pr = org ? adoProjectAndRepo(segs.slice(1)) : null;
    if (!org || !pr) return null;
    return adoUrl({
      org,
      project: pr.project,
      repo: pr.repo,
      remote: `https://${userinfo}dev.azure.com/${org}/${pr.project}/_git/${pr.repo}`,
    });
  }

  const legacy = url.match(ADO_LEGACY_RE);
  if (legacy) {
    const [, userinfo = "", org, path] = legacy;
    const pr = adoProjectAndRepo(segments(path));
    if (!pr) return null;
    return adoUrl({
      org,
      project: pr.project,
      repo: pr.repo,
      remote: `https://${userinfo}${org}.visualstudio.com/${pr.project}/_git/${pr.repo}`,
    });
  }

  return null;
}

/**
 * A pasted repo URL → everything needed to clone it, or null when it isn't a
 * repo URL we recognize. Deliberately strict: only github.com and Azure DevOps,
 * only with the host properly anchored, so junk text, a local path, a `file://`
 * URL, another forge, or a look-alike host all return null rather than reaching
 * `git clone`.
 *
 * Accepts both the clone URLs the hosts hand out and the web URLs a user is far
 * likelier to have in their clipboard (a repo page, a file at a branch, a PR).
 */
export function parseRepoUrl(input: string): RepoUrl | null {
  for (const url of candidates(input)) {
    // ADO first: `vs-ssh.visualstudio.com` would otherwise be read as an org
    // named "vs-ssh" by the legacy-host pattern.
    const ado = parseAdo(url);
    if (ado) return ado;

    const gh = parseGithubRemote(url);
    if (gh && gh.owner && gh.repo) {
      // Preserve the scheme family — it's the credential path the user has — but
      // normalize the URL itself, since a web URL is not a clone URL.
      const ssh = /^ssh:\/\//i.test(url) || /^[^/\s]*@/.test(url);
      return {
        host: "github",
        owner: gh.owner,
        project: "",
        repo: gh.repo,
        remote: ssh
          ? `git@github.com:${gh.owner}/${gh.repo}.git`
          : `https://github.com/${gh.owner}/${gh.repo}.git`,
        key: `github:${gh.owner}/${gh.repo}`.toLowerCase(),
      };
    }
  }
  return null;
}

/** Short "owner/repo" (GitHub) or "org/project/repo" (ADO) label for the UI. */
export function repoUrlLabel(u: RepoUrl): string {
  return u.host === "github" ? `${u.owner}/${u.repo}` : `${u.owner}/${u.project}/${u.repo}`;
}

// ── Where the clone lands ─────────────────────────────────────────────────────

/**
 * Directory name for a cloned repo: the repo name reduced to a safe basename.
 * Leading dots go too, so an oddly-named repo can never produce a hidden
 * directory (or a literal `.git`) inside the user's target folder.
 */
export function cloneDirName(repo: string): string {
  const name = repo.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").replace(/[-.]+$/, "");
  return name || "repo";
}

// Cached for the process lifetime, exactly as github.ts caches its own repo
// refs. findMatchingCheckout runs on every keystroke in the URL prompt (the
// preview tells the user *before* enter whether their repo is already here), and
// without this each keystroke would spawn one `git` per sibling checkout.
const originCache = new Map<string, string | null>();

/** `origin` of a checkout, or null when there's no origin / it isn't a repo. */
function gitOrigin(dir: string): string | null {
  const cached = originCache.get(dir);
  if (cached !== undefined) return cached;
  const r = spawnSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf-8" });
  const origin = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
  originCache.set(dir, origin);
  return origin;
}

/** Direct children of `dir` that look like git checkouts, plus `dir` itself. */
function checkoutCandidates(dir: string): string[] {
  const out: string[] = [];
  if (existsSync(join(dir, ".git"))) out.push(dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    if (existsSync(join(p, ".git"))) out.push(p);
  }
  return out;
}

/**
 * An existing checkout of the same repo at or directly under `parent`, matched
 * on `parseRepoUrl`'s canonical key — so a checkout in a differently-named
 * folder, or one cloned over SSH when the pasted URL was HTTPS, still counts.
 * Reusing it is always preferable to a second copy of the same repository.
 *
 * `readOrigin` is injectable so this is testable without a git binary.
 */
export function findMatchingCheckout(
  parent: string,
  key: string,
  readOrigin: (dir: string) => string | null = gitOrigin,
): string | null {
  for (const dir of checkoutCandidates(normalizeCwd(parent))) {
    const origin = readOrigin(dir);
    if (!origin) continue;
    if (parseRepoUrl(origin)?.key === key) return dir;
  }
  return null;
}

/** Cap on the `repo-2`, `repo-3`, … search — see freeCloneDest. */
const MAX_NAME_ATTEMPTS = 20;

/**
 * A directory under `parent` that `git clone` can write into: `<base>`, else
 * `<base>-2`, `<base>-3`, … A path that doesn't exist is free; so is one that
 * exists but is an empty directory (git clones into those happily). Returns null
 * after MAX_NAME_ATTEMPTS rather than inventing an unrecognizable name — at that
 * point something is wrong that the user should hear about.
 *
 * Only reached once findMatchingCheckout has ruled out "this repo is already
 * here", so a suffix always means a *name* collision with something else.
 */
export function freeCloneDest(parent: string, base: string): string | null {
  const root = normalizeCwd(parent);
  for (let n = 1; n <= MAX_NAME_ATTEMPTS; n++) {
    const path = join(root, n === 1 ? base : `${base}-${n}`);
    if (!existsSync(path)) return path;
    try {
      if (statSync(path).isDirectory() && readdirSync(path).length === 0) return path;
    } catch {
      // Unreadable — treat as taken and keep looking.
    }
  }
  return null;
}

// ── Running the clone ─────────────────────────────────────────────────────────

export interface CloneOutcome {
  ok: boolean;
  /** One-line failure reason, git's own words where it had any. */
  error?: string;
  /** The failure looks like missing or refused credentials. */
  auth?: boolean;
  /** The user cancelled (esc) rather than git failing. */
  canceled?: boolean;
}

export interface CloneRun {
  done: Promise<CloneOutcome>;
  /** Kill the clone and remove the partial directory. Safe to call twice. */
  cancel(): void;
}

// Git's vocabulary for "you are not authenticated / not allowed", across the
// transports and hosts we clone from. "repository not found" is in here on
// purpose: for a private repo GitHub reports a 404 rather than a 403, so the
// honest reading is "not found, or you don't have access".
const AUTH_RE =
  /authentication failed|could not read (?:username|password)|permission denied \(publickey|terminal prompts disabled|no such identity|403 forbidden|invalid username or (?:password|token)|repository not found|access denied|tf401019|authorization failed|host key verification failed/i;

/**
 * The child environment for `git clone`. agendo never prompts for credentials
 * and never stores any — it uses whatever the user's git is already configured
 * with. But git blocking on `Username:` would freeze the TUI on a stdin it
 * doesn't own, so every interactive path is closed off and a missing credential
 * becomes a fast, legible failure instead of a hang. Agent-held SSH keys (the
 * normal case) are unaffected by BatchMode.
 */
function cloneEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  if (!env.GIT_SSH_COMMAND) env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

/** The most informative line of git's stderr: its own `fatal:`/`error:` if any. */
function failureLine(stderr: string): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    [...lines].reverse().find((l) => /^(?:fatal|error|remote):/i.test(l)) ??
    lines[lines.length - 1] ??
    "git clone failed"
  );
}

/**
 * Clone `remote` into `dest`, asynchronously so the TUI keeps rendering. Each
 * progress line git writes (it emits them to stderr even without a TTY, given
 * `--progress`) is handed to `onProgress`.
 *
 * `--` guards the arguments: a remote can never be read as a flag, even though
 * parseRepoUrl already refuses anything that isn't an anchored host URL.
 *
 * On failure or cancellation the partial clone is removed — but only if we
 * created the directory. A directory that already existed (the empty-directory
 * case) is left in place; git cleans up its own contents, and deleting a folder
 * the user made isn't ours to do.
 */
export function startClone(
  remote: string,
  dest: string,
  onProgress: (line: string) => void,
): CloneRun {
  const preExisted = existsSync(dest);
  let canceled = false;

  const cleanup = () => {
    if (preExisted) return;
    try {
      if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    } catch {
      // Best-effort: a leftover directory is reported by the next attempt's
      // collision handling rather than being worth failing over here.
    }
  };

  const child = spawn("git", ["clone", "--progress", "--", remote, dest], {
    env: cloneEnv(),
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderr = "";
  child.stderr?.setEncoding("utf-8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
    if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    // Progress is carriage-return-delimited; show the newest non-empty line.
    const lines = chunk.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1];
    if (last) onProgress(last);
  });

  const done = new Promise<CloneOutcome>((resolve) => {
    child.on("error", (e) => {
      cleanup();
      resolve({ ok: false, error: `could not run git: ${e.message}` });
    });
    child.on("close", (code) => {
      if (canceled) {
        cleanup();
        resolve({ ok: false, canceled: true, error: "cancelled" });
        return;
      }
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      cleanup();
      resolve({ ok: false, error: failureLine(stderr), auth: AUTH_RE.test(stderr) });
    });
  });

  return {
    done,
    cancel() {
      if (canceled) return;
      canceled = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone — the close handler still runs the cleanup.
      }
    },
  };
}
