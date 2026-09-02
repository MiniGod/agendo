import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { LoadedModel } from "../../model.ts";
import type { OpenPlan } from "../../launch.ts";
import type { ClaudeProfile, ProfileChoice } from "../../profiles.ts";
import type { RepoInfo } from "../../repos.ts";
import type { RepoUrl } from "../../clone.ts";
import type { AgentSession, AgentSource, Identity, ProviderName, TeamMember } from "../../types.ts";
import type { Activity } from "../format.ts";
import type { FreshTarget, OpenTargets } from "../targets.ts";
import type { PrSort, Row, SessionSort } from "../rows.ts";

// ── top-level views & fresh-session flow state ────────────────────────────────
export type View = "items" | "prs" | "sessions";

export type Mode =
  | { kind: "list" }
  | { kind: "settings"; cursor: number }
  // `fromSettings` routes the picker back to the Settings page (not the list)
  // on cancel, so Settings acts as a hub you drill into and return to.
  | { kind: "provider"; cursor: number; fromSettings?: boolean }
  | { kind: "identity"; cursor: number; fromSettings?: boolean }
  | { kind: "agent"; target: FreshTarget; cursor: number }
  | { kind: "repo"; target: FreshTarget; agent: AgentSource; cursor: number }
  // Clone flow — only reachable from a scoped launcher (see `canClone`). `clone`
  // is the URL prompt; `cloning` is the live `git clone`, cancellable with esc.
  | { kind: "clone"; target: FreshTarget; agent: AgentSource; value: string; cursor: number; error?: string[] }
  | { kind: "cloning"; target: FreshTarget; agent: AgentSource; url: RepoUrl; dest: string; progress: string; elapsed: number }
  // New-local-repo flow (docs/new-local-repo.md), the clone row's sibling and
  // never gated on the scope: the user names the parent folder themselves.
  // `initName` asks for the folder name; `initDir` lists the parent folders of
  // every known checkout (`candidates`, most common first) plus a free-text row
  // that opens `initPath`. `existing` is set once enter has landed on a folder
  // that is already a repo — a second enter then adopts it as-is.
  | { kind: "initName"; target: FreshTarget; agent: AgentSource; value: string; cursor: number; error?: string }
  | { kind: "initDir"; target: FreshTarget; agent: AgentSource; name: string; candidates: string[]; cursor: number; error?: string; existing?: string }
  | { kind: "initPath"; target: FreshTarget; agent: AgentSource; name: string; candidates: string[]; value: string; cursor: number; error?: string; existing?: string }
  | { kind: "wtchoice"; target: FreshTarget; agent: AgentSource; repo: RepoInfo; cursor: number }
  // `seed` is the value the field was PREFILLED with (orchestrator flow only).
  // Kept so submit can tell an untouched default from a name the user chose, and
  // re-derive a free one — the prefill was computed when the screen opened, which
  // may be minutes before enter is pressed.
  | { kind: "branch"; target: FreshTarget; agent: AgentSource; repo: RepoInfo; value: string; cursor: number; worktree: boolean; seed?: string }
  // "move this session to another Claude profile". `choices` is every discovered
  // profile with the session's own flagged (see profileChoices) — shown for
  // orientation but skipped by the cursor, since moving somewhere you already are
  // is not a choice.
  | { kind: "profile"; session: AgentSession; choices: ProfileChoice[]; cursor: number }
  | { kind: "open"; targets: OpenTargets; title: string };

/** The two screens on which a parent folder can be chosen for a new repo. */
export type InitParentMode = Extract<Mode, { kind: "initDir" | "initPath" }>;

/**
 * Everything the keyboard handlers in this directory read or drive, built once
 * per render in App.tsx and passed down.
 *
 * Each handler takes a `Pick<KeyContext, …>` of exactly the members it touches,
 * so a module's signature documents its own reach: adding a field to a handler
 * is a visible edit, not a silent one.
 */
export type KeyContext = {
  // ── app-wide ──
  exit: () => void;
  model: LoadedModel | null;
  filterRoot: string | null;

  // ── mode / navigation state ──
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  view: View;
  switchView: (v: View) => void;
  cursor: number;
  setCursor: Dispatch<SetStateAction<number>>;
  rows: Row[];
  selectableIdx: number[];
  move: (dir: 1 | -1) => void;
  toggleExpand: (key: string) => void;
  toggleSection: (id: string) => void;
  ensureActivity: (s: AgentSession) => void;

  // ── search ──
  searchFocus: "input" | "list" | null;
  setSearchFocus: Dispatch<SetStateAction<"input" | "list" | null>>;
  search: { text: string; cursor: number };
  editSearch: (fn: (text: string, cursor: number) => { text?: string; cursor: number }) => void;
  clearSearch: () => void;

  // ── list-view toggles ──
  setGlobalView: Dispatch<SetStateAction<boolean>>;
  setRepoFilterOn: Dispatch<SetStateAction<boolean>>;
  setGrouped: Dispatch<SetStateAction<boolean>>;
  setPrsGrouped: Dispatch<SetStateAction<boolean>>;
  setPrSort: Dispatch<SetStateAction<PrSort>>;
  setSessionSort: Dispatch<SetStateAction<SessionSort>>;

  // ── notices, activity, reload ──
  setNotice: Dispatch<SetStateAction<string | null>>;
  setActivity: Dispatch<SetStateAction<Map<string, Activity>>>;
  requested: MutableRefObject<Set<string>>;
  setRescanKey: Dispatch<SetStateAction<number>>;
  reload: () => void;

  // ── fresh-session flow ──
  enterFresh: (target: FreshTarget) => void;
  enterNewSession: () => void;
  enterOrchestrator: () => void;
  proceedFresh: (target: FreshTarget, agent: AgentSource) => void;
  reposForTarget: (target: FreshTarget) => RepoInfo[];
  chooseRepo: (target: FreshTarget, repo: RepoInfo, agent: AgentSource) => void;
  startFresh: (
    target: FreshTarget,
    repo: RepoInfo,
    name: string,
    worktree: boolean,
    agent: AgentSource,
    seed?: string,
  ) => void;
  open: (plan: OpenPlan) => void;
  openInBrowser: (target: { id: number; url: string }, label: string) => void;

  // ── clone flow ──
  canClone: boolean;
  beginClone: (target: FreshTarget, agent: AgentSource, raw: string) => void;
  cancelClone: () => void;
  setCloneNote: Dispatch<SetStateAction<string | null>>;
  cloneNoteRef: MutableRefObject<string | null>;

  // ── new-local-repo flow ──
  beginInitDir: (target: FreshTarget, agent: AgentSource, rawName: string) => void;
  beginInit: (mode: InitParentMode, rawParent: string) => void;

  // ── settings / pickers ──
  settingsItems: Array<"provider" | "identity" | "autoResume">;
  enterSettings: () => void;
  enterProvider: (fromSettings?: boolean) => void;
  enterIdentity: (fromSettings?: boolean) => void;
  applyProvider: (name: ProviderName, fallback: Mode) => void;
  setAutoResume: Dispatch<SetStateAction<boolean>>;
  persist: (next: { provider?: ProviderName; identity?: Identity | null; autoResume?: boolean }) => void;
  roster: TeamMember[];
  setIdentity: Dispatch<SetStateAction<Identity | null>>;

  // ── per-session actions ──
  continueInOtherAgent: (s: AgentSession) => void;
  enterProfilePicker: (s: AgentSession) => void;
  moveToProfile: (s: AgentSession, target: ClaudeProfile) => void;
};
