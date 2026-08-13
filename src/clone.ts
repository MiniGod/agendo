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
import { dirname, join } from "path";
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
   * `remote` with any password/token in its userinfo replaced by `***`. People
   * do paste `https://org:<PAT>@dev.azure.com/…` (ADO hands that form out), and
   * the clone screen shows the remote — this is the one the UI must render, so a
   * token doesn't end up in terminal scrollback. The secret is kept in `remote`
   * itself: dropping it would break a clone the user explicitly authenticated,
   * and it reaches git's argv either way, exactly as it would from their shell.
   */
  displayRemote: string;
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
 * github.com paths that look like `owner/repo` but are site pages, not repos —
 * `https://github.com/orgs/anthropics/repositories`,
 * `https://github.com/features/copilot`. GitHub reserves these names, so no real
 * owner can be shadowed by rejecting them. Without this they parse happily and
 * the user only finds out when `git clone` reports "repository not found" for a
 * URL that was never a repository.
 */
const GITHUB_RESERVED = new Set([
  "about", "apps", "collections", "codespaces", "contact", "enterprise", "events",
  "explore", "features", "issues", "join", "login", "marketplace", "new",
  "notifications", "orgs", "pricing", "pulls", "search", "security", "settings",
  "sponsors", "stars", "topics", "trending", "users",
]);

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

/**
 * Mask credentials in a URL's userinfo for display.
 *
 * `user:secret@` is easy — the half after the colon is the secret, the username
 * identifies the account and is worth seeing. A *bare* `something@` is the hard
 * one, because the two things it can be are structurally identical: ADO's own
 * Clone-button URL puts the org there (`https://org@dev.azure.com/…`), and a
 * token pasted without a username looks exactly the same. So bare userinfo is
 * masked unless it's a name we can vouch for — `git`, the SSH user in every scp
 * form, or `keepUser` (the org the URL itself parsed to). Masking a real
 * username costs nothing; printing a PAT into scrollback is the thing this
 * exists to prevent.
 *
 * A no-op on URLs without userinfo, which is most of them.
 */
export function redactUrl(url: string, keepUser?: string): string {
  return url.replace(
    /(\/\/|^)([^/@\s:]+)(:[^/@\s]*)?@/,
    (_m, lead: string, user: string, secret: string | undefined) => {
      if (secret) return `${lead}${user}:***@`;
      const vouched =
        user.toLowerCase() === "git" || (!!keepUser && user.toLowerCase() === keepUser.toLowerCase());
      return `${lead}${vouched ? user : "***"}@`;
    },
  );
}

