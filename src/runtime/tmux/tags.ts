// The window tag: turning a `WindowTags` record into the `-F` fields a live scan
// reads, and back again. Pure string work — the WRITE lives in windows.ts, with
// every other command that changes the server.
//
// Sits between names.ts (which owns the `@cl_*` option names and the record
// shape) and server.ts (which splices the format below into the one `list-panes`
// it already runs), so it may import only from names.ts.
import {
  ACQUIRED_OPTION, BRANCH_OPTION, ITEM_OPTION, PR_OPTION, SESSION_ID_OPTION, SOURCE_OPTION,
  type WindowAcquisition, type WindowTags,
} from "./names.ts";
import { AGENTS, type AgentSource } from "../../shared/types.ts";

/**
 * The tag's field order, and the single place it is written down.
 *
 * `windowTagsFormat` emits the options in this order and `parseWindowTags` reads
 * them back in it, so the two cannot drift into misreading one field as another
 * — the failure that would attribute a window to whatever happened to sit in the
 * branch column. Appending a field is safe; reordering or removing one is not,
 * because a window stamped by an older agendo is still on screen.
 */
const TAG_OPTIONS = [
  SESSION_ID_OPTION, SOURCE_OPTION, ACQUIRED_OPTION, BRANCH_OPTION, PR_OPTION, ITEM_OPTION,
] as const;

/** How many `-F` fields `windowTagsFormat` contributes (see `parseWindowTags`). */
export const WINDOW_TAG_FIELDS = TAG_OPTIONS.length;

/**
 * The tag's contribution to a tmux `-F` format string: one `#{@cl_…}` reference
 * per field, in `TAG_OPTIONS` order, joined by the caller's own separator.
 *
 * Costs no extra tmux invocation — it is spliced into a format the live scan
 * already runs. Verified against tmux 3.4: a bare `#{@name}` reference to an
 * UNSET user option renders as the empty string and does not fail the command,
 * unlike `show-options -v` which exits 1 with `invalid option`. That is what
 * lets one format serve tagged and untagged windows alike, which matters because
 * every window that existed before this shipped is untagged and must keep
 * working (see `parseWindowTags`).
 */
export function windowTagsFormat(separator: string): string {
  return TAG_OPTIONS.map((o) => `#{${o}}`).join(separator);
}

/** A tmux option value a `\t`-joined format could not survive a round trip of. */
function sanitize(value: string): string {
  return value.replace(/[\t\r\n]+/g, " ").trim();
}

/** A positive integer tag value (PR / work-item number), or undefined. */
function positiveInt(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * Read a tag back out of `WINDOW_TAG_FIELDS` consecutive `-F` fields, or
 * undefined when the window carries no tag at all.
 *
 * UNDEFINED IS THE IMPORTANT ANSWER. Every window opened before tagging shipped
 * reports all-empty fields, and so does any window agendo did not create; those
 * must fall through to the name/cwd attribution that has always handled them
 * rather than be treated as a window claiming to belong to no session. So an
 * all-empty read is "no tag", not "an empty tag".
 *
 * Each field is validated rather than trusted. These are tmux options: a user
 * can set them by hand, a stale one can outlive the agendo that wrote it, and a
 * future field appended to `TAG_OPTIONS` will read back empty from a window an
 * older agendo stamped. An unrecognised `source` or `acquired`, or a
 * non-numeric PR / work-item number, is therefore dropped as if absent — which
 * degrades that window to the old heuristic instead of attributing it wrongly.
 */
export function parseWindowTags(fields: string[]): WindowTags | undefined {
  const [sessionId, source, acquired, branch, pr, item] = TAG_OPTIONS.map((_, i) => sanitize(fields[i] ?? ""));
  const tags: WindowTags = {};
  if (sessionId) tags.sessionId = sessionId;
  if (AGENTS.includes(source as AgentSource)) tags.source = source as AgentSource;
  if (acquired === "launched" || acquired === "adopted") tags.acquired = acquired as WindowAcquisition;
  if (branch) tags.branch = branch;
  const prId = positiveInt(pr);
  if (prId !== undefined) tags.pr = prId;
  const itemId = positiveInt(item);
  if (itemId !== undefined) tags.item = itemId;
  return Object.keys(tags).length > 0 ? tags : undefined;
}

/**
 * The `[option, value]` pairs a stamp should write for `tags` — one per field
 * the caller actually knows, in `TAG_OPTIONS` order.
 *
 * A field the record leaves undefined yields NO PAIR rather than an empty one,
 * so stamping a partially-known tag (a Codex window, whose session id does not
 * exist yet) never clears a field some earlier stamp got right. Values are
 * sanitized here rather than at the call site because it is the read format,
 * not the writer, that cannot survive a tab.
 */
export function windowTagArgs(tags: WindowTags): [string, string][] {
  const values: Record<(typeof TAG_OPTIONS)[number], string | undefined> = {
    [SESSION_ID_OPTION]: tags.sessionId,
    [SOURCE_OPTION]: tags.source,
    [ACQUIRED_OPTION]: tags.acquired,
    [BRANCH_OPTION]: tags.branch,
    [PR_OPTION]: tags.pr === undefined ? undefined : String(tags.pr),
    [ITEM_OPTION]: tags.item === undefined ? undefined : String(tags.item),
  };
  const out: [string, string][] = [];
  for (const option of TAG_OPTIONS) {
    const raw = values[option];
    if (raw === undefined) continue;
    const value = sanitize(raw);
    if (value) out.push([option, value]);
  }
  return out;
}
