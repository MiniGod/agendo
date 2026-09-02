import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, useApp, useInput } from "ink";
import { type LoadedModel } from "../model.ts";
import { loadActivity } from "../sessions.ts";
import { type OpenPlan } from "../launch.ts";
import { loadState, saveState } from "../config.ts";
import { discoverGitReposUnder, type RepoInfo } from "../repos.ts";
import { detectProviders, resolveInitialProvider, detectScopeProvider, PROVIDER_INFO } from "../provider.ts";
import { type Activity } from "./format.ts";
import { makeCloneActions } from "./cloneActions.ts";
import { makeInitActions } from "./initActions.ts";
import { makeSessionFlow } from "./sessionFlow.ts";
import { makeProfileActions } from "./profileActions.ts";
import { makeContinueInOtherAgent } from "./convertAgent.ts";
import {
  sessionId,
  type PrSort,
  type SessionSort,
} from "./rows.ts";
import { useActivityWatchers } from "./hooks/useActivityWatchers.ts";
import { useAuthProbe } from "./hooks/useAuthProbe.ts";
import { useCloneFlow } from "./hooks/useCloneFlow.ts";
import { useModelLoader } from "./hooks/useModelLoader.ts";
import { useReadinessPoll } from "./hooks/useReadinessPoll.ts";
import { useRepoScope } from "./hooks/useRepoScope.ts";
import { useViewport } from "./hooks/useViewport.ts";
import { useRowModel } from "./hooks/useRowModel.ts";
import { useSearch } from "./hooks/useSearch.ts";
import { useLocalRescan } from "./hooks/useLocalRescan.ts";
import type { KeyContext, Mode, View } from "./keys/context.ts";
import { handleAgentKeys } from "./keys/agent.ts";
import { handleBranchKeys } from "./keys/branch.ts";
import { handleCloneKeys, handleCloningKeys } from "./keys/clone.ts";
import { handleIdentityKeys } from "./keys/identity.ts";
import { handleInitKeys } from "./keys/init.ts";
import { handleListKeys } from "./keys/list.ts";
import { handleOpenKeys } from "./keys/open.ts";
import { handleProfileKeys } from "./keys/profile.ts";
import { handleProviderKeys } from "./keys/provider.ts";
import { handleQuitKeys } from "./keys/quit.ts";
import { handleRepoKeys } from "./keys/repo.ts";
import { handleWtchoiceKeys } from "./keys/wtchoice.ts";
import { handleSearchKeys } from "./keys/search.ts";
import { handleSettingsKeys } from "./keys/settings.ts";
import { ListScreen } from "./screens/ListScreen.tsx";
import { renderLoadState, renderMode } from "./screens/ModeScreens.tsx";
import type { AgentSession, Identity, ProviderName } from "../types.ts";


// ── main app ──────────────────────────────────────────────────────────────────
/**
 * `filterRoot` scopes the launcher to sessions under a path (null = the global
 * launcher, bare `agendo`). `hostSession` is the tmux host session the menu runs
 * in — passed to loadModel so restore snapshots the right session's tabs. The
 * `a` key toggles the runtime scoped↔global view (see `globalView`).
 */