function adoUrl(opts: { org: string; project: string; repo: string; remote: string }): RepoUrl {
  return {
    host: "ado",
    owner: dec(opts.org),
    project: dec(opts.project),
    repo: dec(opts.repo),
    remote: opts.remote,
    // The org is the legitimate username in ADO's own clone URLs, so it's the
    // one bare userinfo worth showing; anything else there is treated as a token.
    displayRemote: redactUrl(opts.remote, opts.org),
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

// The transport half of a github.com URL, on the SAME anchored host pattern
// parseGithubRemote uses: optional userinfo, the host (github.com or GitHub's
// SSH-over-HTTPS ssh.github.com), an optional port. Only ever applied to a
// string parseGithubRemote has already accepted, so it can't widen what parses.
const GITHUB_PARTS_RE = /(?:^|\/\/)([^/@\s]*)@?((?:ssh\.)?github\.com)(?::(\d+))?[:/]/i;

/**
 * The URL to actually clone a github.com repo from. A web URL is not a clone
 * URL, so this is rebuilt from `owner`/`repo` rather than passed through — but
 * everything about the pasted URL that is part of the user's *access path* is
 * carried over, because rewriting it away turns a URL that works in their shell
 * into one that fails in agendo:
 *
 *  - **Credentials.** `https://x-access-token:TOKEN@github.com/acme/private`
 *    keeps its userinfo. Someone with no credential helper configured pasted
 *    that precisely because it's the only form that works for them. (This is
 *    what the ADO path does too — see `displayRemote` for how it stays off the
 *    screen.)
 *  - **The SSH host and port.** `ssh://git@ssh.github.com:443/owner/repo` is
 *    what you use when your network blocks port 22; canonicalizing it to
 *    `git@github.com:` would hang until the TCP connect timed out.
 *
 * Everything else collapses to the plain `git@github.com:owner/repo.git` /
 * `https://github.com/owner/repo.git` pair.
 */
function githubRemote(url: string, owner: string, repo: string): string {
  const [, userinfo = "", host = "github.com", port = ""] = url.match(GITHUB_PARTS_RE) ?? [];
  const isSsh = /^ssh:\/\//i.test(url) || /^[^/\s]*@/.test(url);
  if (!isSsh) {
    const creds = userinfo ? `${userinfo}@` : "";
    return `https://${creds}github.com/${owner}/${repo}.git`;
  }
  // A non-default host or port can't be expressed in the scp-like form (`:` is
  // the path separator there), so those need the explicit ssh:// URL.
  if (port || /^ssh\./i.test(host)) {
    return `ssh://${userinfo || "git"}@${host.toLowerCase()}${port ? `:${port}` : ""}/${owner}/${repo}.git`;
  }
  return `${userinfo || "git"}@github.com:${owner}/${repo}.git`;
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
    if (gh && gh.owner && gh.repo && !GITHUB_RESERVED.has(gh.owner.toLowerCase())) {
      const remote = githubRemote(url, gh.owner, gh.repo);
      return {
        host: "github",
        owner: gh.owner,
        project: "",
        repo: gh.repo,
        remote,
        displayRemote: redactUrl(remote),
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

/**
 * Whether `dir` is a repo's MAIN checkout — `.git` is a directory there, and a
 * *file* in a linked worktree (and in a submodule). The distinction matters
 * because `git remote get-url origin` answers identically in both: a sibling
 * worktree (`~/git/repo-feature`) would otherwise match a pasted URL for
 * `~/git/repo` and be handed downstream as a repo root, where `createWorktree`
 * would nest a worktree inside a worktree.
 */
function isMainCheckout(dir: string): boolean {
  try {
    return statSync(join(dir, ".git")).isDirectory();
  } catch {
    return false;
  }
}

/** Direct children of `dir` that are main checkouts, plus `dir` itself. */
function checkoutCandidates(dir: string): string[] {
  const out: string[] = [];
  if (isMainCheckout(dir)) out.push(dir);
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const p = join(dir, name);
    if (isMainCheckout(p)) out.push(p);
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

/**
 * The checkout `dir` sits in (itself, or the nearest ancestor), or null when it
 * sits in none. This is the "is this a place we may clone into" test: the clone
 * lands as a direct child of `dir`, so anywhere inside a repo would mean a
 * nested repository in that repo's working tree.
 *
 * The walk stops *below* `$HOME` and the filesystem root, and that boundary is
 * the whole reason this isn't `repoRootForCwd`. Keeping dotfiles in a git repo
 * at `~` is a common setup, and an unbounded walk-up would find `~/.git` from
 * every directory the user owns — silently disabling cloning across the entire
 * machine. `$HOME` is not a project checkout in any sense that matters here.
 */
export function enclosingCheckout(dir: string, home: string): string | null {
  const stop = normalizeCwd(home);
  let cur = normalizeCwd(dir);
  while (cur && cur !== "/" && cur !== stop) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
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

/** How agendo reads a clone failure — decides which explanation is offered. */
export type CloneFailure = "hostkey" | "auth" | "missing" | "other";

export interface CloneOutcome {
  ok: boolean;
  /** One-line failure reason, git's own words where it had any. */
  error?: string;
  /** agendo's reading of `error` (absent when the clone succeeded). */
  failure?: CloneFailure;
  /** The user cancelled (esc) rather than git failing. */
  canceled?: boolean;
}

export interface CloneRun {
  done: Promise<CloneOutcome>;
  /**
   * Kill the clone and remove the partial directory. Safe to call twice.
   * `immediate` is for teardown (unmount), where there is no time left for the
   * child's exit to be observed: it kills hard and cleans up synchronously.
   */
  cancel(opts?: { immediate?: boolean }): void;
}

// Checked BEFORE auth, because it is a consequence of our own BatchMode: ssh
// normally *asks* whether to trust an unknown host, and we've turned that off.
// So the first-ever clone from a host the user hasn't reached over SSH before
// (ssh.dev.azure.com, for anyone who has only used ADO over HTTPS) fails here —
// and "check your SSH agent" would send them looking in the wrong place.
const HOSTKEY_RE =
  /host key verification failed|no matching host key|remote host identification has changed|no ed25519 host key is known/i;

// Git's vocabulary for "you are not authenticated / not allowed", across the
// transports and hosts we clone from.
const AUTH_RE =
  /authentication failed|could not read (?:username|password)|permission denied \(publickey|terminal prompts disabled|no such identity|403 forbidden|invalid username or (?:password|token)|access denied|tf401019|authorization failed|host key verification failed/i;

// Distinct from AUTH_RE on purpose. GitHub answers an unauthorized *private*
// repo with a 404, so "not found" genuinely means "doesn't exist, OR you can't
// see it" — telling the user flatly to check their credentials would be a
// confident wrong answer for the (likelier) typo. The message covers both.
//
// AUTH_RE is tested FIRST, and that order is load-bearing: git ends every failed
// SSH handshake with "fatal: Could not read from remote repository." — including
// the one whose real cause is on the line above it
// ("git@github.com: Permission denied (publickey).") — so matching this pattern
// first would classify every SSH credentials failure as a missing repo. Nothing
// in AUTH_RE appears in a genuine 404, so the reverse mix-up can't happen.
const MISSING_RE = /repository .*not found|could not read from remote repository|does not (?:exist|appear to be a git repository)|project does not exist/i;

// Tried in this order; the first match names the failure. `other` has no
// pattern — it's what's left when none of them matched.
const FAILURE_RE: Partial<Record<CloneFailure, RegExp>> = {
  hostkey: HOSTKEY_RE,
  auth: AUTH_RE,
  missing: MISSING_RE,
};

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
  // APPEND rather than only-set-if-unset: ssh reads passphrases straight from
  // /dev/tty, not stdin, so a user's own `GIT_SSH_COMMAND` (`ssh -i ~/.ssh/…`,
  // a wrapper script) would prompt into the terminal the TUI is drawing on and
  // hang the clone screen. Their command is preserved — the later `-o` simply
  // adds BatchMode to it.
  env.GIT_SSH_COMMAND = `${env.GIT_SSH_COMMAND ?? "ssh"} -o BatchMode=yes`;
  return env;
}

/**
 * The most informative line of git's stderr.
 *
 * Preferring a `fatal:` line alone is not good enough: git's summary line for a
 * failed SSH handshake is the generic "Could not read from remote repository.",
 * while the line that actually says what went wrong
 * ("git@github.com: Permission denied (publickey).") carries no prefix at all
 * and would be thrown away. So the line matching the classification wins, and
 * the `fatal:` line is only the fallback.
 */
function failureLine(stderr: string, failure: CloneFailure): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const specific = FAILURE_RE[failure] ?? null;
  return (
    (specific && lines.find((l) => specific.test(l))) ||
    [...lines].reverse().find((l) => /^(?:fatal|error|remote):/i.test(l)) ||
    lines[lines.length - 1] ||
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

  // A directory we created goes entirely; one that was already there (which
  // freeCloneDest only ever hands back when it is EMPTY) is emptied instead —
  // the same distinction git draws for itself. Skipping it would be a real leak:
  // `git clone` writes `remote.origin.url` into the config before it fetches
  // anything, so a killed clone leaves behind a `.git` with an origin and no
  // refs — which findMatchingCheckout would then happily report as "already
  // cloned" and launch a session in.
  const rm = (p: string) => rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
  const cleanup = () => {
    try {
      if (!existsSync(dest)) return;
      if (!preExisted) {
        rm(dest);
        return;
      }
      for (const entry of readdirSync(dest)) rm(join(dest, entry));
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
      resolve({ ok: false, failure: "other", error: `could not run git: ${e.message}` });
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
      // Order matters — see the comments on HOSTKEY_RE and MISSING_RE.
      const failure =
        (Object.keys(FAILURE_RE) as CloneFailure[]).find((k) => FAILURE_RE[k]!.test(stderr)) ?? "other";
      resolve({ ok: false, failure, error: failureLine(stderr, failure) });
    });
  });

  return {
    done,
    cancel(opts) {
      if (canceled) return;
      canceled = true;
      try {
        // SIGKILL on teardown: SIGTERM leaves git a window to keep writing, and
        // there is no later tick in which to notice it finished.
        child.kill(opts?.immediate ? "SIGKILL" : "SIGTERM");
      } catch {
        // Already gone — the close handler still runs the cleanup.
      }
      // Normally the close handler owns cleanup (git may still be writing). On
      // teardown that handler will never run, so do it here instead — twice,
      // because SIGKILL delivery is asynchronous and an already-issued write can
      // land after the first pass. What must not survive is a `.git` carrying an
      // origin and no refs, which the next run would read as "already cloned".
      if (opts?.immediate) {
        cleanup();
        if (existsSync(dest)) cleanup();
      }
    },
  };
}
