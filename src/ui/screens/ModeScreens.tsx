import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LoadedModel } from "../../model.ts";
import type { Identity, ProviderName } from "../../types.ts";
import type { RepoInfo } from "../../repos.ts";
import type { RepoUrl } from "../../clone.ts";
import type { FreshTarget } from "../targets.ts";
import type { Mode } from "../keys/context.ts";
import { AgentScreen } from "./AgentScreen.tsx";
import { BranchScreen } from "./BranchScreen.tsx";
import { CloneScreen } from "./CloneScreen.tsx";
import { CloningScreen } from "./CloningScreen.tsx";
import { IdentityScreen } from "./IdentityScreen.tsx";
import { OpenScreen } from "./OpenScreen.tsx";
import { ProfileScreen } from "./ProfileScreen.tsx";
import { ProviderScreen } from "./ProviderScreen.tsx";
import { WtChoiceScreen } from "./WtChoiceScreen.tsx";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { RepoScreen } from "./RepoScreen.tsx";

/**
 * The two screens App shows INSTEAD of anything else when the model failed to
 * load: the dead-end error, and the between-attempts wait. Returns null when
 * neither applies, so the caller falls through to its normal render.
 */
export function renderLoadState({
  error,
  retrying,
}: {
  error: string | null;
  retrying: { attempt: number; attempts: number; resumeAt: number; reason: string; waiting: boolean } | null;
}): ReactElement | null {
  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
        <Text dimColor>Press r to retry, q to quit.</Text>
      </Box>
    );
  }
  // Waiting between automatic attempts. Shows what failed and when the next try
  // lands, so an unattended launcher reads as busy rather than frozen — and `r`
  // still forces an immediate retry (it bumps reloadKey, cancelling this wait).
  if (retrying) {
    const secs = Math.max(0, Math.ceil((retrying.resumeAt - Date.now()) / 1000));
    const when = retrying.waiting ? `retrying in ${secs}s` : "retrying now";
    return (
      <Box flexDirection="column">
        <Text>
          <Text color="cyan">⟳</Text>{" "}
          {`Load failed — ${when} (attempt ${retrying.attempt + 1} of ${retrying.attempts})…`}
        </Text>
        <Text color="yellow" wrap="truncate">⚑ {retrying.reason}</Text>
        {/* Deliberately NOT "Press r to retry…" — that exact phrase is the
            dead-end error screen's marker, and sharing it would make the two
            screens indistinguishable to anything matching on text. */}
        <Text dimColor>Press r to try again now, q to quit.</Text>
      </Box>
    );
  }
  return null;
}

/**
 * The modal screen for the current `mode`, or null for `mode.kind === "list"` —
 * which is the caller's cue to render the list instead.
 *
 * A plain function returning JSX rather than a component, deliberately: it holds
 * no state and calls no hook, and keeping it out of the element tree means App's
 * reconciler behaviour is byte-for-byte what it was when this block was inline.
 */
export function renderMode({
  mode,
  model,
  identity,
  roster,
  settingsItems,
  providerLabel,
  provider,
  autoResume,
  available,
  authStatus,
  cloneNote,
  cloneUrl,
  resolved,
  filterRoot,
  canClone,
  anyHostableRepo,
  reposForTarget,
}: {
  mode: Mode;
  model: LoadedModel;
  identity: Identity | null;
  roster: Identity[];
  settingsItems: Array<"provider" | "identity" | "autoResume">;
  providerLabel: string;
  provider: ProviderName;
  autoResume: boolean;
  available: Set<ProviderName>;
  authStatus: Map<ProviderName, boolean | "checking">;
  cloneNote: string | null;
  cloneUrl: RepoUrl | null;
  resolved: { key: string; match: string | null; dest: string | null } | null;
  filterRoot: string | null;
  canClone: boolean;
  anyHostableRepo: boolean;
  reposForTarget: (t: FreshTarget) => RepoInfo[];
}): ReactElement | null {
  if (mode.kind === "agent") return <AgentScreen target={mode.target} cursor={mode.cursor} />;

  if (mode.kind === "repo") {
    return (
      <RepoScreen
        target={mode.target}
        cursor={mode.cursor}
        repoChoices={reposForTarget(mode.target)}
        anyHostableRepo={anyHostableRepo}
        canClone={canClone}
        filterRoot={filterRoot}
      />
    );
  }

  if (mode.kind === "clone") {
    return (
      <CloneScreen
        value={mode.value}
        cursor={mode.cursor}
        error={mode.error}
        cloneUrl={cloneUrl}
        resolved={resolved}
        filterRoot={filterRoot}
      />
    );
  }

  if (mode.kind === "cloning") {
    return <CloningScreen url={mode.url} dest={mode.dest} progress={mode.progress} elapsed={mode.elapsed} />;
  }

  if (mode.kind === "identity") {
    return <IdentityScreen cursor={mode.cursor} identity={identity} me={model.me} roster={roster} />;
  }

  if (mode.kind === "settings") {
    return (
      <SettingsScreen
        cursor={mode.cursor}
        settingsItems={settingsItems}
        providerLabel={providerLabel}
        identity={model.identity}
        meId={model.me.id}
        autoResume={autoResume}
        available={available}
        authStatus={authStatus}
      />
    );
  }

  if (mode.kind === "provider") {
    return <ProviderScreen cursor={mode.cursor} provider={provider} available={available} />;
  }

  if (mode.kind === "wtchoice") {
    return <WtChoiceScreen target={mode.target} repo={mode.repo} cursor={mode.cursor} cloneNote={cloneNote} />;
  }

  if (mode.kind === "branch") {
    return (
      <BranchScreen
        target={mode.target}
        agent={mode.agent}
        repo={mode.repo}
        value={mode.value}
        cursor={mode.cursor}
        worktree={mode.worktree}
        cloneNote={cloneNote}
      />
    );
  }

  if (mode.kind === "profile") {
    return <ProfileScreen title={mode.session.title} choices={mode.choices} cursor={mode.cursor} />;
  }

  if (mode.kind === "open") {
    return <OpenScreen targets={mode.targets} title={mode.title} />;
  }
  return null;
}
