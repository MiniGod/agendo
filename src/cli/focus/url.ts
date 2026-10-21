// Parsing an `agendo://` URL into the one thing it may ask for.
//
// THIS IS A SECURITY BOUNDARY. Once the scheme handler is installed, ANY web page
// can navigate to an agendo:// link, and the browser hands the string to
// `agendo url` with nothing but a one-time "open this app?" prompt in between. So
// the parser is an allowlist, not a sanitizer: it accepts exactly
//
//     agendo://focus?pr=<digits>
//     agendo://focus?workItem=<digits>
//     agendo://focus?session=<session id or short id>
//
// (an empty path, `agendo://focus/?…`, is tolerated because browsers differ on
// whether they add one) and refuses everything else outright. It never decodes:
// a `%` anywhere is a refusal, so an encoded separator, NUL or newline cannot
// smuggle a second parameter or a path past the shape check. Nothing it returns
// is ever passed through a shell, and the only action a parsed URL can lead to is
// focusing — or resuming, then focusing — a session that already exists.

/** What a URL (or `agendo focus`'s own flags) asks to focus. */
export type FocusTarget =
  | { kind: "pr"; id: number }
  | { kind: "workItem"; id: number }
  | { kind: "session"; token: string };

export type ParsedFocusUrl = { ok: true; target: FocusTarget } | { ok: false; reason: string };

/** Longer than any URL the allowlist below can match, by a margin. */
export const MAX_URL_LENGTH = 128;

/** Digits only, no leading zero, at most 10 of them (ADO and GitHub ids are int32). */
const ID_RE = /^[1-9]\d{0,9}$/;

/**
 * A session id (a uuid, or a fixture-style slug) or the 12-character short id
 * `list` prints: letters, digits and inner dashes, starting with a letter or
 * digit so it can never read as a flag.
 */
const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/** The whole URL: one known verb, one key, one value, nothing else at all. */
const URL_RE = /^agendo:\/\/focus\/?\?(pr|workItem|session)=([A-Za-z0-9-]+)$/;

const refuse = (reason: string): ParsedFocusUrl => ({ ok: false, reason });

/** An item id from a URL or a flag, or null when it is not one. */
export function parseItemId(raw: string): number | null {
  if (!ID_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n <= 0x7fffffff ? n : null;
}

/** Is `raw` a session token a URL may carry? */
export function isSessionToken(raw: string): boolean {
  return SESSION_RE.test(raw);
}

/** The value checked against its key's own shape. */
function targetFor(key: string, value: string): ParsedFocusUrl {
  if (key === "session") {
    return isSessionToken(value) ? { ok: true, target: { kind: "session", token: value } } : refuse("malformed session id");
  }
  const id = parseItemId(value);
  if (id === null) return refuse(`malformed ${key} id`);
  return { ok: true, target: key === "pr" ? { kind: "pr", id } : { kind: "workItem", id } };
}

/** Parse an agendo:// URL; see the header for exactly what is accepted. */
export function parseFocusUrl(url: unknown): ParsedFocusUrl {
  if (typeof url !== "string" || url.length === 0) return refuse("no URL given");
  if (url.length > MAX_URL_LENGTH) return refuse("URL too long");
  if (!url.startsWith("agendo://")) return refuse("not an agendo:// URL");
  const m = URL_RE.exec(url);
  if (!m) return refuse("only agendo://focus?pr=<n>, ?workItem=<n> or ?session=<id> is accepted");
  return targetFor(m[1], m[2]);
}

/** How a target is named to a human: `PR !5001`, `work item #102`, `session abc`. */
export function describeTarget(t: FocusTarget): string {
  if (t.kind === "pr") return `PR !${t.id}`;
  if (t.kind === "workItem") return `work item #${t.id}`;
  return `session ${t.token}`;
}
