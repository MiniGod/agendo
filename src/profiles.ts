// Claude config PROFILES — the several `~/.claude*` dirs a user may run
// (`~/.claude`, `~/.claude-work`, …), each its own subscription/login with its
// own `projects/` transcript store. Two jobs live here:
//
//   • DISCOVERY + IDENTITY (`discoverProfiles` / `dedupeProfiles`): which
//     profiles exist, and which of them are actually the SAME store reached
//     under two names (a symlinked `~/.claude`, or a `projects/` folder
//     symlinked between profiles). sessions.ts scans the deduped list, so a
//     symlinked store is walked — and listed — once.
//   • RELOCATION (`moveSessionToProfile`): move one session's on-disk files from
//     the profile it landed in to another. A move, never a copy: two transcripts
//     with the same session id would diverge, and SessionIndex.build() dedupes by
//     `source:id`, so the second copy would silently vanish from the UI anyway.
//
// Everything returns `{ error }` rather than throwing — the TUI surfaces it as a
// yellow notice and stays alive.
import { readdir, realpath, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import type { AgentSession } from "./types.ts";
import type { ClaudeProfile } from "./profiles/types.ts";

export type { ClaudeProfile };
export { __setForceCrossDevice, moveSessionToProfile, type MoveResult } from "./profiles/move.ts";

/**
 * Every `~/.claude*` dir that has a `projects/` subdir, name-sorted.
 *
 * `stat()` follows symlinks, so a `~/.claude` pointing into a dotfiles repo works
 * and non-dirs like `~/.claude.json` are skipped (no projects subdir). The list
 * is the raw union of what's on disk — aliases included, which is what the
 * profile picker wants to show; `dedupeProfiles` is what the scanner wants.
 */
export async function discoverProfiles(): Promise<ClaudeProfile[]> {
  const home = homedir();
  let entries: string[];
  try {
    entries = await readdir(home);
  } catch {
    return [];
  }
  const out: ClaudeProfile[] = [];
  await Promise.all(
    entries.map(async (e) => {
      if (!e.startsWith(".claude")) return;
      const configDir = join(home, e);
      const projects = join(configDir, "projects");
      const st = await stat(projects).catch(() => null);
      if (!st?.isDirectory()) return;
      out.push({
        configDir,
        projects,
        name: e,
        realProjects: await realpath(projects).catch(() => projects),
      });
    }),
  );
  // Deterministic order: the scan, the dedupe tie-breaks below, and the picker
  // all inherit it, so the same disk always yields the same list.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * One profile per distinct transcript store, so a store symlinked between two
 * `~/.claude*` names is scanned (and its sessions listed) exactly once.
 *
 * Ties are broken in favour of the REALPATH OWNER — the profile that reaches the
 * store without traversing a symlink — so sessions are attributed to the dir
 * that actually holds them. When neither owns it (e.g. `~/.claude` itself is a
 * symlink into a dotfiles repo, so every route is indirect) the first by name
 * wins, which the sort in `discoverProfiles` makes stable.
 */
export function dedupeProfiles(profiles: ClaudeProfile[]): ClaudeProfile[] {
  const byStore = new Map<string, ClaudeProfile>();
  for (const p of profiles) {
    const prev = byStore.get(p.realProjects);
    if (!prev || (!owns(prev) && owns(p))) byStore.set(p.realProjects, p);
  }
  return [...byStore.values()];
}

/** Whether a profile reaches its store directly (no symlink on the way). */
function owns(p: ClaudeProfile): boolean {
  return p.projects === p.realProjects;
}

/** One profile as offered by the "move to another profile" picker. */
export interface ProfileChoice {
  profile: ClaudeProfile;
  /** The session already lives here — shown for orientation, not selectable. */
  current: boolean;
}

/**
 * The picker's rows: every discovered profile, with the session's own marked.
 * "Own" is decided on the STORE (realpath), not the dir name, so an alias of the
 * session's profile is correctly greyed out instead of offering a move that
 * would do nothing.
 */
export function profileChoices(profiles: ClaudeProfile[], s: AgentSession): ProfileChoice[] {
  const mine = profiles.find((p) => p.configDir === s.configDir);
  return profiles.map((profile) => ({
    profile,
    current: mine ? profile.realProjects === mine.realProjects : profile.configDir === s.configDir,
  }));
}
