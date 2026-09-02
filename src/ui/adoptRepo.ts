import { basename } from "path";
import { normalizeCwd } from "../context.ts";
import type { RepoInfo } from "../repos.ts";
import type { AgentSource } from "../types.ts";
import type { FreshTarget } from "./targets.ts";

/**
 * "This checkout now exists — carry on as if it had been picked from the list."
 * The one hand-off shared by every way a repo can come into being mid-flow: a
 * clone that just finished, an existing checkout a pasted URL matched, a folder
 * `git init` just created. It remembers the checkout so the picker offers it
 * until a reload discovers it for real, records the one-line note the next
 * screens show as `✓ …`, and calls the same `chooseRepo` the picker's enter key
 * calls — so there is no second session-creation flow.
 */
export function makeAdoptRepo({
  setNotice,
  setCloned,
  setCloneNote,
  cloneNoteRef,
  chooseRepo,
}: {
  setNotice: (n: string | null) => void;
  setCloned: (f: (prev: RepoInfo[]) => RepoInfo[]) => void;
  setCloneNote: (n: string | null) => void;
  cloneNoteRef: { current: string | null };
  chooseRepo: (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => void;
}) {
  /** A fresh checkout as a zero-session picker entry. */
  const asRepo = (root: string): RepoInfo => ({
    root,
    name: basename(root) || root,
    total: 0,
    claude: 0,
    copilot: 0,
    codex: 0,
  });

  return (target: FreshTarget, agent: AgentSource, root: string, note: string) => {
    const repo = asRepo(root);
    setCloned((prev) =>
      prev.some((r) => normalizeCwd(r.root) === normalizeCwd(root)) ? prev : [...prev, repo],
    );
    setNotice(note);
    setCloneNote(note);
    cloneNoteRef.current = note;
    chooseRepo(target, repo, agent);
  };
}
