import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { itemKey, prKey, type LoadedModel } from "../../model.ts";
import { sessionName } from "../../tmux.ts";
import { homeShort, type PaneState } from "../format.ts";
import { V } from "../vocabState.ts";
import {
  ActionRow,
  ColumnHeader,
  HEADERS_ITEMS,
  CaretText,
  ITEM_WIDTHS,
  ItemRow,
  PR_WIDTHS,
  PrRow,
  prHeaders,
  SessionRow,
  TaskRow,
} from "../components.tsx";
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
  searchFocus: "input" | "list" | null;
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
  const tab = (v: View, label: string) => (
    <Text
      bold={view === v}
      backgroundColor={view === v ? "cyan" : undefined}
      color={view === v ? "black" : undefined}
      dimColor={view !== v}
    >
      {` ${label} `}
    </Text>
  );
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>agendo </Text>
        <Text color="cyan">{`[${providerLabel}]  `}</Text>
        {tab("items", `1 ${V.itemsTab}`)}
        <Text> </Text>
        {tab("prs", "2 PRs")}
        <Text> </Text>
        {tab("sessions", "3 Sessions")}
      </Box>
      {filterRoot ? (
        <Box>
          <Text wrap="truncate">
            <Text color={scoped ? "green" : "yellow"}>
              {scoped ? `⊙ ${hostSession}: ${homeShort(filterRoot)}` : "⊙ global — all paths"}
            </Text>
            <Text dimColor>{`  · a ${scoped ? "show all" : `rescope to ${hostSession}`}`}</Text>
            {/* The repo filter's own state + key hint, next to the path scope's
                so both toggles are discoverable in the same place. */}
            <Text dimColor>
              {discoveredRepos.length === 0
                ? `  · f repo filter: no repos found here`
                : `  · f repo filter: ${repoFilterOn ? `on (${discoveredRepos.length} repo${discoveredRepos.length > 1 ? "s" : ""})` : "off"}`}
            </Text>
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text wrap="truncate" dimColor>
          {searchFocus === "input"
            ? `type to filter · ←/→ caret · ⌫ delete · ⌃w del word · ↓ results · enter ${view === "sessions" ? "resume" : "open"} · esc cancel`
            : searchFocus === "list"
              ? `↑/↓ move · ↑ at top edits search · → expand · / edit · enter ${view === "sessions" ? "resume" : "open"} · o browser · esc cancel`
              : view === "sessions"
                // `⇥ view` (not "switch view") matches the PRs hint and buys back
                // 7 columns for the coordinator and `m →profile` entries — this
                // line already truncated at ~120 cols before any of them, so tail
                // hints are at a premium. `O orch · G global` spends 3 of those 7
                // to name BOTH coordinator levels where one used to be spelled out
                // as `O orchestrator`, in the same words the `kind` column of
                // `agendo list` prints for those sessions.
                ? `↑/↓ move · → expand · ⇥ view · g ${grouped ? "ungroup" : "group"} · s sort: ${sessionSort} · / search · n new · O orch · G global · enter resume · c →other agent · m →profile · o browser · , settings · r refresh · q/esc quit`
                : view === "prs"
                  ? `↑/↓ move · → expand · ⇥ view · g ${prsGrouped ? "ungroup" : "group"} · s sort: ${prSort === "created" ? "created" : "updated"} · / search · enter open · o browser · , settings · r refresh · q/esc quit`
                  : "↑/↓ move · →/← expand · ⇥ switch view · / search · enter open/expand · o browser · , settings · r refresh · q/esc quit"}
        </Text>
      </Box>
      {searchFocus ? (
        <Box>
          <Text wrap="truncate">
            <Text color={searchFocus === "input" ? "cyan" : "gray"}>{"search "}</Text>
            {searchFocus === "input" ? (
              <Text>
                <CaretText value={search.text} cursor={search.cursor} />
              </Text>
            ) : (
              <Text dimColor>{search.text}</Text>
            )}
          </Text>
        </Box>
      ) : null}
      {view !== "sessions" ? (
        <Box>
          <Text wrap="truncate">
            <Text color="magenta">{"as "}</Text>
            <Text bold>
              {model.identity.displayName}
              {model.identity.id === model.me.id ? " (you)" : ""}
            </Text>
          </Text>
        </Box>
      ) : null}
      {view !== "sessions" ? (
        <ColumnHeader
          headers={view === "prs" ? prHeaders(prSort) : HEADERS_ITEMS}
          widths={view === "prs" ? PR_WIDTHS : ITEM_WIDTHS}
        />
      ) : null}
      <Text dimColor>{moreAbove > 0 ? `  ↑ ${moreAbove} more` : " "}</Text>

      {visible.map((row, li) => {
        const i = scrollTop + li;
        return renderRow(row, i, { cursor, searchFocus, model, panes, prSort });
      })}

      <Text dimColor>{moreBelow > 0 ? `  ↓ ${moreBelow} more` : " "}</Text>
      {notice ? (
        <Box>
          <Text color="yellow">⚑ {notice}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
