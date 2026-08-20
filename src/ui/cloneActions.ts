import { basename } from "path";
import { homedir } from "os";
import {
  parseRepoUrl,
  cloneDirName,
  findMatchingCheckout,
  freeCloneDest,
  enclosingCheckout,
  startClone,
  repoUrlLabel,
  type CloneRun,
} from "../clone.ts";
import { normalizeCwd } from "../context.ts";
import { cloneError, homeShort } from "./format.ts";
import type { RepoInfo } from "../repos.ts";
import type { AgentSource } from "../types.ts";
import type { FreshTarget } from "./targets.ts";
import type { Mode } from "./keys/context.ts";

/**
 * The clone step's ACTIONS, as opposed to its state (which lives in
 * `useCloneFlow`). These are plain closures, not hooks — they were lifted out of
 * App verbatim, and the reason they can move at all is that they call nothing
 * React-shaped: no `useState`, no effect, nothing whose position in the render
 * matters. The factory is invoked from the line the block occupied, so nothing
 * about App's hook or effect order changes.
 *
 * They stay separate from `useCloneFlow` deliberately. That hook is called near
 * the top of App, before `open` and `chooseRepo` exist; these handlers need both.
 * Folding them in would mean either moving the hook call — which would reorder
 * two effects — or threading the callbacks through a ref to dodge the
 * temporal-dead-zone. Both are worse than one more small module.
 */
export function makeCloneActions({
  scoped,
  filterRoot,
  cloneRun,
  cloneNoteRef,
  setMode,
  setNotice,
  setCloned,
  setCloneNote,
  chooseRepo,
}: {
  scoped: boolean;
  filterRoot: string | null;
  cloneRun: { current: CloneRun | null };
  cloneNoteRef: { current: string | null };
  setMode: (m: Mode | ((p: Mode) => Mode)) => void;
  setNotice: (n: string | null) => void;
  setCloned: (f: (prev: RepoInfo[]) => RepoInfo[]) => void;
  setCloneNote: (n: string | null) => void;
  chooseRepo: (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => void;
}) {
  // ── clone a repo that isn't on disk yet ──
  // Gated on `canClone`: agendo must have been given a target directory, since
  // that directory is the only place it may write. See docs/cloning.md.
  //
  // …and that directory must not be inside a git checkout. The clone lands as a
  // direct child of it, so scoping to a repo (`agendo .`, `agendo ~/git/myrepo`,
  // or any path under one — all of which the scoping logic supports) would drop
  // a nested repository into that repo's working tree, where it sits as
  // untracked clutter forever. Cloning belongs in a folder OF checkouts, not in
  // one. `enclosingCheckout` walks up, but stops below $HOME — see there for why.
  const canClone = scoped && !!filterRoot && !enclosingCheckout(filterRoot, homedir());

  /** A freshly cloned (or matched) checkout, as a zero-session picker entry. */
  const clonedRepo = (root: string): RepoInfo => ({
    root,
    name: basename(root) || root,
    total: 0,
    claude: 0,
    copilot: 0,
    codex: 0,
  });

  /** Remember the checkout and continue into the ordinary session flow. */
  const adoptClonedRepo = (target: FreshTarget, agent: AgentSource, root: string, note: string) => {
    const repo = clonedRepo(root);
    setCloned((prev) =>
      prev.some((r) => normalizeCwd(r.root) === normalizeCwd(root)) ? prev : [...prev, repo],
    );
    setNotice(note);
    setCloneNote(note);
    cloneNoteRef.current = note;
    chooseRepo(target, repo, agent);
  };

  /**
   * Enter on the URL prompt. Resolves where the repo should live before touching
   * the network: an existing checkout of the same repo anywhere in the target
   * directory wins outright (never a second copy), otherwise a free directory
   * name is chosen and the clone starts.
   */
  const beginClone = (target: FreshTarget, agent: AgentSource, raw: string) => {
    const url = parseRepoUrl(raw);
    const fail = (...error: string[]) =>
      setMode({ kind: "clone", target, agent, value: raw, cursor: raw.length, error });
    if (!url) return fail("Not a recognizable GitHub or Azure DevOps repo URL.");

    const existing = findMatchingCheckout(filterRoot!, url.key);
    if (existing) {
      return adoptClonedRepo(target, agent, existing, `already cloned — using ${homeShort(existing)}`);
    }

    const dest = freeCloneDest(filterRoot!, cloneDirName(url.repo));
    if (!dest) return fail(`No free directory name for "${url.repo}" in ${homeShort(filterRoot!)}.`);

    setMode({ kind: "cloning", target, agent, url, dest, progress: "starting…", elapsed: 0 });
    const run = startClone(url.remote, dest, (line) =>
      setMode((p) => (p.kind === "cloning" ? { ...p, progress: line } : p)),
    );
    cloneRun.current = run;
    run.done.then((res) => {
      if (cloneRun.current !== run) return; // superseded by a newer attempt
      cloneRun.current = null;
      if (res.canceled) {
        setNotice("Clone cancelled.");
        return setMode({ kind: "repo", target, agent, cursor: 0 });
      }
      if (!res.ok) return fail(...cloneError(res));
      const landed = basename(dest) === cloneDirName(url.repo) ? "" : ` as ${basename(dest)}`;
      adoptClonedRepo(target, agent, dest, `cloned ${repoUrlLabel(url)}${landed} into ${homeShort(dest)}`);
    });
  };

  /** Cancel an in-flight clone (esc) — kills git and removes the partial dir. */
  const cancelClone = () => {
    cloneRun.current?.cancel();
  };

  return { canClone, beginClone, cancelClone };
}
