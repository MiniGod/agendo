import { openUrlAsync } from "../browser.ts";
import { SELF_CMD } from "../launch.ts";
import { linkLine, linkVocab, printLine } from "../output.ts";
import { type SessionScope, scopeFilter, scopeNote } from "../scope.ts";
import { SessionIndex } from "../sessions.ts";
import { shortId } from "../tmux.ts";
import { resolveSessionLink, usableLinks } from "./links.ts";
import type { SessionLink } from "../model.ts";
import type { AgentSession } from "../types.ts";

/**
 * Open a session's linked PR / work item in the browser — the CLI mirror of the
 * menu's `o` action, down to the shared `openUrl` path. `want` picks the entity
 * when the session has both (the menu asks p/i; the CLI defaults to the PR).
 *
 * Every URL we resolved is printed BEFORE anything is launched, because the link
 * itself is the deliverable: a headless host with no opener, or `--print`, still
 * leaves the caller with a full clickable URL rather than an error. A missing
 * link is a clean message, never a stack trace.
 */
type Link = NonNullable<SessionLink["pr"]>;
type Vocab = ReturnType<typeof linkVocab>;

// Resolve the token to one on-disk session, or exit having said why.
async function resolveOpenTarget(token: string | undefined, scope: SessionScope | null): Promise<AgentSession> {
  if (!token) {
    console.error(
      `usage: ${SELF_CMD} open <id> [--pr | --work-item] [--print] [--path <dir>] [--repo <name>]`,
    );
    process.exit(1);
  }
  const sid = token.match(/^cl-[a-z]+-(.+)$/)?.[1] ?? shortId(token);
  const index = await SessionIndex.build();
  const inScope = scopeFilter(scope);
  const s = index.all.find((x) => (x.id === token || shortId(x.id) === sid) && inScope(x));
  if (!s) {
    // No live-window fallback here (unlike `status`): a session too young to have
    // a transcript has no links to open anyway.
    console.error(`No session found for "${token}"${scopeNote(scope)}.`);
    process.exit(1);
  }
  return s;
}

// The session's links with a URL, or exit: the backend could not be asked, or
// it knows of nothing open for this session. A link the backend couldn't give a
// URL for (a payload missing the repo scope its link needs) counts as absent:
// better to say "nothing to open" than to launch — or hand a human — a partial
// URL.
export function linksToOpen(sid: string, resolved: Awaited<ReturnType<typeof resolveSessionLink>>, V: Vocab): { pr?: Link; workItem?: Link } {
  if (resolved.error) {
    console.error(`open: could not resolve associations from the backend: ${resolved.error}`);
    process.exit(1);
  }
  const { pr, workItem } = usableLinks(resolved.link);
  if (!pr && !workItem) {
    console.error(
      `Session ${sid} has no linked pull request or ${V.noun} to open.\n` +
        `  (links resolve against the backend's OPEN PRs / ${V.noun}s for the current identity — ` +
        `a merged or out-of-scope one won't be found.)`,
    );
    process.exit(1);
  }
  return { pr, workItem };
}

// An explicit selector that can't be honoured names what IS available, so the
// caller can retry with the other flag instead of guessing.
export function refuseMissing(sid: string, want: "pr" | "item" | undefined, links: { pr?: Link; workItem?: Link }, V: Vocab): void {
  if (want === "pr" && !links.pr) {
    console.error(`Session ${sid} has no linked pull request (only ${V.noun} #${links.workItem!.id}).`);
    process.exit(1);
  }
  if (want === "item" && !links.workItem) {
    console.error(`Session ${sid} has no linked ${V.noun} (only PR ${V.prPrefix}${links.pr!.id}).`);
    process.exit(1);
  }
}

/**
 * What to open: the entity asked for, else the PR, else the item. Default to
 * the PR when both exist: it's the artifact you act on, and the work item is
 * one line above if that's what you wanted.
 */
export function chooseTarget(want: "pr" | "item" | undefined, links: { pr?: Link; workItem?: Link }): Link {
  if (want === "item") return links.workItem!;
  if (want === "pr") return links.pr!;
  return links.pr ?? links.workItem!;
}

async function openTarget(url: string, label: string, open: (url: string) => Promise<void> = openUrlAsync): Promise<void> {
  try {
    await open(url);
    await printLine(`▸ opened ${label} in your browser`);
  } catch (e) {
    // No opener on this host (headless, container, stripped image). The URL is
    // already on stdout, so this is a warning, not a failure.
    console.error(`Couldn't launch a browser (${(e as Error)?.message ?? e}) — the URL above is still valid.`);
  }
}

export async function runOpen(
  token: string | undefined,
  want: "pr" | "item" | undefined,
  printOnly: boolean,
  scope: SessionScope | null,
): Promise<void> {
  const s = await resolveOpenTarget(token, scope);
  const resolved = await resolveSessionLink(s, "open");
  const V = linkVocab(resolved.provider);
  const links = linksToOpen(shortId(s.id), resolved, V);
  refuseMissing(shortId(s.id), want, links, V);
  // Awaited writes: this text is what the caller came for, and the dispatch
  // exits the moment we return (see printLine).
  if (links.pr) await printLine(linkLine("pr", `${V.prPrefix}${links.pr.id}`, links.pr.url));
  if (links.workItem) await printLine(linkLine(V.abbrev, `#${links.workItem.id}`, links.workItem.url));
  if (printOnly) return;
  const target = chooseTarget(want, links);
  const label = target === links.pr ? `PR ${V.prPrefix}${target.id}` : `${V.noun} #${target.id}`;
  await openTarget(target.url, label);
}
