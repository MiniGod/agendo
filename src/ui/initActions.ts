import { homedir } from "os";
import { enclosingCheckout } from "../clone.ts";
import { normalizeCwd } from "../context.ts";
import { initRepo, inspectInitDest, rankParentDirs, repoNameError, resolveParentInput } from "../initRepo.ts";
import { isGitCheckout, type RepoInfo } from "../repos.ts";
import { makeAdoptRepo } from "./adoptRepo.ts";
import { homeShort } from "./format.ts";
import type { LoadedModel } from "../model.ts";
import type { AgentSource } from "../types.ts";
import type { FreshTarget } from "./targets.ts";
import type { InitParentMode, Mode } from "./keys/context.ts";

/**
 * The new-local-repo step's ACTIONS — the `git init` counterpart of
 * `makeCloneActions`, built the same way and for the same reasons: plain
 * closures, no hooks, invoked from App after `chooseRepo` exists because that
 * is what the hand-off calls. Unlike cloning there is no gate on the scope:
 * the user names the parent folder, so agendo never has to guess where to write.
 */
export function makeInitActions({
  model,
  cloned,
  scoped,
  filterRoot,
  setMode,
  setNotice,
  setCloned,
  setCloneNote,
  cloneNoteRef,
  chooseRepo,
}: {
  model: LoadedModel | null;
  cloned: RepoInfo[];
  scoped: boolean;
  filterRoot: string | null;
  setMode: (m: Mode) => void;
  setNotice: (n: string | null) => void;
  setCloned: (f: (prev: RepoInfo[]) => RepoInfo[]) => void;
  setCloneNote: (n: string | null) => void;
  cloneNoteRef: { current: string | null };
  chooseRepo: (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => void;
}) {
  const adopt = makeAdoptRepo({ setNotice, setCloned, setCloneNote, cloneNoteRef, chooseRepo });

  /**
   * Where the new repo could go: the parent folders of every checkout agendo
   * knows about (from session history, the path scan and this run's clones),
   * most common first. Only real checkouts count — a session run in a plain
   * folder yields a repo entry too, and its parent is just noise. The scoped
   * folder, when it is a folder OF checkouts rather than one itself, goes first:
   * `agendo ~/git` is a statement about where the user is working today.
   */
  const parentCandidates = (): string[] => {
    const roots = [...(model?.repos ?? []), ...cloned].map((r) => r.root).filter(isGitCheckout);
    const ranked = rankParentDirs(roots);
    if (!scoped || !filterRoot || enclosingCheckout(filterRoot, homedir())) return ranked;
    const first = normalizeCwd(filterRoot);
    return [first, ...ranked.filter((p) => p !== first)];
  };

  /** Enter on the name prompt: check the name, then ask where it should go. */
  const beginInitDir = (target: FreshTarget, agent: AgentSource, rawName: string) => {
    const error = repoNameError(rawName);
    if (error) return setMode({ kind: "initName", target, agent, value: rawName, cursor: rawName.length, error });
    const name = rawName.trim();
    const candidates = parentCandidates();
    // Nothing known yet (a first run): there is no list to show, so go straight
    // to the typed path — the one option that is always there.
    if (candidates.length === 0) return setMode({ kind: "initPath", target, agent, name, candidates, value: "", cursor: 0 });
    setMode({ kind: "initDir", target, agent, name, candidates, cursor: 0 });
  };

  /**
   * A parent folder has been chosen (a list row, or the typed path). Resolves
   * and inspects the destination before touching the disk, and every refusal
   * lands back on the same screen with the reason — nothing is created unless
   * the folder is free or empty. A folder that is already a repo is offered
   * as-is: `existing` marks the offer, and a second enter on it accepts.
   */
  const beginInit = (mode: InitParentMode, rawParent: string) => {
    const fail = (error: string) => setMode({ ...mode, error, existing: undefined });
    const parent = resolveParentInput(rawParent, homedir());
    if (!parent) return fail("Type an absolute path (~/… works too).");
    const info = inspectInitDest(parent, mode.name);
    const at = homeShort(info.dest);
    if (info.parent === "file") return fail(`${homeShort(parent)} is a file, not a folder.`);
    if (info.state === "file") return fail(`${at} already exists and is a file.`);
    if (info.state === "nonempty") return fail(`${at} already exists and is not empty — pick another name or folder.`);
    if (info.state === "repo") {
      if (mode.existing === info.dest) return adopt(mode.target, mode.agent, info.dest, `using the existing repo at ${at}`);
      return setMode({ ...mode, error: undefined, existing: info.dest });
    }
    const res = initRepo(info.dest);
    if (!res.ok) return fail(res.error ?? "git init failed");
    const where = res.createdParent ? `${at} (its parent folder didn't exist — created it too)` : at;
    const commit = res.committed ? "" : ` · no initial commit: ${res.commitError}`;
    adopt(mode.target, mode.agent, info.dest, `created new repo at ${where}${commit}`);
  };

  return { beginInitDir, beginInit };
}
