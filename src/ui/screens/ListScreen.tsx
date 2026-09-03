import { Box, Text } from "ink";
import type { LoadedModel } from "../../model.ts";
import type { PaneState } from "../format.ts";
import { V } from "../vocabState.ts";
import {
  columnHeader, edgeLine, hintLine, identityLine, noticeLine, scopeLine, searchLine, viewTab, type SearchFocus,
} from "./listLines.tsx";
import { renderRow } from "./listRows.tsx";
import type { Row, PrSort, SessionSort } from "../rows.ts";
import type { RepoInfo } from "../../repos.ts";
import type { View } from "../keys/context.ts";

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
}) {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agendo </Text>
        <Text color="cyan">{`[${providerLabel}]  `}</Text>
        {viewTab(view, "items", `1 ${V.itemsTab}`)}
        <Text> </Text>
        {viewTab(view, "prs", "2 PRs")}
        <Text> </Text>
        {viewTab(view, "sessions", "3 Sessions")}
      </Box>
      {scopeLine({ filterRoot, scoped, hostSession, discoveredRepos, repoFilterOn })}
      {hintLine(searchFocus, view, { grouped, prsGrouped, prSort, sessionSort })}
      {searchLine(searchFocus, search)}
      {identityLine(view, model)}
      {columnHeader(view, prSort)}
      {edgeLine(moreAbove, "↑")}

      {visible.map((row, li) => {
        const i = scrollTop + li;
        return renderRow(row, i, { cursor, searchFocus, model, panes, prSort });
      })}

      {edgeLine(moreBelow, "↓")}
      {noticeLine(notice)}
    </Box>
  );
}
