import { openUrlAsync } from "../browser.ts";
import { SELF_CMD } from "../launch.ts";
import { linkLine, linkVocab, printLine } from "../output.ts";
import { type SessionScope, scopeFilter, scopeNote } from "../scope.ts";
import { SessionIndex } from "../sessions.ts";
import { shortId } from "../tmux.ts";
import { resolveSessionLink } from "./links.ts";

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
export async function runOpen(
  token: string | undefined,
  want: "pr" | "item" | undefined,
  printOnly: boolean,
  scope: SessionScope | null,
): Promise<void> {
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
  const resolved = await resolveSessionLink(s, "open");
  const V = linkVocab(resolved.provider);
  if (resolved.error) {
    console.error(`open: could not resolve associations from the backend: ${resolved.error}`);
    process.exit(1);
  }
  // A link the backend couldn't give a URL for (a payload missing the repo scope
  // its link needs) counts as absent: better to say "nothing to open" than to
  // launch — or hand a human — a partial URL.
  const pr = resolved.link?.pr?.url ? resolved.link.pr : undefined;
  const workItem = resolved.link?.workItem?.url ? resolved.link.workItem : undefined;
  if (!pr && !workItem) {
    console.error(
      `Session ${shortId(s.id)} has no linked pull request or ${V.noun} to open.\n` +
        `  (links resolve against the backend's OPEN PRs / ${V.noun}s for the current identity — ` +
        `a merged or out-of-scope one won't be found.)`,
    );
    process.exit(1);
  }
  // An explicit selector that can't be honoured names what IS available, so the
  // caller can retry with the other flag instead of guessing.
  if (want === "pr" && !pr) {
    console.error(`Session ${shortId(s.id)} has no linked pull request (only ${V.noun} #${workItem!.id}).`);
    process.exit(1);
  }
  if (want === "item" && !workItem) {
    console.error(`Session ${shortId(s.id)} has no linked ${V.noun} (only PR ${V.prPrefix}${pr!.id}).`);
    process.exit(1);
  }

  // Awaited writes: this text is what the caller came for, and the dispatch
  // exits the moment we return (see printLine).
  if (pr) await printLine(linkLine("pr", `${V.prPrefix}${pr.id}`, pr.url));
  if (workItem) await printLine(linkLine(V.abbrev, `#${workItem.id}`, workItem.url));
  if (printOnly) return;

  // Default to the PR when both exist: it's the artifact you act on, and the
  // work item is one line above if that's what you wanted.
  const target = want === "item" ? workItem! : want === "pr" ? pr! : pr ?? workItem!;
  const label = target === pr ? `PR ${V.prPrefix}${target.id}` : `${V.noun} #${target.id}`;
  try {
    await openUrlAsync(target.url);
    await printLine(`▸ opened ${label} in your browser`);
  } catch (e) {
    // No opener on this host (headless, container, stripped image). The URL is
    // already on stdout, so this is a warning, not a failure.
    console.error(`Couldn't launch a browser (${(e as Error)?.message ?? e}) — the URL above is still valid.`);
  }
}
