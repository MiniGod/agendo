import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { itemKey, prKey, type LoadedModel } from "../../model.ts";
import { sessionName } from "../../tmux.ts";
import type { PaneState } from "../format.ts";
import { V } from "../vocabState.ts";
import { ActionRow, ItemRow, PrRow, SessionRow, TaskRow } from "../components.tsx";
import {
  columnHeader, edgeLine, hintLine, identityLine, noticeLine, scopeLine, searchLine, viewTab, type SearchFocus,
} from "./listLines.tsx";
import type { Row, PrSort, SessionSort } from "../rows.ts";
import type { RepoInfo } from "../../repos.ts";
import type { View } from "../keys/context.ts";


/**
 * One row of the list. A plain function rather than a component so the rendered
 * element tree is byte-for-byte what it was when this was an inline `.map`
 * callback — turning it into a component would insert a new fibre per row and
 * change reconciliation on every scroll.
 */
function renderRow(
  row: Row,
  i: number,
  d: {
    cursor: number;
    searchFocus: "input" | "list" | null;
    model: LoadedModel;
    panes: Map<string, PaneState>;
    prSort: PrSort;
  },
): ReactElement {
      
      const selected = i === d.cursor && d.searchFocus !== "input";
      if (row.kind === "spacer") return <Text key={`s${i}`}> </Text>;
      if (row.kind === "header") {
        return (
          <Box key={`h${i}`}>
            <Text wrap="truncate" bold color="blue">{row.label}</Text>
            {row.sub ? <Text dimColor>{`  ${row.sub}`}</Text> : null}
          </Box>
        );
      }
      if (row.kind === "item") {
        return (
          <ItemRow key={`i${itemKey(row.item)}`} item={row.item} expanded={row.expanded} running={row.running} selected={selected} />
        );
      }
      if (row.kind === "pr") {
        return (
          <PrRow
            key={`p${prKey(row.pr)}`}
            pr={row.pr}
            expanded={row.expanded}
            running={row.running}
            selected={selected}
            contextCell={row.contextCell}
            sort={d.prSort}
          />
        );
      }
      if (row.kind === "session") {
        return (
          <SessionRow
            key={row.key}
            session={row.session}
            running={row.running}
            kind={row.running ? d.model.liveKinds.get(sessionName(row.session)) : undefined}
            pane={row.running ? d.panes.get(sessionName(row.session)) : undefined}
            expanded={row.expanded}
            selected={selected}
            timeField={row.timeField}
            open={row.open}
            showLink={row.showLink}
            placeholder={row.placeholder}
          />
        );
      }
      if (row.kind === "sessmeta") {
        return (
          <Box key={row.key} marginLeft={6}>
            <Text wrap="truncate" dimColor>
              <Text color="gray">{row.label.padEnd(8)}</Text>
              {row.value}
            </Text>
          </Box>
        );
      }
      if (row.kind === "sessprompt") {
        return (
          <Box key={row.key} marginLeft={6}>
            <Text wrap="truncate" dimColor>{`↳ "${row.prompt.replace(/\s+/g, " ")}"`}</Text>
          </Box>
        );
      }
      if (row.kind === "task") {
        return <TaskRow key={row.key} task={row.task} />;
      }
      if (row.kind === "action") {
        return <ActionRow key={row.key} action={row.action} />;
      }
      if (row.kind === "sessnote") {
        return (
          <Box key={row.key} marginLeft={6}>
            <Text dimColor italic>{row.text}</Text>
          </Box>
        );
      }
      if (row.kind === "newsess") {
        return (
          <Box key="newsess">
            <Text bold color={selected ? "black" : "green"} backgroundColor={selected ? "cyan" : undefined}>
              {"＋ new session"}
            </Text>
          </Box>
        );
      }
      if (row.kind === "fresh") {
        return (
          <Box key={row.key} marginLeft={4}>
            <Text color={selected ? "black" : "gray"} backgroundColor={selected ? "cyan" : undefined}>
              {"+ start a fresh session…"}
            </Text>
          </Box>
        );
      }
      // toggle section
      const caret = row.open ? "▾" : "▸";
      return (
        <Box key={`toggle:${row.id}`} marginLeft={row.indent ?? 0}>
          <Text wrap="truncate" color={selected ? "black" : "blue"} backgroundColor={selected ? "cyan" : undefined} bold>
            {`${caret} ${row.label} (${row.count})`}
            {row.sub ? <Text color={selected ? "black" : "gray"}>{`  ${row.sub}`}</Text> : null}
          </Text>
        </Box>
      );
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