export default function App({
  onOpen,
  filterRoot = null,
  hostSession,
}: {
  onOpen: (plan: OpenPlan) => void;
  filterRoot?: string | null;
  hostSession?: string;
}) {
  const { exit } = useApp();
  const [model, setModel] = useState<LoadedModel | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toggles, setToggles] = useState<Set<string>>(new Set());
  const [view, setView] = useState<View>("items");
  const [cursor, setCursor] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // Mirrors `notice` so the async load can tell whether a message landed while
  // it was in flight, without re-arming on every notice change.
  const noticeRef = useRef<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  // Repos cloned during this run, merged into the picker until a reload
  // discovers them for real (see `scopedRepos`).
  const [cloned, setCloned] = useState<RepoInfo[]>([]);
  const [grouped, setGrouped] = useState(true); // Sessions view: group by repo
  // Path-scope toggle: when a filterRoot exists, `a` flips between the scoped
  // view (sessions under the root) and the global view (every session). Bare
  // `agendo` has no root, so it's always effectively global.
  const [globalView, setGlobalView] = useState(false);
  // Repo-scope toggle: with a filterRoot, `f` flips whether the work-item and PR
  // views are narrowed to the repos found inside it. On by default when scoped
  // (that's what asking for a path means); not persisted, like globalView.
  const [repoFilterOn, setRepoFilterOn] = useState<boolean>(!!filterRoot);
  const [prsGrouped, setPrsGrouped] = useState(false); // PRs view: repo subgroups
  const [prSort, setPrSort] = useState<PrSort>("created"); // PRs view: sort order
  const [sessionSort, setSessionSort] = useState<SessionSort>("updated"); // Sessions view: sort order
  const { searchFocus, setSearchFocus, search, clearSearch, editSearch } = useSearch();
  const [activity, setActivity] = useState<Map<string, Activity>>(new Map());
  // Auto-resume a session once its usage-limit window reopens (default OFF,
  // toggled on the Settings page). Persisted in LauncherState.
  const [autoResume, setAutoResume] = useState<boolean>(() => loadState().autoResumeOnUsageLimit ?? false);
  // Which backend the launcher talks to. Resolved from the persisted choice if
  // its CLI is still installed, else the first installed one (see provider.ts).
  // `available` is probed once at mount and drives the provider picker.
  const [available] = useState<Set<ProviderName>>(() => detectProviders());
  // The git repos inside the path context, found by walking it downward (the
  // target itself when it's a checkout, else every repo nested under it). It
  // picks the backend, widens the fetch scope and yields the model's repoScope,
  // so it must NOT depend on the `f` toggle — that stays a pure display filter.
  // Scanned once per root and process-cached; `r` bumps `rescanKey` to walk the
  // tree again, so a repo cloned into the target after launch joins the scope
  // (the background poll keeps the cached result — only an explicit refresh pays
  // for a rescan).
  const [rescanKey, setRescanKey] = useState(0);
  const discoveredRepos = useMemo<RepoInfo[]>(
    () => (filterRoot ? discoverGitReposUnder(filterRoot, rescanKey > 0) : []),
    [filterRoot, rescanKey],
  );
  // When scoped to a path context, the tracker its git remote points at — or the
  // remotes of the repos inside it, when the target is a plain parent folder —
  // forces that backend, overriding the persisted default (which may be the other
  // one, and would then filter against repo keys it can never match). Bare
  // launchers (no filterRoot) never force — they keep the persisted choice.
  const [provider, setProvider] = useState<ProviderName>(() =>
    resolveInitialProvider(
      loadState().provider,
      filterRoot ? detectScopeProvider(filterRoot, discoveredRepos) : null,
    ),
  );
  // Persisted "who am I / filter" state (Work items & PRs views only).
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const s = loadState();
    return s.identityId
      ? { id: s.identityId, displayName: s.identityName ?? "?", uniqueName: s.identityUniqueName ?? "" }
      : null;
  });

  const { error, retrying, reload } = useModelLoader({
    provider,
    identity,
    hostSession,
    discoveredRepos,
    setModel,
    setNotice,
    noticeRef,
  });

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    noticeRef.current = notice;
  }, [notice]);

  const authStatus = useAuthProbe({ mode, available });

  const persist = (next: { provider?: ProviderName; identity?: Identity | null; autoResume?: boolean }) => {
    const p = next.provider !== undefined ? next.provider : provider;
    const id = next.identity !== undefined ? next.identity : identity;
    const ar = next.autoResume !== undefined ? next.autoResume : autoResume;
    saveState({
      provider: p,
      identityId: id?.id,
      identityName: id?.displayName,
      identityUniqueName: id?.uniqueName,
      autoResumeOnUsageLimit: ar,
    });
  };

  // Lazily parse a session's recent activity the first time it's expanded, then
  // cache it (keyed by session identity). A ref dedupes in-flight requests so
  // it's safe to call on every expand/collapse — it fetches each session once.
  const requested = useRef<Set<string>>(new Set());
  // Mirror `model` into a ref so the mount-only liveness interval reads the
  // current sessions without a stale closure and without re-arming the timer.
  const modelRef = useRef<LoadedModel | null>(null);
  // Same, for the path context's repos — an `r` rescan can replace them.
  const discoveredReposRef = useRef(discoveredRepos);
  useEffect(() => { discoveredReposRef.current = discoveredRepos; }, [discoveredRepos]);
  const ensureActivity = (s: AgentSession) => {
    const id = sessionId(s);
    if (requested.current.has(id)) return;
    requested.current.add(id);
    setActivity((p) => new Map(p).set(id, "loading"));
    loadActivity(s)
      .then((a) => setActivity((p) => new Map(p).set(id, a)))
      .catch(() => setActivity((p) => new Map(p).set(id, "error")));
  };

  // The actionable rows of the Settings page, in display order. Kept in one
  // place so the input handler (cursor / enter) and the renderer stay in lockstep.
  const settingsItems: Array<"provider" | "identity" | "autoResume"> = ["provider", "identity", "autoResume"];
  const providerLabel = PROVIDER_INFO.find((p) => p.name === provider)?.label ?? provider;

  const { scoped, inScope, scopedRepos, reposForTarget, anyHostableRepo } = useRepoScope({
    model,
    filterRoot,
    globalView,
    cloned,
  });

  // The clone step's state, plus the cloning screen's elapsed-seconds ticker —
  // both in ./hooks/useCloneFlow.ts, called from the line the ticker occupied.
  const { cloneNote, setCloneNote, cloneNoteRef, cloneRun, cloneUrl, resolved } = useCloneFlow({
    mode,
    filterRoot,
    setMode,
  });

  const { rows, selectableIdx, roster } = useRowModel({
    model,
    repoFilterOn,
    view,
    expanded,
    toggles,
    grouped,
    prsGrouped,
    prSort,
    sessionSort,
    activity,
    search,
    inScope,
  });

  useEffect(() => {
    if (selectableIdx.length === 0) return;
    if (!selectableIdx.includes(cursor)) setCursor(selectableIdx[0]);
  }, [selectableIdx, cursor]);

  useActivityWatchers({ rows, setActivity });

  // Background LOCAL rescan on a timer; see ./hooks/useLocalRescan.ts.
  useLocalRescan({ modelRef, discoveredReposRef, setModel });

  const panes = useReadinessPoll({ model, autoResume });

  const { scrollTop, visible, moreAbove, moreBelow } = useViewport({
    rows,
    cursor,
    view,
    searchFocus,
    filterRoot,
  });

  const move = (dir: 1 | -1) => {
    if (selectableIdx.length === 0) return;
    const pos = selectableIdx.indexOf(cursor);
    setCursor(selectableIdx[(pos + dir + selectableIdx.length) % selectableIdx.length]);
  };

  const toggleExpand = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleSection = (id: string) =>
    setToggles((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const switchView = (v: View) => {
    setView(v);
    setCursor(0);
    clearSearch();
  };

  // Open the Settings page (backend, identity, filters, auth status).
  const enterSettings = () => {
    setNotice(null);
    setMode({ kind: "settings", cursor: 0 });
  };

  // Open the backend picker (Azure DevOps ↔ GitHub), cursor on the current one.
  const enterProvider = (fromSettings = false) => {
    setNotice(null);
    const idx = Math.max(0, PROVIDER_INFO.findIndex((p) => p.name === provider));
    setMode({ kind: "provider", cursor: idx, fromSettings });
  };

  // Open the identity picker, cursor on the current identity.
  const enterIdentity = (fromSettings = false) => {
    if (!model) return;
    const curId = (identity ?? model.me).id;
    const idx = Math.max(0, roster.findIndex((m) => m.id === curId));
    setMode({ kind: "identity", cursor: idx, fromSettings });
  };

  // Switch backend — only to an installed one. Clears the (provider-specific)
  // identity override so the new backend's own "me" is used, resets scroll/search,
  // and persists the choice. Picking an uninstalled backend just surfaces its
  // auth hint (back on `fallback`); picking the current one is a no-op. A real
  // switch always lands on the list so you see the new backend's data reload.
  const applyProvider = (name: ProviderName, fallback: Mode) => {
    const info = PROVIDER_INFO.find((p) => p.name === name);
    if (!available.has(name)) {
      setMode(fallback);
      setNotice(`${info?.label ?? name} unavailable — ${info?.authHint ?? "CLI not installed"}`);
      return;
    }
    if (name === provider) {
      setMode(fallback);
      return;
    }
    setProvider(name);
    setIdentity(null); // ADO identity ids are meaningless on GitHub and vice-versa
    persist({ provider: name, identity: null });
    setCursor(0);
    clearSearch();
    setMode({ kind: "list" });
  };

  // ── starting a session ──────────────────────────────────────────────────────
  // Agent pick → repo pick → worktree/checkout routing → launch, all in
  // ./sessionFlow.ts. Built here, at the line the block occupied, because the
  // clone and convert handlers below close over `open` and `chooseRepo`.
  const {
    enterFresh, enterNewSession, enterOrchestrator, enterGlobalOrchestrator,
    proceedFresh, open, startFresh, openInBrowser, chooseRepo,
  } = makeSessionFlow({
    model, scopedRepos, filterRoot, hostSession, cloneNoteRef, onOpen, exit, reload,
    setMode, setNotice, setBusy, setCloneNote,
  });

  // ── clone a repo that isn't on disk yet ──
  // The handlers live in ./cloneActions.ts; the state they drive lives in the
  // useCloneFlow hook above. Built here, at the line the block occupied, because
  // they close over `open` and `chooseRepo` — both defined above this point.
  const { canClone, beginClone, cancelClone } = makeCloneActions({
    scoped, filterRoot, cloneRun, cloneNoteRef, setMode, setNotice, setCloned, setCloneNote, chooseRepo,
  });
  // …or create one that exists nowhere yet — ./initActions.ts, same shape.
  const { beginInitDir, beginInit } = makeInitActions({
    model, cloned, scoped, filterRoot, setMode, setNotice, setCloned, setCloneNote, cloneNoteRef, chooseRepo,
  });

  const continueInOtherAgent = makeContinueInOtherAgent({ open, setMode, setNotice, setBusy });

  // ── move a session to another Claude profile ────────────────────────────────
  // Picker guards and the move itself live in ./profileActions.ts. `moveInFlight`
  // stays a ref HERE so App's hook order is untouched; see that module's header.
  const moveInFlight = useRef(false);
  const { enterProfilePicker, moveToProfile } = makeProfileActions({
    model, modelRef, moveInFlight, requested, hostSession, reload,
    setMode, setNotice, setBusy, setActivity,
  });

  // Everything the ./keys handlers read or drive, rebuilt each render so they
  // always see this pass's state. Each handler narrows it to a `Pick` of the
  // members it actually touches, so a module's signature documents its reach.
  const ctx: KeyContext = {
    exit, model, filterRoot,
    mode, setMode, view, switchView, cursor, setCursor, rows, selectableIdx, move,
    toggleExpand, toggleSection, ensureActivity,
    searchFocus, setSearchFocus, search, editSearch, clearSearch,
    setGlobalView, setRepoFilterOn, setGrouped, setPrsGrouped, setPrSort, setSessionSort,
    setNotice, setActivity, requested, setRescanKey, reload,
    enterFresh, enterNewSession, enterOrchestrator, enterGlobalOrchestrator, proceedFresh, reposForTarget,
    chooseRepo, startFresh, open, openInBrowser,
    canClone, beginClone, cancelClone, setCloneNote, cloneNoteRef, beginInitDir, beginInit,
    settingsItems, enterSettings, enterProvider, enterIdentity, applyProvider,
    setAutoResume, persist, roster, setIdentity,
    continueInOtherAgent, enterProfilePicker, moveToProfile,
  };

  useInput((input, key) => {
    if (handleOpenKeys(input, key, ctx)) return;
    if (handleSearchKeys(input, key, ctx)) return;

    if (handleQuitKeys(input, key, ctx)) return;

    if (handleAgentKeys(input, key, ctx)) return;

    if (handleRepoKeys(input, key, ctx)) return;

    if (handleCloneKeys(input, key, ctx)) return;
    if (handleCloningKeys(input, key, ctx)) return;
    if (handleInitKeys(input, key, ctx)) return;

    if (handleWtchoiceKeys(input, key, ctx)) return;

    if (handleBranchKeys(input, key, ctx)) return;

    if (handleSettingsKeys(input, key, ctx)) return;

    if (handleProviderKeys(input, key, ctx)) return;

    if (handleIdentityKeys(input, key, ctx)) return;

    if (handleProfileKeys(input, key, ctx)) return;

    handleListKeys(input, key, ctx); // last link: nothing left to guard
  });

  // ── render ──
  // Every overlay screen lives in ./screens/ModeScreens.tsx as a plain function
  // returning JSX rather than a component, so App's element tree — and with it
  // the reconciler's behaviour — is exactly what it was when this was inline.
  const loadScreen = renderLoadState({ error, retrying });
  if (loadScreen) return loadScreen;
  if (!model) return <Text><Text color="cyan">⟳</Text> Loading work items, PRs & sessions…</Text>;
  if (busy) return <Text><Text color="cyan">⟳</Text> {busy}</Text>;

  const modal = renderMode({
    mode, model, identity, roster, settingsItems, providerLabel, provider, autoResume,
    available, authStatus, cloneNote, cloneUrl, resolved, filterRoot, canClone,
    anyHostableRepo, reposForTarget,
  });
  if (modal) return modal;

  // list view — ./screens/ListScreen.tsx. Presentational only: it renders the
  // row model `useRowModel` built and the window `useViewport` sliced.
  return (
    <ListScreen
      model={model}
      view={view}
      providerLabel={providerLabel}
      filterRoot={filterRoot}
      scoped={scoped}
      hostSession={hostSession}
      discoveredRepos={discoveredRepos}
      repoFilterOn={repoFilterOn}
      searchFocus={searchFocus}
      search={search}
      grouped={grouped}
      prsGrouped={prsGrouped}
      prSort={prSort}
      sessionSort={sessionSort}
      visible={visible}
      scrollTop={scrollTop}
      cursor={cursor}
      moreAbove={moreAbove}
      moreBelow={moreBelow}
      notice={notice}
      panes={panes}
    />
  );
}
