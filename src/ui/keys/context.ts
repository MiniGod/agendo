import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import type { OpenPlan } from "../../launch/index.ts";
import type { ClaudeProfile, ProfileChoice } from "../../sessions/profiles/index.ts";
import type { RepoInfo } from "../../repositories/index.ts";
import type { RepoUrl } from "../../repositories/clone/index.ts";
import type { AgentSession, AgentSource, Identity, ProviderName, TeamMember } from "../../shared/types.ts";
import type { Activity } from "../format/index.ts";
import type { FreshTarget, OpenTargets } from "../models/targets.ts";
import type { PrSort, Row, SessionSort } from "../models/rows.ts";
import type { OrchestratorPins } from "../models/orchestratorPins.ts";
import type { Skipped } from "../actions/staleKill.ts";
import type { Config } from "../../app/config.ts";
import type { ConfigPatch } from "../../app/configSave.ts";
import type { SettingsItem, TextField } from "../models/configFields.ts";

// ── top-level views & fresh-session flow state ────────────────────────────────
export type View = "items" | "prs" | "sessions";

export type Mode =
  | { kind: "list" }
  // `note` is the outcome of the last save made from the page (or its editors),
  // or why opening it kept the last good read; shown under the rows until the
  // page is left.
  | { kind: "settings"; cursor: number; note?: { text: string; error?: boolean } }
  // Typing a config.json value (src/ui/keys/settingsEdit.ts). `error` is why the
  // last enter didn't save — a validation message, or the save's own failure.
  | { kind: "settingsEdit"; field: TextField; value: string; cursor: number; error?: string }
  // The team picker: the signed-in user's own teams in the project (null while
  // they load), then a row for typing a name instead. `request` names the list
  // request this picker is waiting on, so an earlier picker's late answer is
  // dropped rather than shown here.
  | { kind: "teamPicker"; cursor: number; teams: string[] | null; request: number; error?: string }
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
  | { kind: "open"; targets: OpenTargets; title: string }
  // "kill this session?" — the y/n the list's `x` / `X` put up before ending it
  // (src/ui/actions/sessionEnd.ts). `prompt` says what is, or is not, in flight;
  // `waived` is every refusal it names, all a `y` to `X` may force past.
  | { kind: "confirmEnd"; session: AgentSession; force: boolean; prompt: string; waived: readonly string[] }
  // The same y/n for the Sessions view's `K` (src/ui/actions/staleKill.ts):
  // every extra orchestrator that passed `x`'s guards, and the ones that did
  // not, named with why. `root` is the repo, read again on `y` for its primary;
  // `lookAlikes` that it has none, so what is killed is named as look-alikes.
  | { kind: "confirmEndStale"; root: string; lookAlikes: boolean; sessions: readonly AgentSession[]; prompt: string; skipped: readonly Skipped[] }
  // The cleanup view (C). It keeps its own state and keys (CleanupScreen.tsx).
  | { kind: "cleanup" };

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
  /** The pinned orchestrator block, whole (not cut to the terminal) — what `K` kills comes from it. */
  pins: OrchestratorPins | null;

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
  enterGlobalOrchestrator: () => void;
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
  settingsItems: readonly SettingsItem[];
  /** config.json as last loaded — what the config rows show and the editors open with. */
  config: Config;
  /** Save to config.json; the error to show, or null once saved (and, when it
   *  re-points the backend, the model reloading). */
  saveConfigPatch: (patch: ConfigPatch) => string | null;
  /** Open the team picker, its cursor on `current` once the teams arrive. */
  enterTeamPicker: (current: string) => void;
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
