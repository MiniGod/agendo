import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LoadedModel } from "../../app/model/index.ts";
import type { PaneState } from "../format/index.ts";
import { V } from "../models/vocabState.ts";
import {
  columnHeader, edgeLine, hintLine, identityLine, noticeLine, scopeLine, searchLine, viewTab, type SearchFocus,
} from "./listLines.tsx";
import { renderRow } from "./listRows.tsx";
import type { Row, PrSort, SessionSort } from "../models/rows.ts";
import type { RepoInfo } from "../../repositories/index.ts";
import type { View } from "../keys/context.ts";
import {
  loadMarker,
  sliceForView,
  type ModelLoadState,
  type RetryState,
  type SliceLoadState,
} from "../models/loadState.ts";

function dataName(view: View): string {
  return view === "items" ? V.itemsTab.toLowerCase() : "PRs";
}

function retryLabel(retrying: RetryState): string {
  const secs = Math.max(0, Math.ceil((retrying.resumeAt - Date.now()) / 1000));
  const when = retrying.waiting ? `retrying in ${secs}s` : "retrying now";
  return `Load failed — ${when} (attempt ${retrying.attempt + 1} of ${retrying.attempts})…`;
}

function blockingLoad(view: View, state: SliceLoadState | null, retrying: RetryState | null): ReactElement | null {
  if (!state || (state.phase !== "loading" && state.phase !== "error")) return null;
  if (state.phase === "error") {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {state.error}</Text>
        <Text dimColor>Press r to retry, q to quit.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="cyan">⟳</Text>{" "}
        {retrying ? retryLabel(retrying) : `Loading ${dataName(view)}…`}
      </Text>
      {retrying ? <Text color="yellow" wrap="truncate">⚑ {retrying.reason}</Text> : null}
      {retrying ? <Text dimColor>Press r to try again now, q to quit.</Text> : null}
    </Box>
  );
}

function refreshLine(view: View, state: SliceLoadState | null, retrying: RetryState | null): ReactElement | null {
  if (!state || state.phase === "ready") return null;
  if (state.phase === "refreshing") {
    const text = retrying
      ? `${retryLabel(retrying)} — ${retrying.reason}`
      : `Refreshing ${dataName(view)} in the background…`;
    return <Text color={retrying ? "yellow" : "cyan"}>⟳ {text}</Text>;
  }
  if (state.phase === "stale-error") {
    return <Text color="yellow">⚑ Refresh failed: {state.error} · Press r to retry.</Text>;
  }
  return null;
}

/**
 * The main list — the screen the launcher spends nearly all its time on.
 *
 * Purely presentational: it renders the row model `useRowModel` built and the
 * viewport `useViewport` sliced, and holds no state of its own. It takes a wide
 * prop list because a list view genuinely has that many inputs, not because
 * anything was left half-extracted; every prop below is read at least once here
 * and nowhere else in App.
 */
export function ListScreen({
  model,
  view,
  providerLabel,
  filterRoot,
  scoped,
  hostSession,
  discoveredRepos,
  repoFilterOn,
  searchFocus,
  search,
  grouped,
  prsGrouped,
  prSort,
  sessionSort,
  visible,
  scrollTop,
  cursor,
  moreAbove,
  moreBelow,
  notice,
  panes,
  loadState,
  retrying,
}: {
  model: LoadedModel;
  view: View;
  providerLabel: string;
  filterRoot: string | null;
  scoped: boolean;
  hostSession?: string;
  discoveredRepos: RepoInfo[];
  repoFilterOn: boolean;
  searchFocus: SearchFocus;
  search: { text: string; cursor: number };
  grouped: boolean;
  prsGrouped: boolean;
  prSort: PrSort;
  sessionSort: SessionSort;
  visible: Row[];
  scrollTop: number;
  cursor: number;
  moreAbove: number;
  moreBelow: number;
  notice: string | null;
  panes: Map<string, PaneState>;
  loadState: ModelLoadState;
  retrying: RetryState | null;
}) {
  const slice = sliceForView(loadState, view);
  const blocked = blockingLoad(view, slice, retrying);
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agendo </Text>
        <Text color="cyan">{`[${providerLabel}]  `}</Text>
        {viewTab(view, "items", `1 ${V.itemsTab}${loadMarker(loadState.items)}`)}
        <Text> </Text>
        {viewTab(view, "prs", `2 PRs${loadMarker(loadState.prs)}`)}
        <Text> </Text>
        {viewTab(view, "sessions", "3 Sessions")}
      </Box>
      {scopeLine({ filterRoot, scoped, hostSession, discoveredRepos, repoFilterOn })}
      {hintLine(searchFocus, view, { grouped, prsGrouped, prSort, sessionSort })}
      {searchLine(searchFocus, search)}
      {blocked ?? (
        <>
          {identityLine(view, model)}
          {columnHeader(view, prSort)}
          {edgeLine(moreAbove, "↑")}

          {visible.map((row, li) => {
            const i = scrollTop + li;
            return renderRow(row, i, { cursor, searchFocus, model, panes, prSort });
          })}

          {edgeLine(moreBelow, "↓")}
          {refreshLine(view, slice, retrying)}
          {noticeLine(notice)}
        </>
      )}
    </Box>
  );
}
