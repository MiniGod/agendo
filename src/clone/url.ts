// Parsing a pasted repo URL. GitHub or Azure DevOps, web or clone, HTTPS or
// SSH, with or without a trailing `.git` — all of it reduced to the remote to
// clone plus a canonical identity key. Nothing here touches the filesystem or
// spawns anything; it is string work, which is why it is also the part with
// unit tests behind it.
import { parseGithubRemote } from "../github.ts";

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

/**
 * Percent-encode a path segment for the remote, whatever form it arrived in.
 * Decode-then-encode, so it's idempotent: `My%20Proj` stays `My%20Proj`, while a
 * segment pasted raw (`Þróun`, which is what a browser's address bar hands you
 * for a non-ASCII ADO project) becomes `%C3%9Er%C3%B3un` rather than reaching
 * git as raw bytes.
 *
 * Non-throwing, like `dec`: `encodeURIComponent` rejects a lone surrogate, and
 * this runs on the render path (the destination preview parses on every
 * keystroke), where an exception would take the whole TUI down rather than
 * produce a bad URL. Both of its inputs — terminal stdin and `git remote
 * get-url` — are UTF-8-decoded upstream and yield U+FFFD instead, so this is
 * belt-and-braces; a URL that survives unencoded is a failed clone, not a crash.
 */
function enc(s: string): string {
  try {
    return encodeURIComponent(dec(s));
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
  /^(?:ssh:\/\/)?([^/@\s]*@)?(ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)(?::(\d+))?[:/]v3\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i;
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
    // The username is `*`, not `+`: `https://:$(System.AccessToken)@dev.azure.com/…`
    // — an EMPTY username with the token in the password slot — is the form
    // Azure Pipelines documents, and a `+` here would skip it entirely.
    /(\/\/|^)([^/@\s:]*)(:[^/@\s]*)?@/,
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

/** The scp-like or `ssh://` clone URL ADO hands out, on either SSH host. */
function adoFromSsh(m: RegExpMatchArray): RepoUrl {
  const [, userinfo = "", host, port = "", org, project, repo] = m;
  // The legacy host wants the org as the SSH user; `git@` is right for
  // ssh.dev.azure.com. Keep whatever was pasted when it was explicit.
  const user = userinfo || (/^vs-ssh\./i.test(host) ? `${org}@` : "git@");
  const path = `v3/${org}/${project}/${repo}`;
  // A non-default port can't be expressed in the scp-like form (`:` is the
  // path separator there), so it needs the explicit ssh:// URL — same call
  // githubRemote makes, and for the same reason: silently rewriting it to
  // port 22 would connect somewhere the user didn't ask for.
  return adoUrl({
    org,
    project,
    repo,
    remote:
      port && port !== "22"
        ? `ssh://${user}${host.toLowerCase()}:${port}/${path}`
        : `${user}${host.toLowerCase()}:${path}`,
  });
}

/** A dev.azure.com URL, web or clone: the org is the first path segment. */
function adoFromHttps(m: RegExpMatchArray): RepoUrl | null {
  const [, userinfo = "", path] = m;
  const segs = segments(path);
  const org = segs[0];
  const pr = org ? adoProjectAndRepo(segs.slice(1)) : null;
  if (!org || !pr) return null;
  return adoUrl({
    org,
    project: pr.project,
    repo: pr.repo,
    remote: `https://${userinfo}dev.azure.com/${enc(org)}/${enc(pr.project)}/_git/${enc(pr.repo)}`,
  });
}

/** A `{org}.visualstudio.com` URL: the org is the host label. */
function adoFromLegacy(m: RegExpMatchArray): RepoUrl | null {
  const [, userinfo = "", org, path] = m;
  const pr = adoProjectAndRepo(segments(path));
  if (!pr) return null;
  return adoUrl({
    org,
    project: pr.project,
    repo: pr.repo,
    remote: `https://${userinfo}${org}.visualstudio.com/${enc(pr.project)}/_git/${enc(pr.repo)}`,
  });
}

/** Azure DevOps, all four shapes; null if this isn't an ADO URL. */
function parseAdo(url: string): RepoUrl | null {
  const ssh = url.match(ADO_SSH_RE);
  if (ssh) return adoFromSsh(ssh);
  const https = url.match(ADO_HTTPS_RE);
  if (https) return adoFromHttps(https);
  const legacy = url.match(ADO_LEGACY_RE);
  if (legacy) return adoFromLegacy(legacy);
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
