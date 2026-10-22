// Parsing an `agendo://` URL into the one thing it may ask for.
//
// THIS IS A SECURITY BOUNDARY. Once the scheme handler is installed, ANY web page
// can navigate to an agendo:// link, and the browser hands the string to
// `agendo url` with nothing but a one-time "open this app?" prompt in between. So
// the parser is an allowlist, not a sanitizer: it accepts exactly
//
//     agendo://focus?pr=<digits>[&repo=<repo>]
//     agendo://focus?workItem=<digits>[&repo=<repo>]
//     agendo://focus?session=<session id, short id or agendo window name>
//
// `repo` — a bare repo name (ADO) or one `owner/name` slug (GitHub) — is the one
// optional extra, only after `pr` or `workItem` and only in that order. GitHub
// numbers PRs and issues per repository, so without it `?pr=5` from repo A's
// page could bring repo B's session forward. It narrows the lookup to the PR or
// issue in that repo (see linked.ts), and is shape-checked like everything else: a name that
// starts with a letter, digit or `_` (never `.`/`-`, so no `..`, no flag), and
// at most one `/`.
//
// (an empty path, `agendo://focus/?…`, is tolerated because browsers differ on
// whether they add one) and refuses everything else outright. It never decodes:
// a `%` anywhere is a refusal, so an encoded separator, NUL or newline cannot
// smuggle a second parameter or a path past the shape check. Nothing it returns
// is ever passed through a shell, and the only action a parsed URL can lead to is
// focusing — or resuming, then focusing — a session that already exists.

/** What a URL (or `agendo focus`'s own flags) asks to focus. */
export type FocusTarget =
  | { kind: "pr"; id: number; repo?: string }
  | { kind: "workItem"; id: number; repo?: string }
  | { kind: "session"; token: string };

export type ParsedFocusUrl = { ok: true; target: FocusTarget } | { ok: false; reason: string };

/** Longer than any URL the allowlist below can match. */
export const MAX_URL_LENGTH = 200;

/** Digits only, no leading zero, at most 10 of them (ADO and GitHub ids are int32). */
const ID_RE = /^[1-9]\d{0,9}$/;

/**
 * A session id (a uuid, or a fixture-style slug) or the 12-character short id
 * `list` prints: letters, digits and inner dashes, starting with a letter or
 * digit so it can never read as a flag.
 */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * One of agendo's own tmux window names (src/runtime/tmux/names.ts,
 * src/launch/task.ts): a known `cl-<kind>-` prefix, then the same letters,
 * digits and dashes. Its own pattern only because a `cl-wi-`/`cl-pr-` name can
 * fold a whole repo slug in and outgrow SESSION_RE's 64 — the prefix list is
 * the price of the extra length, so nothing else gets it.
 */
const WINDOW_NAME_RE = /^cl-(?:claude|copilot|codex|bg|new|free|wi|pr)-[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

/** A repo name or `owner/name` slug: each segment opens with a letter, digit or `_`; 120 characters at most. */
const REPO_RE = /^(?=.{1,120}$)[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)?$/;

/** The whole URL: one known verb, one key and value, and at most a `repo` after it — nothing else at all. */
const URL_RE = /^agendo:\/\/focus\/?\?(pr|workItem|session)=([A-Za-z0-9-]+)(?:&repo=([A-Za-z0-9._/-]+))?$/;

const refuse = (reason: string): ParsedFocusUrl => ({ ok: false, reason });

/** An item id from a URL or a flag, or null when it is not one. */
export function parseItemId(raw: string): number | null {
  if (!ID_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= 0x7fffffff ? n : null;
}

/** Is `raw` a repo a URL (or `focus --repo`) may carry? */
export function isRepo(raw: string): boolean {
  return REPO_RE.test(raw);
}

/** Is `raw` one of agendo's own window names (`cl-wi-102`, `cl-bg-codex-…`)? */
export function isWindowName(raw: string): boolean {
  return WINDOW_NAME_RE.test(raw);
}

/** Is `raw` a session token a URL may carry: a session id, a short id or a window name? */
export function isSessionToken(raw: string): boolean {
  return SESSION_RE.test(raw) || isWindowName(raw);
}

/** The value checked against its key's own shape; `repo` only alongside an item id. */
function targetFor(key: string, value: string, repo: string | undefined): ParsedFocusUrl {
  if (key === "session") return sessionTarget(value, repo);
  const id = parseItemId(value);
  if (id === null) return refuse(`malformed ${key} id`);
  if (repo !== undefined && !isRepo(repo)) return refuse("malformed repo");
  return { ok: true, target: itemTarget(key === "pr" ? "pr" : "workItem", id, repo) };
}

/** A session target: an id of the right shape, and never a repo. */
function sessionTarget(value: string, repo: string | undefined): ParsedFocusUrl {
  if (repo !== undefined) return refuse("repo goes only with pr or workItem");
  return isSessionToken(value) ? { ok: true, target: { kind: "session", token: value } } : refuse("malformed session id");
}

/** A pr / workItem target, carrying `repo` only when there is one. */
export function itemTarget(kind: "pr" | "workItem", id: number, repo: string | undefined): FocusTarget {
  return repo === undefined ? { kind, id } : { kind, id, repo };
}

/** Parse an agendo:// URL; see the header for exactly what is accepted. */
export function parseFocusUrl(url: unknown): ParsedFocusUrl {
  if (typeof url !== "string" || url.length === 0) return refuse("no URL given");
  if (url.length > MAX_URL_LENGTH) return refuse("URL too long");
  if (!url.startsWith("agendo://")) return refuse("not an agendo:// URL");
  const m = URL_RE.exec(url);
  if (!m) return refuse("only agendo://focus?pr=<n>, ?workItem=<n> (each with an optional &repo=) or ?session=<id or window name> is accepted");
  return targetFor(m[1], m[2], m[3]);
}

/**
 * How a LINK's target is named in a notification: only the number, never the
 * repo or session token. Those are free text a web page chose — shape-checked,
 * but enough to put "reinstall-agendo-from-evil.example" in an agendo-branded
 * notification. stderr still gets `describeTarget`.
 */
export function describeLinkTarget(t: FocusTarget): string {
  if (t.kind === "session") return "the linked session";
  return t.kind === "pr" ? `PR !${t.id}` : `work item #${t.id}`;
}

/** How a target is named to a human: `PR !5001`, `work item #102`, `session abc`. */
export function describeTarget(t: FocusTarget): string {
  if (t.kind === "session") return `session ${t.token}`;
  const what = t.kind === "pr" ? `PR !${t.id}` : `work item #${t.id}`;
  return t.repo ? `${what} in ${t.repo}` : what;
}
